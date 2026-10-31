import { jobRunnerName, runnerName } from '../domain.mjs';
import { poolKey } from './pool.mjs';

const prefixes = ['job:', 'machine:', 'runner-owner:', 'slot:', 'due:', 'jit-job:', 'webhook-pending:', 'attention-reconcile-'];
const phaseState = {
  waiting: 'booting', pool_baseline_launch: 'destroying', pool_baseline_wait: 'baseline',
  configuring: 'idle', starting: 'idle', running: 'idle',
  pool_reset_start: 'destroying', pool_reset_launch: 'destroying', pool_reset_wait: 'resetting',
  destroying: 'destroying', unregister: 'unregister', purging: 'purging', reconciling: 'purging', attention: 'quarantined',
};

// Each cursor advance and its record conversion share one transaction.
export async function migrateProject(storage, project, commit, now = Date.now, budget) {
  let marker = await storage.get('pool:migrated');
  if (!marker) {
    await storage.put('pool:migrated', { commit, prefix: 0, cursor: '', done: false });
    marker = await storage.get('pool:migrated');
  }
  if (marker.done) return true;
  if (marker.commit !== commit) throw new Error('migration commit mismatch');
  while (marker.prefix < prefixes.length) {
    const page = await storage.list({ prefix: prefixes[marker.prefix], startAfter: marker.cursor, limit: 64 });
    if (!page.size) {
      marker = { ...marker, prefix: marker.prefix + 1, cursor: '' };
      await storage.put('pool:migrated', marker);
      continue;
    }
    for (const [key] of page) {
      marker = await storage.transaction(async tx => {
        const current = await tx.get('pool:migrated');
        if (current.commit !== commit || current.prefix !== marker.prefix || current.cursor !== marker.cursor) throw new Error('migration cursor changed');
        const value = await tx.get(key);
        if (value !== undefined) {
          await tx.put(`legacy:${key}`, { at: now(), value });
          if ((key.startsWith('job:') || key.startsWith('webhook-pending:')) && value.repo === project.repo && Number.isSafeInteger(value.installation) && value.installation > 0 && !await tx.get('pool:installation')) await tx.put('pool:installation', value.installation);
          if (key.startsWith('job:')) {
            const job = value, pool = poolKey(project.repo, job.label);
            if (budget && job.createKey && !job.machineId) await tx.put(`pool:legacy-start:${job.createKey}`, true);
            const ghKey = `gh-job:${job.id}`;
            if (!await tx.get(ghKey)) await tx.put(ghKey, { id: job.id, pool, status: job.intentDone ? 'completed' : job.intentStarted ? 'in_progress' : 'queued', runnerName: job.intentStarted ? job.assignedRunnerName ?? null : null, runId: job.runId ?? null, queuedAt: job.createdAt ?? now(), observedAt: job.updatedAt ?? job.createdAt ?? 0, source: 'legacy' });
            if (job.createPending && !job.machineId && job.createKey) await tx.put(`create:${job.createKey}`, { pool, size: job.machineSize ?? job.size, createKey: job.createKey, routerCreateName: job.routerCreateName, state: job.createAttemptedAt ? 'unknown' : 'pending', at: job.createAttemptedAt ?? job.createdAt ?? now(), callingAt: job.createAttemptedAt, queuedAt: job.createdAt ?? now(), reusable: job.routerReusable === true });
            if (job.machineId && phaseState[job.phase]) {
              const boxKey = `box:${job.machineId}`, machine = await tx.get(`machine:${job.machineId}`);
              if (!await tx.get(boxKey)) {
                const state = ['configuring', 'starting', 'running'].includes(job.phase) && !job.runnerId ? 'quarantined' : phaseState[job.phase];
                const name = job.runnerId ? jobRunnerName(job) : job.runnerIdentity ?? null;
                await tx.put(boxKey, { machineId: job.machineId, pool, size: job.machineSize ?? job.size, createKey: job.createKey, state, since: job.machineCreatedAt ?? job.createdAt ?? now(), createdAt: job.machineCreatedAt, generation: machine?.generation ?? job.generation ?? 0, runnerName: name, runnerId: job.runnerId ?? null, repo: project.repo, installation: job.installation, reusable: job.routerReusable === true, baselineHash: machine?.baselineHash, jobs: machine?.jobs ?? 0, processId: job.refreshProcessId, operationId: job.operationId });
                if (name) await tx.put(`runner:${name}`, { kind: 'boat', machineId: job.machineId, generation: job.generation ?? 0 });
                if (job.runnerId) await tx.put(`runner:${runnerName(job.id, job.generation)}`, { kind: 'boat', machineId: job.machineId, generation: job.generation ?? 0 });
              }
            }
          } else if (key.startsWith('runner-owner:')) {
            const job = (await tx.get(`legacy:job:${value}`))?.value, machineId = job?.machineId ?? job?.lastMachineId;
            if (machineId && await tx.get(`box:${machineId}`)) await tx.put(`runner:${key.slice('runner-owner:'.length)}`, { kind: 'boat', machineId, generation: job.generation ?? 0 });
          } else if (key.startsWith('webhook-pending:') && Number.isSafeInteger(value.id) && value.repo === project.repo && project.labels.includes(value.label) && ['queued', 'in_progress', 'completed'].includes(value.status)) {
            const ghKey = `gh-job:${value.id}`, previous = await tx.get(ghKey), observedAt = Number(key.split(':')[1]);
            if (!previous || previous.observedAt <= observedAt) await tx.put(ghKey, { id: value.id, pool: poolKey(value.repo, value.label), status: value.status, runnerName: value.runnerName ?? null, runId: value.runId ?? null, queuedAt: value.queuedAt ?? previous?.queuedAt ?? observedAt, observedAt, source: 'webhook' });
          } else if (key.startsWith('machine:') && value.state !== 'deleted') {
            const machineId = key.slice(8), boxKey = `box:${machineId}`;
            if (!await tx.get(boxKey)) {
              await tx.put(boxKey, { machineId, pool: null, size: value.compatibility?.size, state: 'quarantined', drainOnly: true, noRunnerKnown: value.state === 'ready' && !value.lease && !value.runnerId, since: now(), createdAt: value.createdAt, generation: value.generation ?? 0, runnerId: value.runnerId ?? null, reusable: false, jobs: value.jobs ?? 0 });
              await tx.put(`pool:drain-only:${machineId}`, { at: now(), reason: 'pool_unknown' });
            }
          }
          await tx.delete(key);
        }
        const next = { ...current, cursor: key };
        await tx.put('pool:migrated', next);
        return next;
      });
    }
  }
  if (budget) {
    const prepared = await storage.get('router:prepared-starts') ?? [];
    for (const key of prepared) await budget.abandon(key);
    let cursor = '';
    for (;;) {
      const staged = await storage.list({ prefix: 'pool:legacy-start:', startAfter: cursor, limit: 128 });
      for (const [key] of staged) { await budget.abandon(key.slice('pool:legacy-start:'.length)); await storage.delete(key); }
      if (staged.size < 128) break;
      cursor = [...staged.keys()].at(-1);
    }
    await storage.delete('router:prepared-starts');
  }
  await storage.put('pool:migrated', { ...marker, done: true, finishedAt: now() });
  return true;
}
