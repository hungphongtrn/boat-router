// the box lifecycle as an explicit machine. Timeouts for every state that can hang, and the
// three bugs the state-machine report named: stale supply, lease-warm boxes in the cap, wrong retirements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet, DOCKER_REUSE_KEY } from '../src/router/box-fleet.mjs';
import { DEADLINES, RESERVATION_MS, MISSING_RESULT_GRACE_MS, RUNNER_GONE_GRACE_MS } from '../src/router/box-state.mjs';
import { laneUsage } from '../src/router/lanes.mjs';
import { WarmLeaseFence } from '../src/router/external-leases.mjs';
import { SetupWatchdog } from '../src/router/setup-watchdog.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';

const REPO = 'a/b', LABEL = 'boat-large', POOL = JSON.stringify([REPO, LABEL]), ID = 'bx_23456789';
const project = extra => ({ id: 'demo', repo: REPO, labels: [LABEL], sizes: { [LABEL]: { machine: 'large' } }, reuse: { mode: 'on' }, caps: {}, ...extra });
const account = extra => ({ reuse: { enabled: true }, waitForBusyBox: { enabled: true, maxWaitMs: 180_000, scarcityFrom: 0.5, scarcityFull: 0.95 }, ...extra });

function harness({ api = {}, now = 10_000_000, cfg = project(), emit = true } = {}) {
  const clock = { now }, storage = new Storage(), alerts = [], logs = [];
  const fleet = new BoxFleet(storage, api, () => clock.now, { project: cfg, budget: {}, installation: 1, logger: line => logs.push(JSON.parse(line)), ...(emit ? { emit: async (event, job, detail) => { alerts.push({ event, ...detail }); } } : {}) });
  return { clock, storage, fleet, alerts, logs, box: () => storage.get(`box:${ID}`) };
}
const stuck = (h, reason) => h.alerts.filter(alert => alert.event === 'alert_box_stuck' && alert.status === reason);

test('timeout: a quarantined box whose runner never becomes certain leaves after an hour', async () => {
  const h = harness({ api: { sandbox: async () => { throw Object.assign(new Error(), { status: 500 }); }, destroy: async () => ({ operation: { id: 'op' } }) } });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'quarantined', since: h.clock.now, failureReason: 'registration_uncertain', runnerId: null });
  const view = { complete: true, runners: [], jobs: [] };
  h.clock.now += DEADLINES.quarantined.afterMs - 1;
  await h.fleet.stepBox(ID, view);
  assert.equal((await h.box()).state, 'quarantined');
  h.clock.now += 1;
  await h.fleet.stepBox(ID, view);
  const box = await h.box();
  assert.equal(box.state, 'destroying'); assert.equal(box.exitReason, 'quarantine_timeout'); assert.equal(box.forceDestroy, undefined, 'not forced: a runner that appears is still fenced first');
  assert.equal(stuck(h, 'quarantine_timeout').length, 1);
  assert.equal(h.logs.at(-1).event, 'box_stuck');
  await h.fleet.stepBox(ID, view);
  assert.equal((await h.box()).state, 'purging', 'with no runner the provider delete runs at once');
});

test('timeout: destroying with a registered, unfenced runner is forced after ten minutes and alerts once', async () => {
  const calls = [];
  const h = harness({ api: { destroy: async () => { calls.push('destroy'); return { operation: { id: 'op' } }; }, removeRunner: async () => { calls.push('runner'); } } });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'destroying', since: h.clock.now, runnerId: 9, runnerName: 'r', runnerFenced: false });
  await h.fleet.stepBox(ID, { complete: true, runners: [], jobs: [] });
  assert.equal((await h.box()).state, 'destroying'); assert.deepEqual(calls, []);
  h.clock.now += DEADLINES.destroying.afterMs;
  await h.fleet.stepBox(ID, { complete: true, runners: [], jobs: [] });
  let box = await h.box();
  assert.equal(box.forceDestroy, true); assert.equal(stuck(h, 'destroy_timeout').length, 1);
  await h.fleet.stepBox(ID, { complete: true, runners: [], jobs: [] });
  box = await h.box();
  assert.equal(box.state, 'unregister'); assert.deepEqual(calls, ['destroy']);
  await h.fleet.stepBox(ID, { complete: true, runners: [], jobs: [] });
  assert.equal((await h.box()).state, 'purging'); assert.deepEqual(calls, ['destroy', 'runner']);
  h.clock.now += DEADLINES.destroying.afterMs * 3;
  assert.equal(stuck(h, 'destroy_timeout').length, 1, 'one alert per stay');
});

