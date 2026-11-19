// Max-parallel matrix runs (41 "browser shard N" jobs, 16 slots). GitHub picks which held shard starts next and
// gives it to any idle runner with the label, so a dispatch-only reservation for one shard names a slot of the run,
// not that shard. In production the open queue had dropped the matrix rule once: 35 boxes were created in 47 s for
// 16 slots, and boxes whose reserved shard stayed held timed out, fenced, reset and often ended with zero jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { RESERVATION_MS } from '../src/router/box-state.mjs';

const REPO = 'example-owner/project-a', LABEL = 'boat-large', POOL = JSON.stringify([REPO, LABEL]);
const PATH = '.github/workflows/full-suite.yml', RUN = 1000001, T0 = 1_794_293_610_000, BASE = 129_680_220_000;
const RULES = [{ workflowPath: '.github/workflows/full-suite.yml', jobPrefix: 'browser (', maxParallel: 16 }, { workflowPath: '.github/workflows/full-suite.yml', jobPrefix: 'browser shard ', maxParallel: 16 }];
const id = n => BASE + n;
const shard = (n, status = 'queued', extra = {}) => ({ id: id(n), pool: POOL, status, runId: RUN, workflowPath: PATH, workflowName: 'release-browser-b52b7942009ca9ce-1', jobName: `browser shard ${n}`, queuedAt: T0, observedAt: T0, source: 'webhook', runnerName: null, ...extra });
const project = rules => ({ id: 'project-a', repo: REPO, account: 'account', labels: [LABEL], sizes: { [LABEL]: { machine: 'large' } }, caps: {}, reuse: { mode: 'on', idleHoldSeconds: 900 }, dispatchOnly: true, workflowConcurrency: rules });
const runner = (name, busy, id = 1) => ({ id, name, status: 'online', busy, labels: [{ name: LABEL }] });
const RUNNER_A = 'boat-project-a-bx_aaaaaaaa-g0';

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
let serial = 0;
const sandboxId = () => { let n = serial++, s = ''; for (let i = 0; i < 8; i++) { s += ALPHABET[n % ALPHABET.length]; n = Math.floor(n / ALPHABET.length); } return `bx_${s}`; };

function harness(rules) {
  const clock = { now: T0 + 300_000 }, storage = new Storage(), calls = { removeRunner: 0, create: 0, start: 0, prepared: 0 }, logs = [];
  const api = {
    limits: async () => ({ canStart: true, machineTypes: [{ type: 'large', available: true }], starts: { minute: { limit: 100, used: 0, remaining: 100 }, hour: { limit: 1000, used: 0, remaining: 1000 }, day: { limit: 10000, used: 0, remaining: 10000 } } }),
    create: async () => { calls.create++; return { sandbox: { id: sandboxId() } }; },
    sandbox: async () => ({ sandbox: { state: 'running', setupStatus: 'pending' } }),
    removeRunner: async () => { calls.removeRunner++; },
    start: async () => { calls.start++; return { success: true }; },
  };
  const cfg = project(rules);
  const budget = new SharedBudget(new AccountLedger(new Storage(), {}, () => clock.now), cfg.id, () => clock.now);
  const fleet = new BoxFleet(storage, api, () => clock.now, { budget, project: cfg, installation: 1, logger: line => logs.push(JSON.parse(line)) });
  // Every create the planner asks for, whether or not admission starts it in the same tick.
  const prepare = fleet.prepare.bind(fleet);
  fleet.prepare = async (...args) => { calls.prepared += args[2]; return prepare(...args); };
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg };
  // Mirrors Router.runTick in pool mode: prepare, then tick.
  const tick = async () => { await fleet.tick({ ...opts, prepareOnly: true }); await fleet.tick({ ...opts, preprepared: true }); };
  const prepared = async () => [...(await storage.list({ prefix: 'create:' })).values()].length;
  const snapshot = runners => storage.put('pool:snapshot', { at: clock.now, complete: true, runners });
  return { clock, storage, fleet, api, calls, logs, cfg, tick, prepared, snapshot, box: () => storage.get('box:bx_aaaaaaaa') };
}
const idleBox = (h, n, extra = {}) => h.storage.put('box:bx_aaaaaaaa', { machineId: 'bx_aaaaaaaa', pool: POOL, originPool: POOL, size: 'large', state: 'idle', since: h.clock.now, createdAt: h.clock.now - 300_000, generation: 0, jobs: 0, reusable: true, baselineHash: 'a'.repeat(64), runnerId: 7, runnerName: RUNNER_A, online: true, everOnline: true, onlineAt: h.clock.now, startedAt: h.clock.now, dispatchJobId: id(n), dispatchAt: h.clock.now, ...extra });
const putJobs = (h, jobs) => Promise.all(jobs.map(job => h.storage.put(`gh-job:${job.id}`, job)));

