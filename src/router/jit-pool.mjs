export const jobKey = id => {
  const value = typeof id === 'number' && Number.isSafeInteger(id) && id > 0 ? String(id) : id;
  if (typeof value !== 'string' || !value || value.length > 160) throw new TypeError('invalid job id');
  return `jit-job:${encodeURIComponent(value)}`;
};
const equal = (a, b) => ['account', 'project', 'size', 'image', 'trust'].every(k => a?.[k] === b?.[k] && typeof a?.[k] === 'string' && a[k].length > 0);
export const RESET_CHECKS = Object.freeze(['processes', 'docker', 'worktree', 'ignoredPaths', 'home', 'tmp', 'ports', 'disk', 'dependencies']);

export function reuseEnabled(account, project) {
  return account?.reuse?.enabled === true && project?.reuse?.mode === 'on' && project?.dockerAccess !== true;
}
export function reuseLimits(account, project) {
  const jobs = [account?.reuse?.maxJobs ?? 60, project?.reuse?.maxJobs ?? 60];
  const ages = [account?.reuse?.maxAgeSeconds ?? 86400, project?.reuse?.maxAgeSeconds ?? 86400];
  if (![...jobs, ...ages].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  return { jobs: Math.min(...jobs), ageSeconds: Math.min(...ages) };
}

export class JitPool {
  constructor(storage, adapter, now = Date.now) { Object.assign(this, { storage, adapter, now }); }
  async recover(machineId) {
    return this.storage.transaction(async tx => {
      const key = `machine:${machineId}`, machine = await tx.get(key);
      if (!machine || !['assigning', 'cleaning'].includes(machine.state)) return false;
      await tx.put(key, { ...machine, state: 'quarantined', reason: 'interrupted_operation' });
      if (machine.lease) {
        const claim = await tx.get(jobKey(machine.lease));
        if (claim?.machineId === machineId) await tx.put(jobKey(machine.lease), { ...claim, state: 'quarantined' });
      }
      return true;
    });
  }
  async assign(job, account, project, { reserve } = {}) {
    const lease = await this.storage.transaction(async tx => {
      const key = `machine:${job.machineId}`;
      const machine = await tx.get(key);
      const claim = await tx.get(jobKey(job.id));
      if (claim && (claim.state !== 'retryable' || !equal(claim.compatibility, job.compatibility))) return null;
      if (!machine || machine.state !== 'ready' || !equal(machine.compatibility, job.compatibility)) return null;
      if (machine.jobs > 0 && !reuseEnabled(account, project)) return null;
      const limits = reuseLimits(account, project);
      if (!limits || !Number.isSafeInteger(machine.jobs) || machine.jobs < 0 || !Number.isFinite(machine.createdAt) || machine.jobs >= limits.jobs || this.now() - machine.createdAt >= limits.ageSeconds * 1000) return null;
      const next = { ...machine, state: 'assigning', lease: job.id, runnerId: null, generation: (machine.generation ?? 0) + 1, leasedAt: this.now(), lastActivityAt: this.now() };
      if (reserve && !await reserve(tx, next)) return null;
      await tx.put(key, next);
      await tx.put(jobKey(job.id), { machineId: job.machineId, generation: next.generation, state: 'active', retries: claim?.retries ?? 0, compatibility: job.compatibility });
      return next;
    });
    if (!lease) return { ok: false, reason: 'no_compatible_machine' };
    try {
      const registration = await this.adapter.register({ ...job, runnerIdentity: `boat-ci-j${job.id}-g${Math.max(job.runnerNameSequence ?? job.runnerSequence ?? 0, lease.generation - 1) + 1}` }, lease.generation);
      if (!registration) throw new Error('registration missing');
      await this.adapter.start(job.machineId, registration);
      const marked = await this.storage.transaction(async tx => {
        const key = `machine:${job.machineId}`, latest = await tx.get(key);
        if (latest?.state !== 'assigning' || latest.lease !== job.id) return false;
        await tx.put(key, { ...latest, state: 'busy' });
        return true;
      });
      if (!marked) return { ok: false, reason: 'lost_lease' };
      return { ok: true, generation: lease.generation };
    } catch {
      await this.quarantine(job.machineId, job.id);
      return { ok: false, reason: 'assignment_uncertain' };
    }
  }
  async quarantine(id, lease) {
    return this.storage.transaction(async tx => {
      const key = `machine:${id}`, machine = await tx.get(key);
      if (['assigning', 'busy', 'cleaning'].includes(machine?.state) && machine.lease === lease) {
        await tx.put(key, { ...machine, state: 'quarantined' });
        const claim = await tx.get(jobKey(lease));
        if (claim?.machineId === id) await tx.put(jobKey(lease), { ...claim, state: 'quarantined' });
      }
    });
  }
  // The adapter must confirm that the old box can never run again and that
  // the job is still queued. A missing or uncertain confirmation keeps the
  // tombstone; this experimental path is not wired to a real adapter yet.
  async permitRetry(job) {
    let proof;
    try { proof = await this.adapter.canRetry(job); } catch { return { ok: false, reason: 'retry_uncertain' }; }
    if (proof?.boxTerminal !== true || proof?.jobQueued !== true) return { ok: false, reason: 'retry_uncertain' };
    return this.storage.transaction(async tx => {
      const key = `machine:${job.machineId}`, machine = await tx.get(key), claim = await tx.get(jobKey(job.id));
      if (machine?.state !== 'quarantined' || machine.lease !== job.id || !claim || claim.state !== 'quarantined' || claim.machineId !== job.machineId || claim.generation !== machine.generation) return { ok: false, reason: 'lost_lease' };
      if ((claim.retries ?? 0) >= 1) return { ok: false, reason: 'retry_exhausted' };
      await tx.put(key, { ...machine, state: 'retiring', lease: null, runnerId: null });
      await tx.put(jobKey(job.id), { ...claim, state: 'retryable', retries: 1 });
      return { ok: true };
    });
  }
  async finish(job, account, project, { onReady, onRetire } = {}) {
    const machine = await this.storage.transaction(async tx => {
      const key = `machine:${job.machineId}`, current = await tx.get(key);
      if (!current || current.state !== 'busy' || current.lease !== job.id) return null;
      await tx.put(key, { ...current, state: 'cleaning' });
      return current;
    });
    if (!machine) return { ok: false, reason: 'lost_lease' };
    try { await this.adapter.removeRunner(job, machine.generation); }
    catch { await this.quarantine(job.machineId, job.id); return { ok: false, reason: 'cleanup_uncertain' }; }
    if (!reuseEnabled(account, project)) return this.retire(job, 'reuse_off', onRetire);
    const limits = reuseLimits(account, project);
    if (!limits || machine.jobs + 1 >= limits.jobs || this.now() - machine.createdAt >= limits.ageSeconds * 1000) return this.retire(job, 'reuse_limit', onRetire);
    if (this.adapter.deferredReset) return machine.baselineHash ? { ok: false, reason: 'reset_pending' } : this.retire(job, 'reset_failed', onRetire);
    let verified;
    try { verified = await this.adapter.resetAndVerify(job.machineId); }
    catch { await this.quarantine(job.machineId, job.id); return { ok: false, reason: 'cleanup_uncertain' }; }
    return this.completeReset(job, verified, { onReady, onRetire });
  }
  async completeReset(job, verified, { onReady, onRetire } = {}) {
    if (!verified || !RESET_CHECKS.every(check => verified[check] === true)) return this.retire(job, 'reset_failed', onRetire);
    return this.storage.transaction(async tx => {
      const key = `machine:${job.machineId}`, latest = await tx.get(key);
      if (latest?.state !== 'cleaning' || latest.lease !== job.id) return { ok: false, reason: 'lost_lease' };
      const claim = await tx.get(jobKey(job.id));
      if (!claim || claim.machineId !== job.machineId || claim.state !== 'active') return { ok: false, reason: 'lost_lease' };
      if (onReady && !await onReady(tx, latest)) return { ok: false, reason: 'lost_lease' };
      await tx.put(key, { ...latest, state: 'ready', lease: null, runnerId: null, jobs: latest.jobs + 1, idleSince: this.now() });
      await tx.put(jobKey(job.id), { ...claim, state: 'completed' });
      return { ok: true };
    });
  }
  async retire(job, reason, onRetire) {
    return this.storage.transaction(async tx => {
      const key = `machine:${job.machineId}`, latest = await tx.get(key);
      if (latest?.state !== 'cleaning' || latest.lease !== job.id) return { ok: false, reason: 'lost_lease' };
      const claim = await tx.get(jobKey(job.id));
      if (!claim || claim.machineId !== job.machineId || claim.state !== 'active') return { ok: false, reason: 'lost_lease' };
      if (onRetire && !await onRetire(tx, latest)) return { ok: false, reason: 'lost_lease' };
      await tx.put(key, { ...latest, state: 'retiring', lease: null, runnerId: null });
      await tx.put(jobKey(job.id), { ...claim, state: 'completed' });
      return { ok: false, reason };
    });
  }
}
