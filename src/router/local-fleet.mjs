const active = runner => ['claiming', 'pending', 'started', 'retiring'].includes(runner.state);
const queued = job => !job.intentDone && !job.intentStarted && !['done', 'attention'].includes(job.phase);
const boatPending = job => ['queued', 'waiting', 'configuring', 'starting', 'running', 'pool_baseline_launch', 'pool_baseline_wait'].includes(job.phase) && !job.haltAfterCleanup && !job.assignedJobId && Boolean(job.createPending || job.machineId);
// GitHub can assign a JIT runner to any queued job with the same label, even
// one which the router stopped counting as demand. Keep local runners out of
// a pool until every potentially queued job with Boat history is resolved.
const unresolvedBoat = job => !job.intentDone && !job.intentStarted && (job.phase === 'attention' || Boolean(job.localBoatHistory || job.machineId || job.lastMachineId || job.createPending || job.createAttemptedAt || job.retryCount || job.attempts));

import { LANES_SWITCH_KEY, laneRules, laneRank, laneComparator } from './lanes.mjs';

import { records as all } from './pool-records.mjs';

// Select the oldest eligible job across all labels a real mini slot supports.
// A tick can share the read cache across offers; every successful claim
// invalidates its label so the next offer sees the new reservation.
export async function claimAny(entries, host, diagnostics = {}, cache = new Map()) {
  const choices = [];
  let enabled = false;
  for (const entry of entries) {
    if (!entry.local.enabled(entry.label)) continue;
    enabled = true;
    const key = `${entry.project}:${entry.label}`;
    let counts = cache.get(key);
    if (!counts) { counts = await entry.local.storage.transaction(tx => entry.local.counts(tx, entry.label)); cache.set(key, counts); }
    if (counts.boatFence || counts.supply >= counts.jobs.length) continue;
    const jobs = counts.jobs.filter(job => !(counts.boatReserved ?? []).includes(job.id) && !counts.local.some(runner => runner.jobId === job.id));
    // lane rank first (release before hotfix before feature before bisect, aged every 30 min), then age.
    for (const job of jobs) choices.push({ entry, key, at: job.createdAt, id: job.id, rank: counts.lanesOn ? laneRank(job, entry.local.now()) : 0 });
  }
  choices.sort((a, b) => a.rank - b.rank || a.at - b.at || a.id - b.id);
  for (const choice of choices) {
    const result = await choice.entry.local.claim(choice.entry.label, host, diagnostics);
    cache.delete(choice.key);
    if (result) return { ...result, project: choice.entry.project };
  }
  diagnostics.reason = enabled ? 'no_runnable_job' : 'project_disabled';
  return null;
}

// per-label runtime switch for a local-first Actions pool (config.switch === 'storage'); off by default.
export const LOCAL_MODE_KEY = 'local:labels';
// localFirst.branches scopes local-first to jobs whose head branch matches one of the
// patterns (`*` wildcard). A job without a known branch is not offered while a scope is set.
const globMatch = (pattern, value) => typeof pattern === 'string' && new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(value);
export function localBranchAllowed(config, branch) {
  const patterns = config?.branches;
  if (!Array.isArray(patterns) || !patterns.length) return true;
  if (typeof branch !== 'string' || !branch) return false;
  return patterns.some(pattern => globMatch(pattern, branch));
}
// localFirst.boatOnlyJobs lists job-name patterns (`*` wildcard) that never run
// local-first, e.g. a lane whose lockfile has no arm64 wheels. Such a job is neither offered to the agent nor held.
// a job whose runs-on adds one of the tenant's Boat labels (`boatOnly` from selection) is Boat-only too.
export function localJobAllowed(config, job) {
  if (job?.boatOnly === true) return false;
  if (!localBranchAllowed(config, job?.branch)) return false;
  const patterns = config?.boatOnlyJobs;
  if (!Array.isArray(patterns) || !patterns.length) return true;
  const name = typeof job?.jobName === 'string' ? job.jobName : '';
  return !patterns.some(pattern => globMatch(pattern, name));
}
export function labelLocal(config, switches = {}, label) {
  if (config?.enabled !== true || !config.labels?.[label]) return 'off';
  return config.switch === 'storage' ? (switches[label] === 'on' ? 'on' : 'off') : 'on';
}

