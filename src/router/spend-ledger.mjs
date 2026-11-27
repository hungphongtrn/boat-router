import { MACHINE_SIZES } from './sizes.mjs';

// One account-ledger view of money: every provider write reserves its maximum
// metered lifetime (a start its TTL, a snapshot its retention) before the call.
// A confirmed provider deletion settles a machine to conservative elapsed time
// and a snapshot to conservative elapsed days; anything ambiguous keeps the
// full reservation. A normal stop costs no VM time (provider billing) and a
// stopped ordinary disk is free, so neither is charged; a saved snapshot is.
// The rolling window is the owner's billing window observed through
// `boat.dev/api/v1/limits` (`overagePrices.vmHourDollars`); a free credit
// balance and plan-included VM time are never subtracted.
export const SPEND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SPEND_KEY = /^[A-Za-z0-9:_.-]{1,200}$/;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const PROJECT = /^[a-z0-9][a-z0-9-]{0,62}$/;
const usd = value => Number.isFinite(value) && value > 0;
const roundUsd = value => Math.ceil(value * 1e6) / 1e6;
const mean = value => Number.isFinite(value) && value > 0;

// Validate the tariff where the policy is loaded, not on the first start: an
// account with a malformed spend block fails its deployment closed.
export function normalizeSpendPolicy(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('invalid spend policy');
  if (!usd(raw.monthlyUsd)) throw new TypeError('invalid spend monthly ceiling');
  const rates = raw.machineHourUsd;
  const table = typeof rates === 'number' ? { default: rates } : rates;
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new TypeError('invalid machine-hour tariff');
  const machineHourUsd = {};
  for (const [size, rate] of Object.entries(table)) {
    if (size !== 'default' && !MACHINE_SIZES.includes(size)) throw new TypeError(`unknown machine size tariff: ${size}`);
    if (!mean(rate)) throw new TypeError(`invalid machine-hour tariff: ${size}`);
    machineHourUsd[size] = rate;
  }
  if (!usd(machineHourUsd.default)) throw new TypeError('invalid default machine-hour tariff');
  if (!usd(raw.snapshotDayUsd)) throw new TypeError('invalid snapshot-day tariff');
  if (!Number.isSafeInteger(raw.snapshotRetentionDays) || raw.snapshotRetentionDays < 1) throw new TypeError('invalid snapshot retention');
  return {
    monthlyUsd: raw.monthlyUsd,
    machineHourUsd,
    snapshotDayUsd: raw.snapshotDayUsd,
    snapshotRetentionDays: raw.snapshotRetentionDays,
  };
}

function machineRate(policy, size) {
  if (typeof size !== 'string' || !MACHINE_SIZES.includes(size)) throw new TypeError('invalid spend machine size');
  const rate = policy.machineHourUsd[size] ?? policy.machineHourUsd.default;
  if (!mean(rate)) throw new TypeError(`unknown machine-hour tariff: ${size}`);
  return rate;
}

// The charge for a cost descriptor. Unknown kinds and tariffs are refused, not
// guessed: a caller that cannot say what it is about to spend gets no admission.
export function spendAmount(policy, cost) {
  if (!cost || typeof cost !== 'object' || Array.isArray(cost)) throw new TypeError('invalid spend cost');
  if (cost.kind === 'machine') {
    if (!Number.isSafeInteger(cost.ttlSeconds) || cost.ttlSeconds < 1 || cost.ttlSeconds * 1000 > SPEND_WINDOW_MS) throw new TypeError('invalid spend machine lifetime');
    return roundUsd(machineRate(policy, cost.size) * cost.ttlSeconds / 3600);
  }
  if (cost.kind === 'storage') {
    const days = cost.days ?? policy.snapshotRetentionDays;
    if (!Number.isSafeInteger(days) || days < 1 || days > policy.snapshotRetentionDays) throw new TypeError('invalid spend storage retention');
    return roundUsd(policy.snapshotDayUsd * days);
  }
  throw new TypeError(`unknown spend cost: ${cost.kind}`);
}

function validKey(key) {
  return typeof key === 'string' && SPEND_KEY.test(key) && !RESERVED_KEYS.has(key);
}