test('timeout: an unregister that GitHub refuses (runner busy) alerts after ten minutes and keeps retrying', async () => {
  let attempts = 0;
  const h = harness({ api: { removeRunner: async () => { attempts++; throw Object.assign(new Error(), { status: 422 }); } } });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'unregister', since: h.clock.now, runnerId: 9, operationId: 'op' });
  await h.fleet.stepBox(ID, {});
  h.clock.now += DEADLINES.unregister.afterMs;
  await h.fleet.stepBox(ID, {});
  assert.equal(stuck(h, 'unregister_timeout').length, 1);
  await h.fleet.stepBox(ID, {});
  await h.fleet.stepBox(ID, {});
  assert.equal(attempts, 3); assert.equal((await h.box()).state, 'unregister'); assert.equal(stuck(h, 'unregister_timeout').length, 1);
});

test('timeout: a purge whose deletion never completes alerts, then a sandbox 404 ends the record', async () => {
  let sandboxGone = false;
  const h = harness({ api: { deletion: async () => ({ operation: { id: 'other', status: 'pending' } }), sandbox: async () => { if (sandboxGone) throw Object.assign(new Error(), { status: 404 }); return { sandbox: {} }; } } });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'purging', since: h.clock.now, operationId: 'op', runnerFenced: true });
  await h.fleet.stepBox(ID, {});
  assert.equal((await h.box()).state, 'purging');
  h.clock.now += DEADLINES.purging.afterMs;
  await h.fleet.stepBox(ID, {});
  assert.equal(stuck(h, 'purge_timeout').length, 1);
  await h.fleet.stepBox(ID, {});
  assert.equal((await h.box()).state, 'purging', 'the sandbox still exists');
  sandboxGone = true;
  await h.fleet.stepBox(ID, {});
  const box = await h.box();
  assert.equal(box.state, 'deleted'); assert.equal(box.deletedBy, 'sandbox_404');
  assert.equal(box.history.at(-1).event, 'purged');
});

test('timeout: a retirement whose fence keeps failing alerts after ten minutes and still retries every tick', async () => {
  let attempts = 0;
  const h = harness({ api: { removeRunner: async () => { attempts++; throw Object.assign(new Error(), { status: 500 }); } } });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'retiring', since: h.clock.now, runnerId: 9, retirementReason: 'idle_hold_expired' });
  await h.fleet.stepBox(ID, {});
  h.clock.now += DEADLINES.retiring.afterMs;
  await h.fleet.stepBox(ID, {});
  await h.fleet.stepBox(ID, {});
  assert.equal(stuck(h, 'retire_timeout').length, 1); assert.equal(attempts, 2); assert.equal((await h.box()).state, 'retiring');
});