test('planner: a 41-shard batch with 16 slots prepares 16 creates; without the rule it prepared 41', async () => {
  for (const [rules, expected] of [[[], 41], [RULES, 16]]) {
    const h = harness(rules);
    await h.storage.put('pool:migrated', { done: true });
    await h.snapshot([]);
    await putJobs(h, Array.from({ length: 41 }, (_, n) => shard(n)));
    await h.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: h.cfg, prepareOnly: true });
    assert.equal(await h.prepared(), expected, `rules: ${rules.length}`);
  }
  // Target supply is cap minus the run's shards in progress on any runner; a ready box of the pool is supply.
  const h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await h.snapshot(Array.from({ length: 15 }, (_, n) => runner(`other-${n}`, true, 100 + n)));
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 15 ? shard(n, 'in_progress', { runnerName: `other-${n}` }) : shard(n)));
  await h.storage.put('box:bx_bbbbbbbb', { machineId: 'bx_bbbbbbbb', pool: POOL, state: 'ready', since: h.clock.now, createdAt: h.clock.now, generation: 1, reusable: true, baselineHash: 'a'.repeat(64) });
  await h.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: h.cfg, prepareOnly: true });
  assert.equal(await h.prepared(), 0);
});

// The production pattern: box A reserved shard 32; GitHub started shard 5 on another runner and filled the 16th slot.
async function heldReservation(rules) {
  const h = harness(rules);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 32);
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 16 ? shard(n, 'in_progress', { runnerName: `other-${n}` }) : shard(n)));
  await h.snapshot([...Array.from({ length: 16 }, (_, n) => runner(`other-${n}`, true, 100 + n)), runner(RUNNER_A, false, 7)]);
  h.clock.now += RESERVATION_MS;
  await h.snapshot([...Array.from({ length: 16 }, (_, n) => runner(`other-${n}`, true, 100 + n)), runner(RUNNER_A, false, 7)]);
  await h.tick();
  return h;
}

test('reproduction: without the matrix pool the held reservation times out, the runner is fenced and the planner asks for boxes', async () => {
  const h = await heldReservation([]);
  const box = await h.box();
  assert.equal(box.state, 'local-fencing');
  assert.equal(box.reservationExpiredJobId, id(32));
  assert.equal(h.calls.prepared, 24, 'every held shard not covered by box A became create demand');
});