function reservations(state) {
  const value = state?.spendReservations;
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// A saved snapshot never expires because the billing window did. An active
// storage reservation renews in every later 30-day window until its owner
// confirms deletion, so a long-retained snapshot keeps consuming the ceiling.
// Settled storage stays at its original date and its actual charge ages out
// like any other spend; the deletion itself never erases a charge already
// inside the rolling window.
export function spendRollOffAt(record) {
  if (!record || !Number.isFinite(record.at)) return 0;
  if (record.kind === 'storage' && record.settledAmount !== true) return Infinity;
  const ttlMs = record.kind === 'machine' && record.settledAmount !== true
    ? record.ttlSeconds * 1000 : 0;
  return record.at + ttlMs + SPEND_WINDOW_MS;
}

export function pruneSpend(records, now) {
  for (const [key, record] of Object.entries(records)) {
    if (spendRollOffAt(record) <= now) delete records[key];
  }
}

function counted(records, now) {
  const live = [];
  for (const [key, record] of Object.entries(records)) {
    if (!record || !Number.isFinite(record.at) || !usd(record.amountUsd)) continue;
    let at = record.at;
    if (record.kind === 'storage' && record.settledAmount !== true && record.status !== 'settled') {
      if (at <= now - SPEND_WINDOW_MS) {
        at += Math.floor((now - at) / SPEND_WINDOW_MS) * SPEND_WINDOW_MS;
      }
      live.push({ key, ...record, at, standing: true });
      continue;
    }
    if (spendRollOffAt(record) <= now) continue;
    live.push({ key, ...record });
  }
  live.sort((a, b) => a.at - b.at || a.key.localeCompare(b.key));
  return live;
}

export function summarizeSpend(policy, records, now) {
  if (!policy) return { enabled: false, records: [] };
  const live = counted(records, now);
  const spentUsd = roundUsd(live.reduce((sum, record) => sum + record.amountUsd, 0));
  const next = live.reduce((earliest, record) => Math.min(earliest, spendRollOffAt(record)), Infinity);
  return {
    enabled: true,
    capUsd: policy.monthlyUsd,
    spentUsd,
    reservedUsd: spentUsd,
    remainingUsd: roundUsd(Math.max(0, policy.monthlyUsd - spentUsd)),
    nextRollOffAt: Number.isFinite(next) ? next : null,
    records: live,
  };
}

// Reserve against the shared ledger. Returns `{ ok: false, reason:
// 'spend_budget', nextAt }` when the ceiling would be crossed; `nextAt` is the
// moment the oldest reservation leaves the window. The same key from the same
// project and cost is idempotent, so a retried request never double-charges.
export async function reserveSpend(ledger, project, key, cost) {
  const policy = ledger.spend;
  if (!policy) throw new TypeError('spend is not configured');
  if (typeof project !== 'string' || !PROJECT.test(project)) throw new TypeError('invalid spend project');
  if (!validKey(key)) throw new TypeError('invalid spend key');
  const amountUsd = spendAmount(policy, cost);
  const now = ledger.now();
  return ledger.storage.transaction(async tx => {
    const state = await tx.get(ledger.key) ?? { claims: {}, waiting: [] };
    const records = reservations(state), existing = records[key];
    if (existing) {
      if (existing.project !== project || existing.kind !== cost.kind) throw new Error('spend reservation conflict');
      // A settled reservation is terminal: a retry must not re-reserve it, and
      // its actual amount is allowed to differ from the maximum.
      if (existing.status !== 'reserved') return { ok: true, recovered: true, amountUsd: existing.amountUsd, status: existing.status, ...summarizeSpend(policy, records, now) };
      if (Math.abs(existing.amountUsd - amountUsd) > 1e-9) throw new Error('spend reservation conflict');
      return { ok: true, recovered: true, amountUsd: existing.amountUsd, status: existing.status, ...summarizeSpend(policy, records, now) };
    }
    pruneSpend(records, now);
    const live = counted(records, now);
    const spent = live.reduce((sum, record) => sum + record.amountUsd, 0);
    if (spent + amountUsd > policy.monthlyUsd + 1e-9) {
      return { ok: false, reason: 'spend_budget', amountUsd, spentUsd: roundUsd(spent), capUsd: policy.monthlyUsd,
        nextAt: summarizeSpend(policy, records, now).nextRollOffAt ?? now + SPEND_WINDOW_MS };
    }
    records[key] = { project, kind: cost.kind, amountUsd, at: now, status: 'reserved',
      ...(cost.kind === 'machine' ? { size: cost.size, ttlSeconds: cost.ttlSeconds } : { days: cost.days ?? policy.snapshotRetentionDays }) };
    state.spendReservations = records;
    await tx.put(ledger.key, state);
    return { ok: true, recovered: false, amountUsd, ...summarizeSpend(policy, records, now) };
  });
}

// A conclusive answer from the provider. `not_created` releases a start only
// when the provider can rule out a late create; `unknown` (and `created`
// without proof of deletion) stay charged at their maximum. A provider-
// confirmed deletion of a created machine settles it to conservative elapsed
// time, which frees the unused part of its TTL reservation; the elapsed time is
// rounded up to a second and includes the caller's deletion-latency allowance.
export async function settleSpend(ledger, key, status, { elapsedSeconds } = {}) {
  if (!['created', 'unknown', 'not_created'].includes(status)) throw new TypeError('invalid spend settlement');
  if (!validKey(key)) throw new TypeError('invalid spend key');
  if (elapsedSeconds !== undefined && (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)) throw new TypeError('invalid spend elapsed time');
  return ledger.storage.transaction(async tx => {
    const state = await tx.get(ledger.key), record = reservations(state)[key];
    if (!record) return false;
    if (status === 'not_created') {
      if (record.status === 'created') throw new Error('created spend cannot be refunded');
      delete state.spendReservations[key];
    } else if (status === 'created') {
      if (record.status !== 'created') { record.status = 'created'; record.settledAt = ledger.now(); }
      if (record.kind === 'machine' && elapsedSeconds !== undefined && record.settledAmount !== true) {
        const elapsed = Math.min(record.ttlSeconds, Math.max(1, Math.ceil(elapsedSeconds)));
        const actual = roundUsd(machineRate(ledger.spend, record.size) * elapsed / 3600 + (record.startFeeUsd ?? 0));
        record.reservedUsd = record.amountUsd;
        record.reservedAt ??= record.at;
        record.at = ledger.now();
        record.amountUsd = Math.min(record.amountUsd, actual);
        record.elapsedSeconds = elapsed;
        record.settledAmount = true;
        record.settledAt = ledger.now();
      }
      state.spendReservations[key] = record;
    } else if (record.status === 'reserved') {
      record.status = 'unknown';
      state.spendReservations[key] = record;
    }
    await tx.put(ledger.key, state);
    return true;
  });
}

// Saved-snapshot storage stops costing money only when the provider confirms
// the artifact is gone. The caller supplies elapsed seconds from reservation to
// that confirmation (or it is measured from the reservation); days are rounded
// up, and the charge is capped at the reserved retention. A failed save, an
// unreadable list or a delete in flight keep the full reservation.
export async function confirmStorageDeleted(ledger, key, { elapsedSeconds } = {}) {
  if (!validKey(key)) throw new TypeError('invalid spend key');
  if (elapsedSeconds !== undefined && (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)) throw new TypeError('invalid spend elapsed time');
  return ledger.storage.transaction(async tx => {
    const state = await tx.get(ledger.key), record = reservations(state)[key];
    if (!record) return false;
    if (record.kind !== 'storage') throw new TypeError('spend reservation is not storage');
    if (record.settledAmount !== true) {
      const now = ledger.now();
      const elapsed = elapsedSeconds ?? Math.max(0, (now - record.at) / 1000);
      const days = Math.min(record.days, Math.max(1, Math.ceil(elapsed / 86_400)));
      record.reservedUsd = record.amountUsd;
      record.reservedAt ??= record.at;
      record.at = now;
      record.amountUsd = Math.min(record.amountUsd, roundUsd(ledger.spend.snapshotDayUsd * days));
      record.elapsedDays = days;
      record.settledAmount = true;
      record.settledAt = now;
      record.status = 'settled';
    }
    state.spendReservations[key] = record;
    await tx.put(ledger.key, state);
    return true;
  });
}

// Public readiness: a third party (the local fallback) needs one stable
// category before it sends heavy work here. Costs, rates and the account stay
// private; only `ready` and the reason category leave this process.
export function admissionReadiness(status, minStartUsd) {
  if (!status || status.enabled !== true) return { ready: true, admission: 'ready' };
  if (!Number.isFinite(status.remainingUsd)) return { ready: false, admission: 'unavailable' };
  if (status.remainingUsd + 1e-9 < minStartUsd) return { ready: false, admission: 'exhausted' };
  return { ready: true, admission: 'ready' };
}

// The release path for a claim that was cancelled before any provider call.
// The claim key is the reservation key, so this is exactly one ledger entry.
export function releaseSpendInState(state, key) {
  const record = reservations(state)[key];
  if (!record || record.status === 'created') return false;
  delete state.spendReservations[key];
  return true;
}
