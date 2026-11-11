import { transition as applyBoxEvent } from './box-state.mjs';
// Setup watchdog for Actions JIT boxes. A job that is still in its setup
// steps N minutes after it started holds a pool slot and the run's gate (one
// observed job waited in "Set up runner" for 40 min).
// The watchdog reads fresh step state from GitHub (the pool snapshot drops
// `steps`), destroys the box, waits for GitHub to complete the cancelled
// job, and re-runs it through the App once the run has completed.
//
// Storage (all under the tenant's prefix):
//   setup-watchdog:<jobId>        one recovery per hung job (destroy → await_cancel → rerun → done | failed);
//                                 terminal records expire after SETUP_WATCHDOG_RECORD_TTL_MS.
//   setup-watchdog-check:<jobId>  the once-a-minute fetch throttle for a long job; deleted as soon as the job
//                                 is no longer in progress on a busy box, and after SETUP_WATCHDOG_CHECK_TTL_MS.
//   setup-watchdog-run:<runId>    per run: which run attempt each rerun call created and how many automatic
//                                 reruns each job name received (the cap across attempts).
//   switch:setup-watchdog         { mode: 'on' | 'off' }: the runtime switch (POST /router/setup-watchdog).
//
// a job whose local mini runner was lost mid-run (the local agent reported an
// infrastructure failure, or GitHub failed the job with "lost communication with the server") is re-run once
// through the same records: `lostLocalRunner` writes a `setup-watchdog:<jobId>` record with source `local_lost`
// in phase await_cancel; `recover` then waits for GitHub to complete the job and the run and re-runs the job under
// the same per-run, per-job-name cap (SETUP_WATCHDOG_RERUN_CAP). A real test failure never gets here: the local
// fleet only calls `lostLocalRunner` for an agent-reported loss or a lost-communication annotation.

export const SETUP_STEP_NAMES = Object.freeze(['Set up job', 'Set up runner', 'Initialize containers']);
export const SETUP_WATCHDOG_CHECK_MS = 60_000;
export const SETUP_WATCHDOG_RERUN_ATTEMPTS = 5;
export const SETUP_WATCHDOG_GIVE_UP_MS = 6 * 3600_000;
export const SETUP_WATCHDOG_RERUN_CAP = 1;
export const SETUP_WATCHDOG_RECORD_TTL_MS = 7 * 86400_000;
export const SETUP_WATCHDOG_CHECK_TTL_MS = 24 * 3600_000;
export const SETUP_WATCHDOG_SWITCH_KEY = 'switch:setup-watchdog';
export const SETUP_WATCHDOG_PREFIX = 'setup-watchdog:';
export const SETUP_WATCHDOG_CHECK_PREFIX = 'setup-watchdog-check:';
export const SETUP_WATCHDOG_RUN_PREFIX = 'setup-watchdog-run:';
export const LOCAL_LOST_PATTERN = /lost communication with the server/i;
const OPEN_PHASES = Object.freeze(['destroy', 'await_cancel', 'rerun']);

const isSetupStep = step => SETUP_STEP_NAMES.includes(step?.name);

// Decides from one fresh GitHub job view. Never true for a job whose later
// step has started or finished, for a job on another runner, or for a job
// that started less than `minutes` ago.
export function setupStuck(job, { now, minutes, runnerName, runAttempt = null }) {
  if (!job || job.status !== 'in_progress') return { stuck: false, reason: 'not_in_progress' };
  if (typeof runnerName !== 'string' || job.runner_name !== runnerName) return { stuck: false, reason: 'runner_mismatch' };
  if (runAttempt !== null && Number.isSafeInteger(job.run_attempt) && job.run_attempt !== runAttempt) return { stuck: false, reason: 'attempt_mismatch' };
  const started = Date.parse(job.started_at ?? '');
  if (!Number.isFinite(started) || !Number.isFinite(now) || !Number.isFinite(minutes) || minutes <= 0) return { stuck: false, reason: 'no_start_time' };
  if (now - started < minutes * 60_000) return { stuck: false, reason: 'within_budget' };
  const steps = Array.isArray(job.steps) ? job.steps : null;
  if (!steps || !steps.length) return { stuck: true, reason: 'no_steps', startedAt: started };
  const later = steps.filter(step => !isSetupStep(step));
  if (later.some(step => ['in_progress', 'completed'].includes(step?.status))) return { stuck: false, reason: 'later_step' };
  return { stuck: true, reason: 'setup_only', startedAt: started };
}

export function watchdogKey(jobId) { return `${SETUP_WATCHDOG_PREFIX}${jobId}`; }
export function watchdogCheckKey(jobId) { return `${SETUP_WATCHDOG_CHECK_PREFIX}${jobId}`; }
export function watchdogRunKey(runId) { return `${SETUP_WATCHDOG_RUN_PREFIX}${runId}`; }