test('matrix pool: a held reservation moves to a queued shard of the run, the runner stays registered and no box is created', async () => {
  const h = await heldReservation(RULES);
  let box = await h.box();
  assert.equal(box.state, 'idle');
  assert.equal(box.dispatchJobId, id(16), 'the first free queued shard of the same run');
  assert.equal(box.dispatchAt, h.clock.now);
  assert.equal(box.matrixRetargets, 1);
  assert.equal(box.history, undefined, 'a stay event; the box never left idle');
  assert.equal(h.calls.removeRunner, 0);
  assert.equal(h.calls.prepared, 0, 'a reservation timeout on a matrix shard is not create demand');
  assert.deepEqual(h.logs.filter(line => line.event === 'matrix_reservation_retarget').map(line => [line.from_job_id, line.job_id, line.runnable]), [[id(32), id(16), false]]);
  // Shard 0 ends; GitHub starts shard 40 (its own choice, not the reserved 16) on the idle runner of box A.
  h.clock.now += 30_000;
  await putJobs(h, [shard(0, 'completed', { runnerName: 'other-0', conclusion: 'success' }), shard(40, 'in_progress', { runnerName: RUNNER_A })]);
  await h.snapshot([...Array.from({ length: 15 }, (_, n) => runner(`other-${n + 1}`, true, 101 + n)), runner(RUNNER_A, true, 7)]);
  await h.tick();
  box = await h.box();
  assert.equal(box.state, 'busy', 'the kept box ran the next shard GitHub started');
  assert.ok(!box.history.some(entry => ['reservation_timeout', 'fence_local', 'local_fenced'].includes(entry.event)), 'no fence cycle');
  assert.equal(h.calls.prepared, 0);
});

test('matrix pool: a reserved shard started on another runner moves the reservation instead of fencing', async () => {
  const h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 15);
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 16 ? shard(n, 'in_progress', { runnerName: `other-${n}` }) : shard(n)));
  await h.snapshot([...Array.from({ length: 16 }, (_, n) => runner(`other-${n}`, true, 100 + n)), runner(RUNNER_A, false, 7)]);
  await h.tick();
  const box = await h.box();
  assert.equal(box.state, 'idle');
  assert.equal(box.dispatchJobId, id(16));
  assert.equal(h.calls.removeRunner, 0);
});

test('unchanged: non-matrix jobs, exhausted runs and fully reserved runs fence exactly as before', async () => {
  // A job outside every workflowConcurrency rule times out through reservation_timeout.
  let h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 0);
  await putJobs(h, [shard(0, 'queued', { jobName: 'lint' }), shard(1, 'queued', { jobName: 'lint' })]);
  h.clock.now += RESERVATION_MS;
  await h.snapshot([runner(RUNNER_A, false, 7)]);
  await h.tick();
  let box = await h.box();
  assert.deepEqual([box.state, box.reservationExpiredJobId], ['local-fencing', id(0)]);
  assert.equal(box.matrixRetargets, undefined);
  // A non-matrix job taken by another runner fences at once.
  h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 0);
  await putJobs(h, [shard(0, 'in_progress', { jobName: 'lint', runnerName: 'other' }), shard(1, 'queued', { jobName: 'lint' })]);
  await h.snapshot([runner('other', true, 9), runner(RUNNER_A, false, 7)]);
  await h.tick();
  box = await h.box();
  assert.deepEqual(box.history.map(entry => entry.event).slice(0, 1), ['fence_local']);
  // A matrix run whose last queued shard started elsewhere has nothing left to wait for.
  h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 40);
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 25 ? shard(n, 'completed', { runnerName: `old-${n}` }) : shard(n, 'in_progress', { runnerName: `other-${n}` })));
  await h.snapshot(Array.from({ length: 16 }, (_, n) => runner(`other-${n + 25}`, true, 125 + n)).concat([runner(RUNNER_A, false, 7)]));
  await h.tick();
  box = await h.box();
  assert.deepEqual(box.history.map(entry => entry.event).slice(0, 1), ['fence_local']);
  // A matrix run whose only queued shard is held by another box's active reservation: box A is extra and fences.
  h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 39);
  await h.storage.put('box:bx_cccccccc', { machineId: 'bx_cccccccc', pool: POOL, state: 'idle', since: h.clock.now, createdAt: h.clock.now, generation: 0, runnerId: 8, runnerName: 'boat-project-a-bx_cccccccc-g0', online: true, dispatchJobId: id(40), dispatchAt: h.clock.now });
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 24 ? shard(n, 'completed', { runnerName: `old-${n}` }) : n < 40 ? shard(n, 'in_progress', { runnerName: `other-${n}` }) : shard(n)));
  await h.snapshot(Array.from({ length: 16 }, (_, n) => runner(`other-${n + 24}`, true, 124 + n)).concat([runner(RUNNER_A, false, 7), runner('boat-project-a-bx_cccccccc-g0', false, 8)]));
  await h.tick();
  box = await h.box();
  assert.deepEqual(box.history.map(entry => entry.event).slice(0, 1), ['fence_local']);
  assert.equal((await h.storage.get('box:bx_cccccccc')).dispatchJobId, id(40));
  // A held shard whose reservation lapsed is refreshed in place when it is the run's only free queued shard.
  h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 40);
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 24 ? shard(n, 'completed', { runnerName: `old-${n}` }) : n < 40 ? shard(n, 'in_progress', { runnerName: `other-${n}` }) : shard(n)));
  h.clock.now += RESERVATION_MS;
  await h.snapshot(Array.from({ length: 16 }, (_, n) => runner(`other-${n + 24}`, true, 124 + n)).concat([runner(RUNNER_A, false, 7)]));
  await h.tick();
  box = await h.box();
  assert.deepEqual([box.state, box.dispatchJobId, box.dispatchAt], ['idle', id(40), h.clock.now]);
  // Drain mode keeps the old fence even for a matrix shard.
  h = harness(RULES);
  await h.storage.put('pool:migrated', { done: true });
  await idleBox(h, 32);
  await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 16 ? shard(n, 'in_progress', { runnerName: `other-${n}` }) : shard(n)));
  h.clock.now += RESERVATION_MS;
  await h.snapshot([runner(RUNNER_A, false, 7)]);
  await h.fleet.tick({ mode: 'drain', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: h.cfg, preprepared: true });
  box = await h.box();
  assert.equal(box.history[0].event, 'reservation_timeout');
});