test('timeout: an expired reservation is released through its own event (dispatch-only pool)', async () => {
  const cfg = project({ dispatchOnly: true, reuse: { mode: 'off' } });
  const clock = { now: 10_000_000 }, storage = new Storage();
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [{ id: 7, name: 'boat-test', status: 'online', busy: false }] });
  await storage.put('gh-job:1', { id: 1, pool: POOL, status: 'queued', queuedAt: 1, observedAt: 1, source: 'webhook' });
  await storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'idle', since: clock.now, runnerId: 7, runnerName: 'boat-test', createdAt: clock.now, dispatchJobId: 1, dispatchAt: clock.now });
  const fleet = new BoxFleet(storage, { removeRunner: async () => {} }, () => clock.now, { budget: new SharedBudget(new AccountLedger(new Storage(), {}, () => clock.now), cfg.id, () => clock.now), project: cfg, installation: 1 });
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account: {}, project: cfg, preprepared: true };
  clock.now += RESERVATION_MS - 1;
  await fleet.tick(opts);
  assert.equal((await storage.get(`box:${ID}`)).state, 'idle', 'reserved and within the hold');
  clock.now += 1;
  await fleet.tick(opts);
  assert.equal((await storage.get(`box:${ID}`)).state, 'local-fencing');
  await fleet.tick(opts);
  const box = await storage.get(`box:${ID}`);
  assert.equal(box.state, 'local-held');
  assert.deepEqual(box.history.map(entry => entry.event), ['reservation_timeout', 'local_fenced']);
  assert.equal(box.reservationExpiredJobId, 1);
});

// the wait-for-busy guard retired two healthy boxes after cancelled jobs.
test('wrong retirement: a cancelled job neither guards nor slows a box; the box resets', async () => {
  const run = async (conclusion, extra = {}) => {
    const h = harness({ now: 1_000_000, api: { lightReset: async () => ({ processId: 5 }) } });
    await h.storage.put('pool:migrated', { done: true });
    await h.storage.put('pool:snapshot', { at: h.clock.now, complete: true, runners: [] });
    await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'finished', since: 0, createdAt: 0, runnerName: 'runner', runnerFenced: true, reusable: true, baselineHash: 'abc', generation: 0, jobs: 1 });
    await h.storage.put('gh-job:1', { id: 1, pool: POOL, status: 'completed', runnerName: 'runner', conclusion, queuedAt: 0, ...extra });
    await h.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: account(), project: project() });
    return h.box();
  };
  const cancelled = await run('cancelled', { durationRecorded: false, slowBox: true });
  assert.equal(cancelled.state, 'resetting', 'cancelled while queued (no duration) is not a missing result');
  const skipped = await run('skipped');
  assert.equal(skipped.state, 'resetting');
  const slow = await run('success', { durationRecorded: true, slowBox: true });
  assert.equal(slow.state, 'destroying'); assert.equal(slow.retirementReason, 'slow_job');
  const timedOut = await run('timed_out', { durationRecorded: true, slowBox: true });
  assert.equal(timedOut.retirementReason, 'slow_job');
  const unrecorded = await run('success', { durationRecorded: false });
  assert.equal(unrecorded.retirementReason, 'missing_job_result', 'a success with no usable timestamps is still a missing result');
});

test('wrong retirement: a long cancelled job is not recorded as a slow box', async () => {
  const { recordDuration } = await import('../src/router/wait-for-busy.mjs');
  const storage = new Storage();
  await storage.put(`wait-history:${POOL}`, { all: [100], names: { [JSON.stringify('t')]: [100] } });
  const cancelled = { pool: POOL, jobName: 't', conclusion: 'cancelled', startedAt: 0, completedAt: 100_000 };
  await recordDuration(storage, cancelled);
  assert.equal(cancelled.slowBox, undefined); assert.equal(cancelled.durationRecorded, true);
  const slow = { pool: POOL, jobName: 't', conclusion: 'success', startedAt: 0, completedAt: 100_000 };
  await recordDuration(storage, slow);
  assert.equal(slow.slowBox, true);
});

