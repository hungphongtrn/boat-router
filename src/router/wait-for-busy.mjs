import { snapshotLimits } from './ledger.mjs';
import { plan, uncovered, supplyCounts } from './pool.mjs';
import { records } from './pool-records.mjs';

const median = values => {
  if (!values?.length) return null;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i] : (sorted[i - 1] + sorted[i]) / 2;
};
const historyKey = pool => `wait-history:${pool}`;

export async function recordDuration(tx, job) {
  if (job.conclusion === 'timed_out') job.slowBox = true;
  const duration = job.completedAt - job.startedAt;
  if (!Number.isFinite(duration) || duration <= 0 || !job.conclusion) return;
  const key = historyKey(job.pool), history = await tx.get(key) ?? { all: [], names: {} };
  const poolMedian = median(history.all);
  if (poolMedian && duration > 3 * poolMedian) job.slowBox = true;
  job.durationRecorded = true;
  if (['timed_out', 'cancelled', 'skipped'].includes(job.conclusion)) return;
  history.all = [...history.all, duration].slice(-32);
  if (job.jobName) {
    const name = JSON.stringify(job.jobName);
    history.names[name] = [...(history.names[name] ?? []), duration].slice(-32);
    const names = Object.keys(history.names);
    if (names.length > 100) delete history.names[names[0]];
  }
  await tx.put(key, history);
}

