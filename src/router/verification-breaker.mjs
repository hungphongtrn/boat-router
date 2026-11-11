// Failure windows and admission latches are scoped to the machine size.
export const BREAKER_WINDOW_MS = 15 * 60_000;
export const BREAKER_PROBE_DELAY_MS = 10 * 60_000;

export function breakerCanProbe(breaker, now) {
  return breaker?.tripped === true && Number.isFinite(breaker.trippedAt) &&
    now >= breaker.trippedAt + BREAKER_PROBE_DELAY_MS && !breaker.probe;
}

// Older deployed latches do not have an opening time. Start their delay when
// first observed instead of treating them as already eligible for probes.
export async function currentBreaker(storage, now) {
  return storage.transaction(async tx => {
    const breaker = await tx.get('verification:breaker');
    if (!breaker?.tripped || Number.isFinite(breaker.trippedAt)) return breaker;
    const migrated = { ...breaker, trippedAt: now, probe: null };
    await tx.put('verification:breaker', migrated);
    return migrated;
  });
}

// Only one create may be in the half-open state. The claim is retained for an
// uncertain provider response until the existing create ledger resolves it.
export async function reserveBreakerProbe(storage, createKey, now) {
  return storage.transaction(async tx => {
    const breaker = await tx.get('verification:breaker');
    if (!breaker?.tripped) return true;
    if (breaker.probe?.createKey === createKey) return true;
    if (!breakerCanProbe(breaker, now)) return false;
    await tx.put('verification:breaker', { ...breaker, probe: { createKey, at: now } });
    return true;
  });
}

export async function releaseBreakerProbe(storage, createKey) {
  return storage.transaction(async tx => {
    const breaker = await tx.get('verification:breaker');
    if (breaker?.probe?.createKey !== createKey) return false;
    await tx.put('verification:breaker', { ...breaker, probe: null });
    return true;
  });
}

// Called within the same transaction that deduplicates the verification event.
// An old success may not cancel a newer failure, including after a restart.
export async function recordBreakerOutcome(tx, { box, ok, at, now, threshold = 3 }) {
  const size = box.size, key = `verification:window:${size}`;
  const breaker = await tx.get('verification:breaker') ?? { counts: {}, tripped: false };
  const lastFailure = await tx.get(`verification:last-failure:${size}`);
  let window = await tx.get(key);
  const epoch = breaker.epoch ?? 'legacy';
  if (window && (window.epoch ?? 'legacy') !== epoch) window = { successesAt: null, failures: [] };
  if (!window) {
    // Preserve recent legacy failures conservatively while migrating.
    const count = breaker.counts?.[size] ?? 0;
    window = { successesAt: null, failures: count > 0 && Number.isFinite(lastFailure) && lastFailure >= now - BREAKER_WINDOW_MS ? Array(Math.min(count, 100)).fill(lastFailure) : [] };
  }
  const eventAt = Number.isFinite(at) ? at : now;
  let successesAt = Number.isFinite(window.successesAt) ? window.successesAt : -Infinity;
  let failures = (Array.isArray(window.failures) ? window.failures : []).filter(t => Number.isFinite(t) && t >= now - BREAKER_WINDOW_MS);
  if (ok) successesAt = Math.max(successesAt, eventAt);
  else {
    await tx.put(`verification:last-failure:${size}`, Math.max(Number.isFinite(lastFailure) ? lastFailure : -Infinity, eventAt));
    if (eventAt >= now - BREAKER_WINDOW_MS) failures.push(eventAt);
  }
  failures = failures.filter(t => t >= successesAt).sort((a, b) => a - b).slice(-100);
  await tx.put(key, { epoch, successesAt: Number.isFinite(successesAt) ? successesAt : null, failures });
  const count = failures.length;
  const limit = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 3;
  const probe = breaker.tripped && breaker.probe?.createKey && breaker.probe.createKey === box.createKey;
  const cleared = Boolean(probe && ok && eventAt >= breaker.probe.at);
  const opened = !breaker.tripped && count >= limit;
  const failedProbe = Boolean(probe && !ok && eventAt >= breaker.probe.at);
  const next = { ...breaker, counts: { ...breaker.counts, [size]: count }, tripped: cleared ? false : breaker.tripped || opened };
  if (cleared) { next.trippedAt = null; next.probe = null; next.counts = {}; next.epoch = `recovered:${now}:${box.createKey}`; }
  else if (opened || failedProbe) { next.trippedAt = now; next.probe = null; }
  else if (next.tripped && !Number.isFinite(next.trippedAt)) next.trippedAt = now;
  await tx.put('verification:breaker', next);
  return { opened, cleared, failedProbe, breaker: next };
}

