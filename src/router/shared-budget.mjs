import { snapshotLimits } from './ledger.mjs';

// A project-scoped view of the account ledger. Callers must reconcile a
// recovered claim before any new provider request, including after a crash.
export class SharedBudget {
  constructor(ledger, project, now = Date.now) { Object.assign(this, { ledger, project, now }); }
  async claimKey(key) {
    if (typeof key !== 'string' || !key || key.length > 1024) throw new TypeError('invalid budget key');
    const bytes = new TextEncoder().encode(JSON.stringify([this.project, key]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async admit(key, limits, { queuedAt = this.now(), jobId, pool = false } = {}) {
    const claim = await this.claimKey(key);
    await this.ledger.enqueue(this.project, claim, queuedAt, jobId, { pool });
    const result = await this.ledger.admit(this.project, claim, snapshotLimits(limits, this.now()), { pool });
    if (result.recovered && result.status !== 'pending') return { ok: false, reason: 'reconciliation_required', nextAt: this.now() + 5000 };
    return result.ok ? { ok: true, claim } : { ...result, nextAt: this.now() + 5000 };
  }
  async enqueue(key, queuedAt = this.now(), jobId, options) { return this.ledger.enqueue(this.project, await this.claimKey(key), queuedAt, jobId, options); }
  async admitBatch(keys, limits, { queuedAt = this.now() } = {}) {
    if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length) throw new TypeError('invalid budget batch');
    const hashes = await Promise.all(keys.map(key => this.claimKey(key)));
    const claims = await Promise.all(hashes.map(hash => this.ledger.claim(hash)));
    if (claims.some(claim => claim && (claim.project !== this.project || claim.status !== 'pending'))) return { ok: false, reason: 'reconciliation_required', nextAt: this.now() + 5000 };
    if (claims.every(Boolean)) return { ok: true };
    // A prior pre-call cancellation may leave only part of a reservation.
    // Pending claims have not called the provider and can be released safely.
    if (claims.some(Boolean)) for (const hash of hashes) await this.ledger.cancelPending(this.project, hash);
    await this.ledger.enqueueBatch(this.project, hashes, queuedAt);
    const result = await this.ledger.admitBatch(this.project, hashes, snapshotLimits(limits, this.now()));
    if (result.recovered) return { ok: false, reason: 'reconciliation_required', nextAt: this.now() + 5000 };
    return result.ok ? { ok: true } : { ...result, nextAt: this.now() + 5000 };
  }
  async cancelPending(key) { return this.ledger.cancelPending(this.project, await this.claimKey(key)); }
  async abandon(key) { return this.ledger.abandon(this.project, await this.claimKey(key)); }
  async begin(key, jobId) { return this.ledger.begin(this.project, await this.claimKey(key), jobId); }
  async claim(key) { return this.ledger.claim(await this.claimKey(key)); }
  // `not_created` requires conclusive provider proof; uncertain calls remain
  // charged. The caller must never mark a started machine as not created.
  async settle(key, status) {
    const claimKey = await this.claimKey(key), claim = await this.ledger.claim(claimKey);
    if (!claim || claim.project !== this.project) return false;
    return this.ledger.resolve(claimKey, status);
  }
}