// A GitHub error that may clear on its own (or that may have been applied although the response was lost).
export function transientRerunError(error) {
  const status = error?.status;
  return !Number.isInteger(status) || status === 408 || status === 429 || status >= 500;
}

export async function listRecords(storage, prefix) {
  const records = [];
  let cursor = '';
  for (;;) {
    const page = await storage.list({ prefix, startAfter: cursor, limit: 128 });
    records.push(...page.values());
    if (page.size < 128) break;
    cursor = [...page.keys()].at(-1);
  }
  return records;
}

export class SetupWatchdog {
  constructor({ storage, api, project, installation, now = Date.now, logger = null, fleet }) { Object.assign(this, { storage, api, project, installation, now, logger, fleet }); }

  log(event, data) { this.logger?.(JSON.stringify({ event, project: this.project?.id, ...data })); }

  // Config on, installation known, and the runtime switch not off.
  async enabled() {
    const minutes = this.project?.setupWatchdog?.minutes;
    if (this.project?.setupWatchdog?.enabled !== true || !Number.isFinite(minutes) || minutes <= 0 || !this.installation) return false;
    return (await this.storage.get(SETUP_WATCHDOG_SWITCH_KEY))?.mode !== 'off';
  }

  // Inspects busy boxes and starts a recovery for one stuck job per tick.
  async inspect(boxes, jobs) {
    if (!await this.enabled()) return null;
    const minutes = this.project.setupWatchdog.minutes;
    const now = this.now();
    await this.sweepChecks(boxes, jobs, now);
    for (const box of boxes) {
      if (box.state !== 'busy' || typeof box.runnerName !== 'string') continue;
      const job = jobs.find(item => item.status === 'in_progress' && item.runnerName === box.runnerName && Number.isSafeInteger(item.id));
      if (!job || !Number.isFinite(job.startedAt) || now - job.startedAt < minutes * 60_000) continue;
      if (await this.storage.get(watchdogKey(job.id))) continue;
      const checkKey = watchdogCheckKey(job.id), check = await this.storage.get(checkKey);
      if (Number.isFinite(check?.checkedAt) && now - check.checkedAt < SETUP_WATCHDOG_CHECK_MS) continue;
      await this.storage.put(checkKey, { jobId: job.id, machineId: box.machineId, runnerName: box.runnerName, checkedAt: now, ...(check?.reason ? { reason: check.reason } : {}) });
      let actual;
      try { actual = await this.api.getJob({ repo: this.project.repo, installation: this.installation, id: job.id }, job.id); }
      catch { continue; }
      if (actual?.id !== job.id) continue;
      const verdict = setupStuck(actual, { now, minutes, runnerName: box.runnerName, runAttempt: job.runAttempt ?? null });
      if (!verdict.stuck) {
        if (actual.status !== 'in_progress' || actual.runner_name !== box.runnerName) await this.storage.delete(checkKey);
        else await this.storage.put(checkKey, { jobId: job.id, machineId: box.machineId, runnerName: box.runnerName, checkedAt: now, reason: verdict.reason });
        continue;
      }
      const runId = Number.isSafeInteger(actual.run_id) ? actual.run_id : job.runId ?? null;
      const jobName = typeof actual.name === 'string' && actual.name ? actual.name : typeof job.jobName === 'string' && job.jobName ? job.jobName : null;
      const started = await this.storage.transaction(async tx => {
        const current = await tx.get(`box:${box.machineId}`);
        if (!current || current.state !== 'busy' || current.runnerName !== box.runnerName) return false;
        await tx.put(`box:${box.machineId}`, applyBoxEvent(current, 'setup_hang', { retirementReason: 'setup_hang', forceDestroy: true, setupHangJobId: job.id }, now));
        await tx.put(watchdogKey(job.id), { phase: 'destroy', jobId: job.id, jobName, runId, runAttempt: Number.isSafeInteger(actual.run_attempt) ? actual.run_attempt : null, machineId: box.machineId, runnerName: box.runnerName, reason: verdict.reason, startedAt: verdict.startedAt, decidedAt: now, attempts: 0, transientErrors: 0 });
        await tx.delete(checkKey);
        return true;
      });
      if (!started) continue;
      this.log('setup_watchdog_destroy', { job_id: job.id, run_id: runId, job_name: jobName, machine_id: box.machineId, runner_name: box.runnerName, reason: verdict.reason, waited_ms: now - verdict.startedAt });
      await this.fleet?.verificationOutcome?.(box, 'setup_hang', false, { step: 'setup watchdog', exitCode: null, output: '' });
      return { jobId: job.id, machineId: box.machineId };
    }
    return null;
  }