// Keep the public aggregate for operators. Admission uses only the affected
// machine size. A legacy latch with no size evidence remains conservative.
function scopedState(root, size) {
  if (root?.bySize) return (root.bySize['*']?.tripped ? root.bySize['*'] : root.bySize[size]) ?? { counts: {}, tripped: false, epoch: root.epoch };
  const counts = root?.counts ?? {};
  const known = Object.entries(counts).filter(([, count]) => count > 0).map(([name]) => name);
  const affected = root?.tripped && (!known.length || known.includes(size));
  return { ...root, counts: { [size]: counts[size] ?? 0 }, tripped: Boolean(affected), probe: affected ? root.probe ?? null : null };
}
export function breakerForSize(root, size) { return scopedState(root, size); }
function scopedRoot(root, size, next) {
  const current = root ?? { counts: {}, tripped: false };
  let bySize = current.bySize;
  if (!bySize) {
    bySize = {};
    const known = Object.entries(current.counts ?? {}).filter(([, count]) => count > 0).map(([name]) => name);
    for (const name of known) bySize[name] = scopedState(current, name);
    if (current.tripped && !known.length) for (const name of ['small', 'default', 'large', 'xlarge']) bySize[name] = { ...current, counts: {}, probe: current.probe ?? null };
  }
  bySize = { ...bySize, [size]: next };
  const open = Object.values(bySize).filter(value => value?.tripped);
  return { ...current, bySize, counts: { ...current.counts, [size]: next.counts?.[size] ?? 0 }, tripped: open.length > 0,
    trippedAt: open.length ? Math.min(...open.map(value => Number.isFinite(value.trippedAt) ? value.trippedAt : Infinity)) : null,
    probe: null };
}
export async function reserveSizedProbe(storage, size, createKey, now) {
  return storage.transaction(async tx => {
    const root = await tx.get('verification:breaker');
    if (root?.bySize?.['*']?.tripped) size = '*';
    let breaker = scopedState(root, size);
    if (!breaker?.tripped) return true;
    if (!Number.isFinite(breaker.trippedAt)) breaker = { ...breaker, trippedAt: now, probe: null };
    if (breaker.probe?.createKey === createKey) return true;
    if (!breakerCanProbe(breaker, now)) { await tx.put('verification:breaker', scopedRoot(root, size, breaker)); return false; }
    await tx.put('verification:breaker', scopedRoot(root, size, { ...breaker, probe: { createKey, at: now } }));
    return true;
  });
}
export async function releaseSizedProbeInTransaction(tx, size, createKey) {
  const existing = await tx.get('verification:breaker');
  if (existing?.bySize?.['*']?.probe?.createKey === createKey) size = '*';
  const root = existing, breaker = scopedState(root, size);
  if (breaker?.probe?.createKey !== createKey) return false;
  await tx.put('verification:breaker', scopedRoot(root, size, { ...breaker, probe: null }));
  return true;
}
export async function releaseSizedProbe(storage, size, createKey) { return storage.transaction(tx => releaseSizedProbeInTransaction(tx, size, createKey)); }
export async function recordSizedBreakerOutcome(tx, options) {
  const root = await tx.get('verification:breaker');
  const wildcardProbe = root?.bySize?.['*']?.probe?.createKey;
  const size = (wildcardProbe && wildcardProbe === options.box.createKey) || !['small', 'default', 'large', 'xlarge'].includes(options.box.size) ? '*' : options.box.size;
  let scoped = scopedState(root, size);
  const adapter = {
    get: key => key === 'verification:breaker' ? Promise.resolve(scoped) : tx.get(key),
    put: (key, value) => { if (key === 'verification:breaker') { scoped = value; return Promise.resolve(); } return tx.put(key, value); },
  };
  const result = await recordBreakerOutcome(adapter, { ...options, box: { ...options.box, size } });
  await tx.put('verification:breaker', scopedRoot(root, size, scoped));
  return result;
}