export async function waitClaims({ storage, api, jobs, boxes, pools, units, now, account, project, env = {}, enabled, logger }) {
  const cfg = account.waitForBusyBox;
  const valid = enabled && cfg?.enabled === true && Number.isFinite(cfg.maxWaitMs) && cfg.maxWaitMs > 0 &&
    Number.isFinite(cfg.scarcityFrom) && Number.isFinite(cfg.scarcityFull) && cfg.scarcityFrom >= 0 && cfg.scarcityFull <= 1 && cfg.scarcityFull > cfg.scarcityFrom;
  const claims = await records(storage, 'wait:claim:');
  const active = [], claimedBoxes = new Set();
  const byJob = new Map(jobs.map(j => [j.id, j])), byBox = new Map(boxes.map(b => [b.machineId, b]));
  const finish = async (claim, outcome) => {
    const removed = await storage.transaction(async tx => {
      const current = await tx.get(`wait:claim:${claim.jobId}`);
      if (!current || current.machineId !== claim.machineId || current.at !== claim.at) return false;
      await tx.delete(`wait:claim:${claim.jobId}`);
      if (await tx.get(`wait:box:${claim.machineId}`) === claim.jobId) await tx.delete(`wait:box:${claim.machineId}`);
      const job = await tx.get(`gh-job:${claim.jobId}`);
      if (job) await tx.put(`gh-job:${claim.jobId}`, { ...job, waitAttempted: true });
      return true;
    });
    if (!removed) return;
    const current = byJob.get(claim.jobId); if (current) current.waitAttempted = true;
    logger?.(JSON.stringify({ event: 'busy_box_wait_end', project: project.id, job_id: claim.jobId, machine_id: claim.machineId, outcome, waited_ms: Math.max(0, now - claim.at) }));
  };
  for (const claim of claims) {
    const job = byJob.get(claim.jobId), box = byBox.get(claim.machineId);
    let outcome;
    if (!valid) outcome = 'disabled';
    else if (!job || job.missing) outcome = 'job_missing';
    else if (job.status !== 'queued') outcome = job.runnerName && box?.runnerName === job.runnerName ? 'reused' : 'other_assignment';
    else if (now >= claim.until) outcome = 'expired';
    else if (!box || box.pool !== claim.pool || box.failureReason || box.drainOnly || (box.state === 'retiring' && box.afterFence !== 'finished') || ['destroying', 'purging', 'deleted', 'quarantined', 'unregister'].includes(box.state)) outcome = 'box_failed';
    else if (box.generation > claim.generation && box.state === 'busy') outcome = 'other_assignment';
    if (outcome) await finish(claim, outcome);
    else { active.push(claim); claimedBoxes.add(claim.machineId); }
  }
  if (!valid) return { virtual: [], active: [] };
  const virtual = claim => {
    const box = byBox.get(claim.machineId);
    const unit = units.find(u => u.machineId === claim.machineId);
    return box && (!unit || !Object.values(supplyCounts([unit], now)).some(Boolean)) ? { kind: 'create', state: 'pending', pool: claim.pool } : null;
  };
  const currentUnits = () => [...units, ...active.map(virtual).filter(Boolean)];
  let limits;
  for (const pool of pools) {
    const out = plan({ pools: [pool], jobs, units: currentUnits(), now })[pool.key];
    if (!out.create || pool.reason) continue;
    const held = active.filter(c => c.pool === pool.key).length;
    const eligibleJobs = jobs.filter(j => j.pool === pool.key && j.status === 'queued' && !j.missing && !j.waitAttempted && !active.some(c => c.jobId === j.id) && (!pool.localFirst || j.queuedAt + (pool.offerSeconds ?? 30) * 1000 <= now));
    const freeSupply = Math.max(0, out.S - held);
    const candidates = uncovered(eligibleJobs, freeSupply).slice(0, out.create);
    for (const job of candidates) {
      const ttl = Number(project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200);
      const timeouts = Object.values(project.jobs ?? {}).map(j => j.timeoutMinutes ?? 0);
      const headroom = Math.max(300, 1200 + Math.max(0, ...timeouts) * 60);
      const maxJobs = Math.min(account.reuse?.maxJobs ?? 60, project.reuse?.maxJobs ?? 60);
      const maxAge = Math.min(account.reuse?.maxAgeSeconds ?? 86400, project.reuse?.maxAgeSeconds ?? 86400);
      const available = boxes.filter(b => b.pool === pool.key && b.state === 'busy' && b.reusable && b.baselineHash && !b.failureReason && !b.drainOnly && !claimedBoxes.has(b.machineId) &&
        Number.isFinite(b.createdAt) && Number.isFinite(ttl) && timeouts.every(Number.isFinite) && (b.jobs ?? 0) + 1 < maxJobs && now - b.createdAt < Math.min(maxAge, ttl - headroom) * 1000);
      if (!available.length) break;
      if (limits === undefined) { try { limits = snapshotLimits(await api.limits(), now); } catch { limits = null; } }
      const day = limits?.windows?.day, hour = limits?.windows?.hour;
      if (!day || !hour || now - limits.at > 30_000 || limits.at > now) break;
      const scarcity = Math.max(day.used / day.limit, hour.used / hour.limit);
      const allowance = Math.min(600_000, cfg.maxWaitMs) * Math.max(0, Math.min(1, (scarcity - cfg.scarcityFrom) / (cfg.scarcityFull - cfg.scarcityFrom)));
      if (allowance <= 0) break;
      const history = await storage.get(historyKey(pool.key)) ?? { all: [], names: {} };
      const choices = available.map(box => {
        const running = jobs.find(j => j.status === 'in_progress' && j.runnerName === box.runnerName && j.pool === pool.key);
        const typical = median(history.names[JSON.stringify(running?.jobName)]) ?? median(history.all) ?? 600_000;
        const poolMedian = median(history.all);
        const tooSlow = running && poolMedian && now - running.startedAt > 3 * poolMedian;
        return { box, remaining: running && Number.isFinite(running.startedAt) && !tooSlow ? Math.max(0, running.startedAt + typical - now) + 15_000 : Infinity };
      }).filter(item => item.remaining <= allowance).sort((a,b) => a.remaining - b.remaining);
      if (!choices.length) continue;
      const box = choices[0].box, claim = { jobId: job.id, pool: pool.key, machineId: box.machineId, generation: box.generation ?? 0, at: now, until: now + allowance };
      const acquired = await storage.transaction(async tx => {
        if (await tx.get(`wait:claim:${job.id}`) || await tx.get(`wait:box:${box.machineId}`)) return false;
        await tx.put(`wait:claim:${job.id}`, claim);
        await tx.put(`wait:box:${box.machineId}`, job.id);
        return true;
      });
      if (!acquired) continue;
      active.push(claim); claimedBoxes.add(box.machineId);
      logger?.(JSON.stringify({ event: 'busy_box_wait_start', project: project.id, job_id: job.id, machine_id: box.machineId, allowance_ms: allowance, expected_ms: choices[0].remaining }));
    }
  }
  return { virtual: active.map(virtual).filter(Boolean), active };
}