  // A check record lives only while its job is in progress on a busy box.
  async sweepChecks(boxes, jobs, now) {
    const busy = new Set(boxes.filter(box => box.state === 'busy' && typeof box.runnerName === 'string').map(box => box.runnerName));
    const live = new Set(jobs.filter(job => job.status === 'in_progress' && busy.has(job.runnerName) && Number.isSafeInteger(job.id)).map(job => job.id));
    for (const check of await listRecords(this.storage, SETUP_WATCHDOG_CHECK_PREFIX)) {
      if (live.has(check?.jobId) && Number.isFinite(check.checkedAt) && now - check.checkedAt < SETUP_WATCHDOG_CHECK_TTL_MS) continue;
      await this.storage.delete(watchdogCheckKey(check?.jobId));
    }
  }

  // Advances open recoveries: wait for the box to leave, wait for GitHub to
  // complete the job and the run, then re-run the job once per job name and run.
  async recover() {
    if (!await this.enabled()) return;
    const now = this.now();
    for (const record of await listRecords(this.storage, SETUP_WATCHDOG_PREFIX)) {
      if (!Number.isSafeInteger(record?.jobId)) continue;
      const key = watchdogKey(record.jobId);
      if (!OPEN_PHASES.includes(record.phase)) {
        const endedAt = record.doneAt ?? record.failedAt ?? record.decidedAt;
        if (!Number.isFinite(endedAt) || now - endedAt >= SETUP_WATCHDOG_RECORD_TTL_MS) await this.storage.delete(key);
        continue;
      }
      if (Number.isFinite(record.decidedAt) && now - record.decidedAt > SETUP_WATCHDOG_GIVE_UP_MS) { await this.storage.put(key, { ...record, phase: 'failed', failedAt: now, failure: 'timeout' }); this.log('setup_watchdog_failed', { job_id: record.jobId, run_id: record.runId, failure: 'timeout' }); continue; }
      if (Number.isFinite(record.pollAt) && now - record.pollAt < SETUP_WATCHDOG_CHECK_MS) continue;
      await this.storage.put(key, { ...record, pollAt: now });
      if (record.phase === 'destroy') {
        const box = await this.storage.get(`box:${record.machineId}`);
        if (box && box.state === 'destroying') continue;
        await this.storage.put(key, { ...record, phase: 'await_cancel', pollAt: now, boxLeftAt: now });
        continue;
      }
      const job = { repo: this.project.repo, installation: this.installation };
      if (record.phase === 'await_cancel') {
        let actual;
        try { actual = await this.api.getJob(job, record.jobId); } catch { continue; }
        if (actual?.id !== record.jobId) continue;
        if (actual.status !== 'completed') continue;
        if (!record.runId) { await this.storage.put(key, { ...record, phase: 'failed', failedAt: now, failure: 'no_run_id', conclusion: actual.conclusion ?? null }); continue; }
        let run;
        try { run = await this.api.getRun(job, record.runId); } catch { continue; }
        if (run?.status !== 'completed') continue;
        Object.assign(record, { phase: 'rerun', pollAt: now, conclusion: actual.conclusion ?? null, runAttempt: Number.isSafeInteger(run.run_attempt) ? run.run_attempt : record.runAttempt, cancelledObservedAt: now });
        await this.storage.put(key, record);
      }
      if (record.phase === 'rerun') await this.rerun(record, job, now);
    }
    for (const runRecord of await listRecords(this.storage, SETUP_WATCHDOG_RUN_PREFIX)) {
      if (Number.isSafeInteger(runRecord?.runId) && (!Number.isFinite(runRecord.at) || now - runRecord.at >= SETUP_WATCHDOG_RECORD_TTL_MS)) await this.storage.delete(watchdogRunKey(runRecord.runId));
    }
  }

  jobName(record) { return record.jobName ?? `job:${record.jobId}`; }

  // A lost local runner: one recovery per job, no box to destroy, straight to await_cancel.
  async lostLocalRunner({ jobId, runId, jobName = null, runnerName, host = null, reason }) {
    if (!Number.isSafeInteger(jobId) || typeof runnerName !== 'string' || !runnerName.startsWith('local-')) return false;
    const now = this.now(), key = watchdogKey(jobId);
    const created = await this.storage.transaction(async tx => {
      if (await tx.get(key)) return false;
      await tx.put(key, { phase: 'await_cancel', source: 'local_lost', jobId, jobName: typeof jobName === 'string' && jobName ? jobName : null, runId: Number.isSafeInteger(runId) ? runId : null, runAttempt: null, machineId: null, runnerName, host, reason, decidedAt: now, boxLeftAt: now, attempts: 0, transientErrors: 0 });
      return true;
    });
    if (created) this.log('local_runner_lost', { job_id: jobId, run_id: Number.isSafeInteger(runId) ? runId : null, job_name: jobName ?? null, runner_name: runnerName, host, reason });
    return created;
  }