// Report B, box lifecycle, "likely" bug: the runner leaves a few seconds before GitHub lists the completed
// job; the box was destroyed as missing_job_result in the same step. It now waits for the listing.
test('wrong retirement: a reusable box whose runner left before its job was listed waits for the result', async () => {
  const resets = [];
  const h = harness({ now: 1_000_000, api: { lightReset: async () => { resets.push(1); return { processId: 5 }; }, removeRunner: async () => {} } });
  await h.storage.put('pool:migrated', { done: true });
  await h.storage.put('pool:snapshot', { at: h.clock.now, complete: true, runners: [] });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'busy', since: h.clock.now - 60_000, createdAt: 0, runnerName: 'runner', runnerId: 3, reusable: true, baselineHash: 'abc', generation: 0, jobs: 0, everOnline: true });
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account: account(), project: project() };
  await h.fleet.tick(opts);
  let box = await h.box();
  assert.equal(box.state, 'finished', 'no job listed yet: wait'); assert.equal(box.awaitingResultSince, h.clock.now);
  assert.equal(box.history.at(-1).event, 'runner_gone');
  h.clock.now += 10_000;
  await h.fleet.tick(opts);
  box = await h.box();
  assert.equal(box.state, 'finished'); assert.equal(box.awaitingResultSince, h.clock.now - 10_000, 'the wait clock is not restarted');
  await h.storage.put('gh-job:1', { id: 1, pool: POOL, status: 'completed', runnerName: 'runner', conclusion: 'success', durationRecorded: true, queuedAt: 0 });
  await h.fleet.tick(opts);
  box = await h.box();
  assert.equal(box.state, 'resetting'); assert.equal(resets.length, 1); assert.equal(box.awaitingResultSince, null);
});

test('wrong retirement: the wait for a missing result ends after its grace', async () => {
  const h = harness({ now: 1_000_000, api: { lightReset: async () => ({ processId: 5 }) } });
  await h.storage.put('pool:migrated', { done: true });
  await h.storage.put('pool:snapshot', { at: h.clock.now, complete: true, runners: [] });
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'finished', since: h.clock.now, createdAt: 0, runnerName: 'runner', runnerFenced: true, reusable: true, baselineHash: 'abc', generation: 0, jobs: 1 });
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account: account(), project: project() };
  h.clock.now += MISSING_RESULT_GRACE_MS - 1;
  await h.fleet.tick(opts);
  assert.equal((await h.box()).state, 'finished');
  h.clock.now += 1;
  await h.fleet.tick(opts);
  const box = await h.box();
  assert.equal(box.state, 'destroying'); assert.equal(box.retirementReason, 'missing_job_result');
});

