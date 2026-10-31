import { jobKey } from './jit-pool.mjs';

async function quarantineClaim(tx, machineId, leaseId) {
  const key = jobKey(leaseId), claim = await tx.get(key);
  if (claim?.machineId === machineId && claim.state === 'active') await tx.put(key, { ...claim, state: 'quarantined' });
}

export async function recordActivity(storage, machineId, leaseId, at) {
  if (!Number.isFinite(at)) throw new TypeError('invalid activity time');
  return storage.transaction(async tx => {
    const key = `machine:${machineId}`, current = await tx.get(key);
    if (!current || current.state !== 'busy' || current.lease !== leaseId || at <= current.lastActivityAt) return false;
    await tx.put(key, { ...current, lastActivityAt: at });
    return true;
  });
}

export async function stopSilent({ storage, adapter, machineId, leaseId, now, idleMs }) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(idleMs) || idleMs < 1) throw new TypeError('invalid watchdog timing');
  const machine = await storage.transaction(async tx => {
    const key = `machine:${machineId}`, current = await tx.get(key);
    if (!current || current.state !== 'busy' || current.lease !== leaseId || !Number.isFinite(current.lastActivityAt) || now - current.lastActivityAt < idleMs) return null;
    await tx.put(key, { ...current, state: 'quarantined', reason: 'silent' });
    await quarantineClaim(tx, machineId, leaseId);
    return current;
  });
  if (!machine) return { stopped: false, reason: 'not_silent' };
  let evidence = false;
  try { await adapter.captureEvidence(machineId, leaseId); evidence = true; } catch {}
  try { const result = await adapter.stop(machineId); if (result === false || result?.success === false) throw new Error('stop failed'); } catch { return { stopped: false, reason: 'stop_uncertain', evidence }; }
  return { stopped: true, replace: true, evidence };
}

// Adapter effects must be idempotent for the supplied recovery key. A
// replacement callback must reserve its start through the account ledger.
export async function recoverSilent({ storage, adapter, machineId, leaseId, now, idleMs }) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(idleMs) || idleMs < 1) throw new TypeError('invalid watchdog timing');
  const key = `machine:${machineId}`, recoveryKey = JSON.stringify([machineId, leaseId]);
  const initialized = await storage.transaction(async tx => {
    const machine = await tx.get(key);
    if (machine?.state === 'busy' && machine.lease === leaseId && Number.isFinite(machine.lastActivityAt) && now - machine.lastActivityAt >= idleMs) {
      await tx.put(key, { ...machine, state: 'quarantined', reason: 'silent', watchdog: { key: recoveryKey, phase: 'evidence' } });
      await quarantineClaim(tx, machineId, leaseId);
      return true;
    }
    return machine?.state === 'quarantined' && machine.lease === leaseId && machine.watchdog?.key === recoveryKey;
  });
  if (!initialized) return { ok: false, reason: 'not_silent' };
  const advance = async (phase, updates) => storage.transaction(async tx => {
    const current = await tx.get(key);
    if (current?.state !== 'quarantined' || current.lease !== leaseId || current.watchdog?.key !== recoveryKey) return false;
    if (current.watchdog.phase === phase) await tx.put(key, { ...current, watchdog: { ...current.watchdog, ...updates } });
    return true;
  });
  while (true) {
    const machine = await storage.get(key), recovery = machine?.watchdog;
    if (machine?.state !== 'quarantined' || machine.lease !== leaseId || recovery?.key !== recoveryKey) return { ok: false, reason: 'lost_lease' };
    if (recovery.phase === 'done') return { ok: true, evidence: recovery.evidence, replacement: recovery.replacement };
    if (recovery.phase === 'evidence') {
      let evidence = false;
      try { await adapter.captureEvidence(machineId, leaseId, recoveryKey); evidence = true; } catch {}
      if (!await advance('evidence', { phase: 'stop', evidence })) return { ok: false, reason: 'lost_lease' };
    } else if (recovery.phase === 'stop') {
      try { const result = await adapter.stop(machineId, recoveryKey); if (result === false || result?.success === false) throw new Error('stop failed'); } catch { return { ok: false, reason: 'stop_uncertain', evidence: recovery.evidence }; }
      if (!await advance('stop', { phase: 'replace' })) return { ok: false, reason: 'lost_lease' };
    } else if (recovery.phase === 'replace') {
      let replacement;
      try { replacement = await adapter.enqueueReplacement({ machineId, leaseId, key: recoveryKey }); }
      catch { return { ok: false, reason: 'replacement_uncertain', evidence: recovery.evidence }; }
      if (typeof replacement !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(replacement)) return { ok: false, reason: 'replacement_uncertain', evidence: recovery.evidence };
      if (!await advance('replace', { phase: 'done', replacement })) return { ok: false, reason: 'lost_lease' };
    } else return { ok: false, reason: 'invalid_recovery' };
  }
}
