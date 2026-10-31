// The adapter must use the claim key as the provider idempotency key. An
// absent result is final only when the provider can rule out a late create.
const fields = ['account', 'project', 'size', 'image', 'trust'];
const same = (a, b) => fields.every(name => typeof a?.[name] === 'string' && a[name].length > 0 && a[name] === b?.[name]);

export class Provisioner {
  constructor(storage, ledger, adapter, now = Date.now) {
    Object.assign(this, { storage, ledger, adapter, now });
    this.inFlight = new Set();
  }
  async bind(project, key, compatibility, create = true) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('invalid start key');
    if (!same(compatibility, compatibility) || compatibility.project !== project || compatibility.account !== this.ledger.policy.id) throw new TypeError('incompatible account or project');
    return this.storage.transaction(async tx => {
      const startKey = `start:${key}`, old = await tx.get(startKey);
      if (old && (old.project !== project || !same(old.compatibility, compatibility))) throw new Error('start identity conflict');
      if (!old && create) await tx.put(startKey, { project, compatibility });
      return Boolean(old || create);
    });
  }
  async record(project, key, compatibility, machineId, claimAt) {
    if (!Number.isFinite(claimAt)) throw new TypeError('invalid claim time');
    if (typeof machineId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(machineId)) throw new TypeError('invalid machine id');
    return this.storage.transaction(async tx => {
      const machineKey = `machine:${machineId}`, startKey = `start:${key}`;
      const old = await tx.get(machineKey), start = await tx.get(startKey);
      if (!start || start.project !== project || !same(start.compatibility, compatibility) || (old && old.startKey !== key) || (start.machineId && start.machineId !== machineId)) throw new Error('machine ownership conflict');
      if (!old) await tx.put(machineKey, { state: 'creating', compatibility, jobs: 0, createdAt: claimAt, startKey: key });
      if (!start.machineId) await tx.put(startKey, { ...start, machineId });
    });
  }
  async start({ project, key, compatibility, snapshot }) {
    if (this.inFlight.has(key)) return { ok: false, reason: 'in_flight' };
    this.inFlight.add(key);
    try {
      await this.bind(project, key, compatibility);
      await this.ledger.enqueue(project, key);
      const admission = await this.ledger.admit(project, key, snapshot);
      if (!admission.ok) return admission;
      if (admission.recovered) return { ok: false, reason: 'reconciliation_required' };
      // Fence the call durably before leaving the transaction boundary. A
      // cancelled pending claim cannot be refunded once a call may start.
      if (!await this.ledger.begin(project, key)) return { ok: false, reason: 'claim_unavailable' };
      let created;
      try { created = await this.adapter.create({ key, compatibility }); }
      catch { await this.ledger.resolve(key, 'unknown'); return { ok: false, reason: 'create_uncertain' }; }
      const claim = await this.ledger.claim(key);
      try { await this.record(project, key, compatibility, created?.id, claim?.at); }
      catch { await this.ledger.resolve(key, 'unknown'); return { ok: false, reason: 'create_uncertain' }; }
      await this.ledger.resolve(key, 'created');
      return { ok: true, machineId: created.id };
    } finally { this.inFlight.delete(key); }
  }
  async reconcile({ project, key, compatibility }) {
    if (this.inFlight.has(key)) return { ok: false, reason: 'in_flight' };
    this.inFlight.add(key);
    try {
      const claim = await this.ledger.claim(key);
      if (!claim || claim.project !== project) return { ok: false, reason: 'no_claim' };
      if (!await this.bind(project, key, compatibility, false)) return { ok: false, reason: 'missing_start_identity' };
      let result;
      try { result = await this.adapter.find(key); } catch { return { ok: false, reason: 'create_uncertain' }; }
      if (result?.state === 'found') {
        try { await this.record(project, key, compatibility, result.id, claim.at); }
        catch { return { ok: false, reason: 'ownership_uncertain' }; }
        await this.ledger.resolve(key, 'created');
        return { ok: true, machineId: result.id };
      }
      if (result?.state === 'absent' && result.final === true && claim.status !== 'created') {
        await this.ledger.resolve(key, 'not_created');
        return { ok: false, reason: 'confirmed_absent' };
      }
      return { ok: false, reason: 'create_uncertain' };
    } finally { this.inFlight.delete(key); }
  }
}