  async rerun(record, job, now) {
    const key = watchdogKey(record.jobId), runKey = watchdogRunKey(record.runId);
    const name = this.jobName(record);
    let runRecord = await this.storage.get(runKey) ?? { runId: record.runId, at: now, claims: {}, reruns: {} };
    let run;
    try { run = await this.api.getRun(job, record.runId); } catch { return; }
    if (Number.isSafeInteger(run?.run_attempt) && Number.isSafeInteger(record.runAttempt) && run.run_attempt > record.runAttempt) {
      // A newer attempt exists. It is this job's rerun unless another recovery of the run created it (then this job
      // still waits for the run to complete and is re-run on its own), or unless the call was never ours to make.
      const claimant = runRecord.claims[String(run.run_attempt)];
      if (claimant === undefined || claimant === record.jobId) {
        if (claimant === undefined) {
          runRecord = { ...runRecord, claims: { ...runRecord.claims, [run.run_attempt]: record.jobId }, reruns: { ...runRecord.reruns, [name]: (runRecord.reruns[name] ?? 0) + 1 } };
          await this.storage.put(runKey, runRecord);
        }
        await this.storage.put(key, { ...record, phase: 'done', doneAt: now, rerunAttempt: run.run_attempt });
        this.log('setup_watchdog_rerun', { job_id: record.jobId, run_id: record.runId, job_name: record.jobName ?? null, run_attempt: run.run_attempt, observed: true, source: record.source ?? 'setup_hang' });
        return;
      }
      if (run.status !== 'completed') return;
      record = { ...record, runAttempt: run.run_attempt, supersededBy: claimant };
      await this.storage.put(key, record);
    }
    if (run?.status !== 'completed') return;
    if ((runRecord.reruns[name] ?? 0) >= SETUP_WATCHDOG_RERUN_CAP) {
      await this.storage.put(key, { ...record, phase: 'failed', failedAt: now, failure: 'rerun_cap', reruns: runRecord.reruns[name] });
      this.log('setup_watchdog_failed', { job_id: record.jobId, run_id: record.runId, job_name: record.jobName ?? null, failure: 'rerun_cap', reruns: runRecord.reruns[name], source: record.source ?? 'setup_hang' });
      await this.fleet?.emit?.('alert_setup_watchdog_cap', null, { run_id: record.runId, job_id: record.jobId, job_name: record.jobName ?? null, reruns: runRecord.reruns[name] });
      this.fleet?.alert?.('setup_watchdog_cap', { value: 1, limit: 1, active: true, window: String(record.runId) });
      return;
    }
    if ((record.attempts ?? 0) >= SETUP_WATCHDOG_RERUN_ATTEMPTS) {
      await this.storage.put(key, { ...record, phase: 'failed', failedAt: now, failure: 'rerun_refused' });
      this.log('setup_watchdog_failed', { job_id: record.jobId, run_id: record.runId, failure: 'rerun_refused' });
      return;
    }
    const expected = Number.isSafeInteger(record.runAttempt) ? record.runAttempt + 1 : null;
    await this.storage.put(key, { ...record, rerunCalledAt: now });
    try { await this.api.rerunJob(job, record.jobId); }
    catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : null;
      if (transientRerunError(error)) {
        // The call may have been applied: the next poll settles it through the run attempt and the claims above.
        await this.storage.put(key, { ...record, rerunCalledAt: now, transientErrors: (record.transientErrors ?? 0) + 1, lastRerunStatus: status });
        this.log('setup_watchdog_rerun_error', { job_id: record.jobId, run_id: record.runId, status, transient: true });
        return;
      }
      await this.storage.put(key, { ...record, rerunCalledAt: now, attempts: (record.attempts ?? 0) + 1, lastRerunStatus: status });
      this.log('setup_watchdog_rerun_error', { job_id: record.jobId, run_id: record.runId, status, transient: false });
      return;
    }
    runRecord = { ...runRecord, ...(expected !== null ? { claims: { ...runRecord.claims, [expected]: record.jobId } } : {}), reruns: { ...runRecord.reruns, [name]: (runRecord.reruns[name] ?? 0) + 1 } };
    await this.storage.put(runKey, runRecord);
    await this.storage.put(key, { ...record, attempts: (record.attempts ?? 0) + 1, rerunCalledAt: now, phase: 'done', doneAt: now, rerunAttempt: expected });
    this.log('setup_watchdog_rerun', { job_id: record.jobId, run_id: record.runId, job_name: record.jobName ?? null, run_attempt: expected, observed: false, source: record.source ?? 'setup_hang' });
  }
}