// Stale supply (KEEP pool-cutover 20:51Z): a record says busy, the GitHub runner is gone (404) and the job it
// still lists is not ending. For RUNNER_GONE_GRACE_MS the absence reads as the job list lagging the runner list
// (the box is supply, it resets next); after that the record is stale and is not supply, whatever the
// wait-for-busy switch says. The tick stamps `runnerAbsentSince` on the first absence and clears it on return.
test('stale supply: a busy record whose runner has been gone longer than the grace is not supply', async () => {
  const docker = project({ dockerAccess: true, reuse: { mode: 'on', docker: true } });
  const inProgress = { id: 1, status: 'in_progress', runnerName: 'runner', queuedAt: 0, startedAt: 1 };
  const queued = { id: 2, status: 'queued', queuedAt: 1 };
  const run = async ({ runners, jobs, waitForBusyBox, absentForMs = null, tick = false }) => {
    const h = harness({ now: 1_000_000, cfg: docker });
    await h.storage.put(DOCKER_REUSE_KEY, { [LABEL]: 'on' });
    await h.storage.put('pool:migrated', { done: true });
    await h.storage.put('pool:snapshot', { at: h.clock.now, complete: true, runners });
    for (const job of jobs) await h.storage.put(`gh-job:${job.id}`, { pool: POOL, source: 'snapshot', observedAt: h.clock.now, ...job });
    await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, originPool: POOL, size: 'large', state: 'busy', since: h.clock.now - 60_000, createdAt: 0, runnerName: 'runner', runnerId: 3, reusable: true, resetMode: 'docker', baselineHash: 'abc', generation: 0, jobs: 0, everOnline: true, machineTtlSeconds: 7200, ...(absentForMs === null ? {} : { runnerAbsentSince: h.clock.now - absentForMs }) });
    const acct = account({ waitForBusyBox: { enabled: waitForBusyBox } });
    const plan = await h.fleet.tick({ mode: 'shadow', project: docker, account: acct });
    if (tick) await h.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: docker, account: acct, preprepared: true, skipAdmission: true });
    return { S: plan[POOL].S, box: await h.box() };
  };
  const fresh = await run({ runners: [], jobs: [inProgress, queued], waitForBusyBox: false, tick: true });
  assert.equal(fresh.S, 1, 'a runner that just left is the job list lagging: supply'); assert.equal(fresh.box.runnerAbsentSince, 1_000_000, 'the absence is stamped');
  const lagging = await run({ runners: [], jobs: [inProgress, queued], waitForBusyBox: false, absentForMs: RUNNER_GONE_GRACE_MS - 1 });
  assert.equal(lagging.S, 1);
  const stale = await run({ runners: [], jobs: [inProgress, queued], waitForBusyBox: false, absentForMs: RUNNER_GONE_GRACE_MS });
  assert.equal(stale.S, 0, 'past the grace the record is stale');
  assert.equal((await run({ runners: [], jobs: [inProgress, queued], waitForBusyBox: true, absentForMs: RUNNER_GONE_GRACE_MS })).S, 0, 'independent of the guard');
  const back = await run({ runners: [{ name: 'runner', status: 'online', busy: true }], jobs: [inProgress, queued], waitForBusyBox: false, absentForMs: RUNNER_GONE_GRACE_MS, tick: true });
  assert.equal(back.box.runnerAbsentSince, null, 'a runner that is listed again clears the stamp');
  const done = { id: 1, status: 'completed', runnerName: 'runner', conclusion: 'success', durationRecorded: true, queuedAt: 0, startedAt: 0, completedAt: 1 };
  assert.equal((await run({ runners: [], jobs: [queued, done], waitForBusyBox: true, absentForMs: RUNNER_GONE_GRACE_MS * 2 })).S, 1, 'a listed result makes the finishing box supply');
  assert.equal((await run({ runners: [{ name: 'runner', status: 'online', busy: false }], jobs: [queued], waitForBusyBox: false })).S, 1, 'a present, idle runner means the job just ended');
});

// a lease lease-warm box counted against the Project A pool cap and read as lane `none`.
test('lease boxes count toward the total cap but not lane usage', async () => {
  const h = harness({ cfg: project({ caps: { concurrent: 1 } }) });
  await h.storage.put('box:bx_lease', { machineId: 'bx_lease', pool: POOL, state: 'lease-warm', since: 0, leaseClient: 'lease' });
  assert.equal(await h.fleet.concurrentCapReached(h.fleet.project), true);
  await h.storage.put('box:bx_leased', { machineId: 'bx_leased', pool: POOL, state: 'leased', since: 0, leaseClient: 'lease' });
  assert.equal(await h.fleet.concurrentCapReached(h.fleet.project), true);
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'ready', since: 0 });
  assert.equal(await h.fleet.concurrentCapReached(h.fleet.project), true, 'a pool box still counts');
  const pending = harness({ cfg: project({ caps: { concurrent: 1 } }) });
  pending.fleet.countLeaseStarts = async () => 1;
  assert.equal(await pending.fleet.concurrentCapReached(pending.fleet.project), true, 'an unresolved lease start holds a slot');
  const boxes = [...(await h.storage.list({ prefix: 'box:' })).values()];
  assert.deepEqual(laneUsage(boxes.map(box => ({ ...box, lane: box.state === 'ready' ? 'manual' : null })), []), { manual: 1 });
  // Lease and leaving boxes both hold the total slot.
  const creates = async other => {
    const cfg = project({ caps: { concurrent: 1 }, reuse: { mode: 'off' } });
    const clock = { now: 10_000_000 }, storage = new Storage();
    await storage.put('pool:migrated', { done: true });
    await storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [] });
    await storage.put('gh-job:1', { id: 1, pool: POOL, status: 'queued', queuedAt: 1, observedAt: 1, source: 'webhook' });
    await storage.put('box:bx_other', { machineId: 'bx_other', pool: POOL, since: 0, ...other });
    const budget = new SharedBudget(new AccountLedger(new Storage(), {}, () => clock.now), cfg.id, () => clock.now);
    const fleet = new BoxFleet(storage, {}, () => clock.now, { budget, project: cfg, installation: 1 });
    await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: cfg, prepareOnly: true });
    return (await storage.list({ prefix: 'create:' })).size;
  };
  assert.equal(await creates({ state: 'lease-warm', leaseClient: 'lease' }), 0, 'the lease holds the total slot');
  assert.equal(await creates({ state: 'leased', leaseClient: 'lease' }), 0);
  assert.equal(await creates({ state: 'destroying' }), 0, 'a leaving pool box still holds the slot');
});