test('registering: a matrix shard taken while the runner registers moves the reservation and the runner starts; other jobs fence as before', async () => {
  for (const matrix of [true, false]) {
    const h = harness(RULES);
    const jobName = n => matrix ? `browser shard ${n}` : 'lint';
    await putJobs(h, Array.from({ length: 41 }, (_, n) => n < 15 ? shard(n, 'in_progress', { runnerName: `other-${n}`, jobName: jobName(n) }) : shard(n, 'queued', { jobName: jobName(n) })));
    await h.snapshot(Array.from({ length: 15 }, (_, n) => runner(`other-${n}`, true, 100 + n)));
    await h.storage.put('box:bx_aaaaaaaa', { machineId: 'bx_aaaaaaaa', pool: POOL, originPool: POOL, size: 'large', state: 'ready', since: h.clock.now, createdAt: h.clock.now - 300_000, generation: 1, jobs: 1, reusable: true, baselineHash: 'a'.repeat(64) });
    h.api.configure = async (box, registered) => {
      // GitHub starts the reserved shard on another runner while this one registers.
      await h.storage.put(`gh-job:${box.dispatchJobId}`, shard(box.dispatchJobId - BASE, 'in_progress', { runnerName: 'other-x', jobName: jobName(box.dispatchJobId - BASE) }));
      await registered(7);
    };
    await h.fleet.stepBox('bx_aaaaaaaa', { complete: true, runners: [], jobs: [] });
    const box = await h.box();
    if (matrix) {
      assert.equal(box.state, 'idle');
      assert.equal(h.calls.start, 1);
      assert.equal(box.dispatchJobId, id(16));
      assert.equal(box.matrixRetargets, 1);
      assert.deepEqual(box.history.map(entry => entry.event), ['register', 'start']);
      assert.deepEqual(h.logs.filter(line => line.event === 'matrix_reservation_retarget').map(line => [line.from_job_id, line.job_id, line.state]), [[id(15), id(16), 'registering']]);
      const placement = await h.storage.get(`placement:${id(16)}`);
      assert.deepEqual([placement.jobId, placement.machineId, placement.retargetedFrom], [id(16), 'bx_aaaaaaaa', id(15)]);
    } else {
      assert.equal(box.state, 'local-fencing');
      assert.equal(h.calls.start, 0);
      assert.deepEqual(box.history.map(entry => entry.event), ['register', 'fence_local']);
    }
  }
});