export class LocalFleet {
  constructor(controller, config) { this.controller = controller; this.storage = controller.storage; this.api = controller.api; this.now = controller.now; this.config = config; }
  enabled(label) { return this.controller.env?.CI_TO_MINIS !== 'false' && this.config?.enabled === true && typeof this.config.labels?.[label] === 'string' && Boolean(this.config.labels[label]); }
  offerMs() { return (this.config.offerSeconds ?? 30) * 1000; }
  timeoutMs() { return (this.config.claimSeconds ?? 900) * 1000; }
  async unavailable(label) {
    if (!this.enabled(label)) return false;
    await this.storage.delete(`local-room:${label}`);
    await this.controller.wake();
    return true;
  }
  async lanesEnabled(tx) {
    const project = this.controller.poolProject;
    if (!laneRules(project).length) return false;
    return (await tx.get(LANES_SWITCH_KEY))?.mode !== 'off';
  }
  async counts(tx, label) {
    const storedMode = await tx.get('pool:mode');
    const mode = (await tx.get('pool:migrated'))?.done && storedMode !== 'on' ? 'drain' : storedMode;
    if (['on', 'drain'].includes(mode)) {
      const project = this.controller.poolProject, pool = poolKey(project.repo, label), snapshot = await tx.get('pool:snapshot');
      const observedJobs = (await all(tx, 'gh-job:')).filter(job => !job.missing || !snapshot?.complete);
      const jobs = runnableDemand(observedJobs, project.workflowConcurrency, snapshot?.complete, { laneCaps: await this.lanesEnabled(tx) }).filter(job => job.pool === pool && job.status === 'queued' && localJobAllowed(this.config, job));
      const local = (await all(tx, 'local-runner:')).filter(runner => runner.label === label && active(runner));
      const boxes = (await all(tx, 'box:')).filter(box => box.pool === pool && !box.drainOnly);
      const creates = (await all(tx, 'create:')).filter(create => create.pool === pool);
      const runners = snapshot?.complete ? snapshot.runners ?? [] : [];
      const known = new Set([...boxes.map(box => box.runnerName), ...local.map(runner => runner.name)]);
      const observed = name => runners.find(runner => runner.name === name);
      const units = [
        ...boxes.map(box => ({ ...box, online: observed(box.runnerName)?.status === 'online', busy: observed(box.runnerName)?.busy === true })),
        ...creates.map(create => ({ ...create, kind: 'create' })),
        ...local.map(runner => ({ ...runner, kind: 'local', online: observed(runner.name)?.status === 'online', busy: observed(runner.name)?.busy === true })),
        ...runners.filter(runner => !known.has(runner.name) && (runner.labels ?? []).some(item => (typeof item === 'string' ? item : item.name) === label)).map(runner => ({ kind: 'foreign', snapshotComplete: true, online: runner.status === 'online', busy: runner.busy === true })),
      ];
      const supply = Object.values(supplyCounts(units.filter(unit => unit.kind === 'local'), this.now(), this.config)).reduce((a, b) => a + b, 0);
      const installation = await tx.get('pool:installation') ?? project.installation;
      const boatReserved = project.dispatchOnly === true ? boxes.filter(box => reservationActive(box, this.now())).map(box => box.dispatchJobId) : [];
      return { jobs: jobs.map(job => ({ ...job, repo: project.repo, installation, size: poolSize(project, label), createdAt: job.queuedAt })), supply, local, boatReserved, boatFence: mode === 'drain', poolMode: true, lanesOn: await this.lanesEnabled(tx) };
    }
    const jobs = (await all(tx, 'job:')).filter(job => job.label === label);
    const local = (await all(tx, 'local-runner:')).filter(runner => runner.label === label && active(runner));
    return { jobs: jobs.filter(queued), supply: jobs.filter(boatPending).length + local.filter(runner => localOfferActive(runner, this.now(), this.config)).length, local, boatFence: jobs.some(job => unresolvedBoat(job) || boatPending(job)) };
  }
  async allowBoat(tx, job) {
    if (this.config.localOnly?.includes(job.label)) return false;
    if (!this.enabled(job.label)) return true;
    const { jobs, supply, local } = await this.counts(tx, job.label);
    return jobs.length > supply;
  }
  async claim(label, host = null, diagnostics = null) {
    const reject = reason => { if (diagnostics) diagnostics.reason = reason; return null; };
    if (!this.enabled(label) || this.controller.env?.ENABLED !== 'true') return reject('project_disabled');
    const name = `local-${crypto.randomUUID()}`;
    const record = await this.storage.transaction(async tx => {
      if (this.controller.poolProject && (await tx.get('pool:mode')) !== 'on') return reject('project_disabled');
      if (labelLocal(this.config, await tx.get(LOCAL_MODE_KEY) ?? {}, label) !== 'on') return reject('local_disabled');
      const { jobs, supply, local, boatReserved = [], boatFence, poolMode, lanesOn = false } = await this.counts(tx, label);
      if (boatFence) return reject('boat_reserved');
      const candidates = jobs.filter(job => !boatReserved.includes(job.id) && !local.some(runner => runner.jobId === job.id)).sort(laneComparator(this.now(), lanesOn));
      if (!jobs.length) {
        const project = this.controller.poolProject;
        const recentBoat = project && (await all(tx, 'gh-job:')).some(job => job.pool === poolKey(project.repo, label) && job.status === 'in_progress' && job.runnerName?.startsWith('boat-') && Number.isFinite(job.startedAt) && this.now() - job.startedAt >= 0 && this.now() - job.startedAt < 30_000);
        return reject(recentBoat ? 'boat_assigned_recently' : 'no_runnable_job');
      }
      if (supply >= jobs.length || !candidates.length) return reject('local_claim_in_progress');
      const job = candidates[0];
      if (!Number.isSafeInteger(job.installation) || job.installation < 1) return reject('installation_missing');
      const epoch = this.controller.env.RESUME_EPOCH ?? '0';
      if ((await tx.get('blocked'))?.epoch === epoch) return reject('project_blocked');
      if ((await tx.get(`size-block:${job.size}`))?.epoch === epoch) return reject('size_blocked');
      const runner = { name, label, repo: job.repo, installation: job.installation, jobId: job.id, state: 'claiming', at: this.now(), ...(host ? { host } : {}) };
      await tx.put(`local-runner:${name}`, runner);
      return runner;
    });
    if (!record) return null;
    await this.controller.wake();
    try {
      const jit = await this.api.github(record, '/actions/runners/generate-jitconfig', { method: 'POST', body: { name, runner_group_id: 1, labels: [label], work_folder: '_work' } });
      if (!Number.isSafeInteger(jit.runner?.id) || typeof jit.encoded_jit_config !== 'string') throw new Error('invalid registration');
      await this.storage.transaction(async tx => {
        const current = await tx.get(`local-runner:${name}`);
        if (current?.state !== 'claiming') throw new Error('claim lost');
        await tx.put(`local-runner:${name}`, { ...current, runnerId: jit.runner.id, state: 'pending' });
      });
      return { name, label, class: this.config.labels[label], jitConfig: jit.encoded_jit_config };
    } catch (error) {
      const refused = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      await this.storage.transaction(async tx => {
        const current = await tx.get(`local-runner:${name}`);
        if (current?.state === 'claiming') await tx.put(`local-runner:${name}`, refused ? { ...current, state: 'retired', retiredAt: this.now() } : { ...current, state: 'retiring', retiringAt: this.now() });
      });
      await this.controller.wake();
      throw new Error(refused ? 'local registration refused' : 'local registration uncertain');
    }
  }
  async started(name) {
    return this.storage.transaction(async tx => {
      const runner = await tx.get(`local-runner:${name}`);
      if (runner && ['started', 'assigned', 'retired'].includes(runner.state)) return true;
      if (!runner || runner.state !== 'pending') return false;
      await tx.put(`local-runner:${name}`, { ...runner, state: 'started', startedAt: this.now() });
      return true;
    });
  }
  // the agent releases a lost runner with reason 'infra'; the mark is kept on the
  // record whatever its state and `lostRunners` turns it into one rerun of the job the runner was serving.
  async release(name, reason = null, detail = null) {
    const lost = reason === 'infra' ? { reason, at: this.now(), ...(typeof detail === 'string' && detail ? { detail } : {}) } : null;
    const runner = await this.storage.transaction(async tx => {
      const key = `local-runner:${name}`, stored = await tx.get(key);
      if (!stored) return null;
      const current = lost && !stored.lost ? { ...stored, lost } : stored;
      if (current.state === 'retired') { if (current !== stored) await tx.put(key, current); return current; }
      if (!active(current)) { if (current !== stored) await tx.put(key, current); return null; }
      await tx.put(key, { ...current, state: 'retiring', retiringAt: current.retiringAt ?? this.now() });
      return current;
    });
    if (!runner) return false;
    if (runner.state === 'retired') return true;
    const removed = await this.remove(name);
    if (removed) await this.controller.wake();
    return removed;
  }
  async remove(name) {
    const key = `local-runner:${name}`, runner = await this.storage.get(key);
    if (runner?.state !== 'retiring') return false;
    let id = runner.runnerId;
    if (!id) {
      if (this.now() - runner.at < 60_000) return false;
      let result;
      try { result = await this.api.github(runner, `/actions/runners?name=${encodeURIComponent(name)}&per_page=100`); } catch { return false; }
      if (!Array.isArray(result.runners) || result.runners.length >= 100) return false;
      const found = result.runners.filter(item => item.name === name);
      if (found.length > 1 || found.some(item => item.busy || item.status === 'online')) return false;
      if (found.length) { id = found[0]?.id; if (!Number.isSafeInteger(id) || id < 1) return false; }
    }
    if (id) {
      try {
        const current = await this.api.runner({ ...runner, runnerId: id });
        if (current.busy) return false;
        await this.api.removeRunner({ ...runner, runnerId: id });
      } catch (error) { if (error.status !== 404) return false; }
    }
    return this.storage.transaction(async tx => {
      const current = await tx.get(key);
      if (current?.state !== 'retiring') return false;
      await tx.put(key, { ...current, state: 'retired', retiredAt: this.now() });
      return true;
    });
  }
  async ingest(event) {
    if (!event.runnerName) return;
    await this.storage.transaction(async tx => {
      const key = `local-runner:${event.runnerName}`, runner = await tx.get(key);
      if (!runner || runner.repo !== event.repo || runner.label !== event.label) return;
      if (event.status === 'in_progress' && active(runner)) await tx.put(key, { ...runner, state: 'assigned', assignedJobId: event.id });
      if (event.status === 'completed' && runner.assignedJobId === event.id) await tx.put(key, { ...runner, state: 'retired', completedAt: this.now() });
    });
  }
  async patch(name, fields) {
    await this.storage.transaction(async tx => {
      const key = `local-runner:${name}`, current = await tx.get(key);
      if (current) await tx.put(key, { ...current, ...fields });
    });
  }
  // One rerun for a job whose local runner was lost: the agent's infra report (`lost` on the record), or, for a
  // failed job on a local runner with no report, GitHub's "lost communication with the server" annotation (checked
  // once per runner). A job that completed green, or a red job without either signal, is never re-run.
  async lostRunners(runners = null) {
    const project = this.controller.poolProject;
    if (!project || this.config.rerunLost === false) return [];
    const now = this.now();
    const candidates = (runners ?? await all(this.storage, 'local-runner:')).filter(runner => runner.lost ? !runner.lostHandled : (!runner.lostCheck && Number.isFinite(runner.at) && now - runner.at < LOCAL_LOST_CHECK_WINDOW_MS && ['started', 'assigned', 'retiring', 'retired'].includes(runner.state)));
    if (!candidates.length) return [];
    const jobs = await all(this.storage, 'gh-job:');
    const installation = await this.storage.get('pool:installation') ?? project.installation;
    const watchdog = new SetupWatchdog({ storage: this.storage, api: this.api, project, installation, now: this.now, logger: this.controller.logger ?? null, fleet: null });
    const outcomes = [];
    const request = async (runner, job, reason) => {
      const created = await watchdog.lostLocalRunner({ jobId: job.id, runId: job.runId, jobName: job.jobName, runnerName: runner.name, host: runner.host ?? null, reason });
      const outcome = created ? 'rerun_requested' : 'rerun_exists';
      await this.patch(runner.name, { lostHandled: true, lostOutcome: outcome, lostJobId: job.id, ...(runner.lost ? {} : { lost: { reason, at: now } }) });
      outcomes.push({ name: runner.name, jobId: job.id, outcome });
    };
    for (const runner of candidates) {
      const job = jobs.find(job => job.runnerName === runner.name && Number.isSafeInteger(job.id)) ?? (Number.isSafeInteger(runner.assignedJobId) ? jobs.find(job => job.id === runner.assignedJobId) : null);
      if (runner.lost) {
        if (!job || !['in_progress', 'completed'].includes(job.status)) {
          if (now - runner.lost.at >= LOCAL_LOST_WAIT_MS) { await this.patch(runner.name, { lostHandled: true, lostOutcome: 'no_job' }); outcomes.push({ name: runner.name, jobId: null, outcome: 'no_job' }); }
          continue;
        }
        if (job.status === 'completed' && job.conclusion !== 'failure') { await this.patch(runner.name, { lostHandled: true, lostOutcome: `job_${job.conclusion ?? 'completed'}`, lostJobId: job.id }); outcomes.push({ name: runner.name, jobId: job.id, outcome: `job_${job.conclusion ?? 'completed'}` }); continue; }
        await request(runner, job, runner.lost.reason);
        continue;
      }
      if (!job || job.status !== 'completed') continue;
      if (job.conclusion !== 'failure') { await this.patch(runner.name, { lostCheck: { at: now, lost: false, conclusion: job.conclusion ?? null } }); continue; }
      let annotations;
      try { annotations = await this.api.jobAnnotations({ repo: project.repo, installation }, job.id); }
      catch (error) { await this.patch(runner.name, { lostCheck: { at: now, lost: null, error: Number.isInteger(error?.status) ? error.status : 'request_failed' } }); this.controller.logger?.(JSON.stringify({ event: 'local_lost_check_failed', project: project.id, job_id: job.id, runner_name: runner.name, status: error?.status ?? null })); continue; }
      if (!Array.isArray(annotations) || !annotations.some(item => LOCAL_LOST_PATTERN.test(String(item?.message ?? '')))) { await this.patch(runner.name, { lostCheck: { at: now, lost: false, conclusion: 'failure' } }); continue; }
      await this.patch(runner.name, { lostCheck: { at: now, lost: true } });
      await request(runner, job, 'lost_communication');
    }
    return outcomes;
  }
  async sweep() {
    const runners = await all(this.storage, 'local-runner:');
    try { await this.lostRunners(runners); } catch { this.controller.logger?.(JSON.stringify({ event: 'local_lost_sweep_failed', project: this.controller.poolProject?.id ?? null })); }
    for (const runner of runners) {
      if (['claiming', 'pending', 'started'].includes(runner.state) && (this.controller.env?.CI_TO_MINIS === 'false' || !localOfferActive(runner, this.now(), this.config))) await this.release(runner.name);
      else if (runner.state === 'started' && this.config.registeredHoldSeconds > 0) {
        const job = this.controller.poolProject ? await this.storage.get(`gh-job:${runner.jobId}`) : await this.storage.get(`job:${runner.jobId}`);
        if (job && (this.controller.poolProject ? ['in_progress', 'completed'].includes(job.status) && job.runnerName !== runner.name : !queued(job))) await this.release(runner.name);
      }
      else if (runner.state === 'retiring') {
        const removed = await this.remove(runner.name);
        if (!removed && !runner.retiringAlertAt && this.now() - (runner.retiringAt ?? runner.at) >= (this.config.retireAlertSeconds ?? 300) * 1000) {
          await this.storage.transaction(async tx => {
            const key = `local-runner:${runner.name}`, current = await tx.get(key);
            if (current?.state !== 'retiring' || current.retiringAlertAt) return;
            await this.controller.emit?.('alert_local_runner_retiring', { id: runner.jobId }, { runner_name: runner.name }, tx);
            await tx.put(key, { ...current, retiringAlertAt: this.now() });
          });
        }
      }
    }
    for (const label of new Set(runners.map(runner => runner.label))) {
      const { jobs, supply } = await this.storage.transaction(tx => this.counts(tx, label));
      let excess = Math.max(0, supply - jobs.length);
      for (const runner of runners) {
        if (!excess) break;
        if (runner.label !== label || !['pending', 'started'].includes(runner.state) || (runner.state === 'started' && this.config.registeredHoldSeconds > 0 && localOfferActive(runner, this.now(), this.config))) continue;
        if (await this.release(runner.name)) excess--;
      }
    }
  }
}
import { poolKey, supplyCounts, poolSize, localOfferActive } from './pool.mjs';
import { reservationActive } from './box-state.mjs';
import { SetupWatchdog, LOCAL_LOST_PATTERN } from './setup-watchdog.mjs';
// A lost mark waits this long for the job observation before it is dropped as "no job"; a failed job on a local
// runner is checked for the lost-communication annotation only while the runner record is this young.
export const LOCAL_LOST_WAIT_MS = 15 * 60_000;
export const LOCAL_LOST_CHECK_WINDOW_MS = 3 * 3600_000;

import { runnableDemand } from './workflow-demand.mjs';