test('writers outside box-fleet leave the same trail: setup watchdog and external leases', async () => {
  const now = 10_000_000;
  const storage = new Storage();
  await storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'busy', since: now - 20 * 60_000, runnerName: 'r', runnerId: 1, createdAt: 0 });
  const job = { id: 5, pool: POOL, status: 'in_progress', runnerName: 'r', startedAt: now - 15 * 60_000, runId: 9, runAttempt: 1 };
  const api = { getJob: async () => ({ id: 5, status: 'in_progress', runner_name: 'r', run_id: 9, run_attempt: 1, started_at: new Date(now - 15 * 60_000).toISOString(), steps: [{ name: 'Set up job', status: 'in_progress', started_at: new Date(now - 15 * 60_000).toISOString() }] }) };
  const watchdog = new SetupWatchdog({ storage, api, project: { id: 'demo', repo: REPO, setupWatchdog: { enabled: true, minutes: 10 } }, installation: 1, now: () => now, logger: () => {} });
  const result = await watchdog.inspect([await storage.get(`box:${ID}`)], [job]);
  assert.deepEqual(result, { jobId: 5, machineId: ID });
  const box = await storage.get(`box:${ID}`);
  assert.equal(box.state, 'destroying'); assert.equal(box.exitReason, 'setup_hang'); assert.equal(box.timing.destroying, now);
  assert.deepEqual(box.history.at(-1), { event: 'setup_hang', from: 'busy', to: 'destroying', at: now });

  const root = new Storage(), key = 'project:demo:box:bx_abcdefgh';
  await root.put(key, { machineId: 'bx_abcdefgh', pool: POOL, state: 'idle', since: 0, reusable: true, baselineHash: 'h', runnerId: 4, generation: 0 });
  await root.put('external-lease:lease:00000000-0000-0000-0000-000000000000', { client: 'lease', id: '00000000-0000-0000-0000-000000000000', state: 'reserved', expiresAt: now + 60_000, isolation: 'external-v2' });
  const fence = new WarmLeaseFence(root, { removeRunner: async () => {}, lightReset: async () => ({ processId: 2 }) }, () => now);
  assert.equal(await fence.fence('demo', 'lease', '00000000-0000-0000-0000-000000000000', 'bx_abcdefgh'), true);
  let leased = await root.get(key);
  assert.equal(leased.state, 'lease-resetting'); assert.equal(leased.processId, 2);
  assert.deepEqual(leased.history.map(entry => entry.event), ['lease_fence', 'lease_reset_start']);
  assert.equal(await fence.destroy('demo', 'lease', '00000000-0000-0000-0000-000000000000'), true);
  leased = await root.get(key);
  assert.equal(leased.state, 'destroying'); assert.equal(leased.exitReason, 'lease_cleanup'); assert.equal(leased.history.at(-1).event, 'lease_destroy');
});
