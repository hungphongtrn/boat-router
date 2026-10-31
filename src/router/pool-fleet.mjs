import { FleetBase } from './fleet-base.mjs';
import { LocalFleet } from './local-fleet.mjs';
import { jobKey } from './jit-pool.mjs';
import { verifyAttentionRecovery } from './attention-recovery.mjs';

export class PoolFleet extends FleetBase {
  constructor(storage, env, api, now, logger, options = {}) {
    super(storage, env, api, now, logger, options);
    this.poolProject = options.project;
    const claimer = options.project?.externalClaimer ?? options.project?.localFirst;
    if (claimer?.enabled === true) this.localFleet = new LocalFleet(this, claimer);
  }
  async operatorRecoverArchivedAttention(id) {
    const archived = await this.storage.get(`legacy:job:${id}`), job = archived?.value;
    if (!job || job.phase !== 'attention' || job.attentionReason !== 'alert_pool_retry_unconfirmed' ||
        job.createPending || !job.machineId || job.haltAfterCleanup ||
        (job.retryCount ?? 0) >= this.policy('MAX_JOB_ATTEMPTS', 3)) return false;
    const startedAt = this.now();
    if (!await verifyAttentionRecovery(this.api, job, id)) return false;
    return this.storage.transaction(async tx => {
      const currentArchive = await tx.get(`legacy:job:${id}`), current = currentArchive?.value;
      const machineArchive = await tx.get(`legacy:machine:${job.machineId}`), machine = machineArchive?.value;
      const claimArchive = await tx.get(`legacy:${jobKey(id)}`), claim = claimArchive?.value;
      const box = await tx.get(`box:${job.machineId}`), observed = await tx.get(`gh-job:${id}`);
      if (!current || current.phase !== 'attention' || current.attentionReason !== job.attentionReason || current.createPending ||
          current.haltAfterCleanup || (current.retryCount ?? 0) >= this.policy('MAX_JOB_ATTEMPTS', 3) ||
          current.machineId !== job.machineId || current.runnerId !== job.runnerId || current.runnerIdentity !== job.runnerIdentity || current.generation !== job.generation || current.createKey !== job.createKey ||
          machine?.state !== 'quarantined' || machine.lease !== id || claim?.state !== 'quarantined' ||
          claim.machineId !== job.machineId || claim.generation !== machine.generation || box?.state !== 'quarantined' ||
          box.runnerId !== (job.runnerId ?? null) || box.generation !== (machine.generation ?? job.generation ?? 0) ||
          (observed?.observedAt ?? 0) > startedAt) return false;
      await tx.put(`box:${job.machineId}`, { ...box, state: 'deleted', finishedAt: this.now() });
      await tx.put(`legacy:machine:${job.machineId}`, { ...machineArchive, value: { ...machine, state: 'deleted', finishedAt: this.now() } });
      const next = { ...current, phase: 'queued', machineId: null, runnerId: null, createPending: false, createKey: crypto.randomUUID(), nextAt: 0, intentDone: false, intentStarted: false };
      await tx.put(`legacy:job:${id}`, { ...currentArchive, value: next });
      if (observed) await tx.put(`gh-job:${id}`, { ...observed, status: 'queued', runnerName: null, observedAt: startedAt, source: 'resync', missing: false });
      await this.emit('operator_attention_recovered', next, { machine_id: job.machineId }, tx);
      return true;
    });
  }
}
