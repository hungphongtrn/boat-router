import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { waitClaims } from '../src/router/wait-for-busy.mjs';
import { observe } from '../src/router/pool-observations.mjs';
import { plan } from '../src/router/pool.mjs';

const pool = JSON.stringify(['a/b', 'boat-large']);
function fixture(used = 95) {
  const storage = new Storage(), logs = [], now = 1_000_000;
  const account = { waitForBusyBox: { enabled: true, maxWaitMs: 600_000, scarcityFrom: .5, scarcityFull: .95 } };
  const busy = { machineId: 'box', pool, state: 'busy', reusable: true, baselineHash: 'abc', runnerName: 'runner', generation: 0, createdAt: 0 };
  const running = { id: 1, pool, status: 'in_progress', runnerName: 'runner', jobName: 'Tests (3/4)', startedAt: 500_000, queuedAt: 0 };
  const queued = { id: 2, pool, status: 'queued', queuedAt: 1 };
  const args = { storage, api: { limits: async () => ({ starts: { day: { used, limit: 100 }, hour: { used, limit: 100 } } }) }, jobs: [running, queued], boxes: [busy], units: [busy], pools: [{ key: pool }], now, account, project: { id: 'demo' }, enabled: true, logger: line => logs.push(JSON.parse(line)) };
  return { storage, args, busy, running, queued, logs };
}
async function run(f) { return waitClaims(f.args); }

test('plenty of starts and switch off leave fresh admission unchanged', async () => {
  for (const disable of [false, true]) {
    const f = fixture(disable ? 95 : 20); if (disable) f.args.account.waitForBusyBox.enabled = false;
    const before = plan({ pools: f.args.pools, jobs: f.args.jobs, units: f.args.units, now: f.args.now });
    const result = await run(f);
    assert.equal(result.active.length, 0);
    assert.deepEqual(plan({ pools: f.args.pools, jobs: f.args.jobs, units: [...f.args.units, ...result.virtual], now: f.args.now }), before);
  }
});

test('near limit holds demand and resolves when the job starts on the reset box', async () => {
  const f = fixture(); await f.storage.put('gh-job:2', f.queued);
  let result = await run(f); assert.equal(result.active.length, 1);
  assert.equal(plan({ pools: f.args.pools, jobs: f.args.jobs, units: [...f.args.units, ...result.virtual], now: f.args.now })[pool].create, 0);
  f.args.now += 20_000; f.busy.state = 'idle'; f.busy.runnerName = 'new-runner'; f.busy.generation = 1;
  f.queued.status = 'in_progress'; f.queued.runnerName = 'new-runner';
  result = await run(f); assert.equal(result.active.length, 0);
  assert.equal(f.logs.at(-1).outcome, 'reused'); assert.equal(f.logs.at(-1).waited_ms, 20_000);
});

test('direct jobs wait for a busy lease and record the outcome on direct demand', async () => {
  const f = fixture();
  Object.assign(f.running, { id: 'run-a:core', direct: true });
  Object.assign(f.queued, { id: 'run-b:core', direct: true });
  delete f.running.runnerName;
  delete f.busy.runnerName;
  f.busy.lease = f.running.id;
  await f.storage.put('direct:job:run-b:core', f.queued);
  assert.equal((await run(f)).active.length, 1);
  f.args.now += 20_000;
  f.busy.lease = f.queued.id;
  f.busy.generation = 1;
  f.queued.status = 'in_progress';
  assert.equal((await run(f)).active.length, 0);
  assert.equal(f.logs.at(-1).outcome, 'reused');
  assert.equal((await f.storage.get('direct:job:run-b:core')).waitAttempted, true);
});

test('expiry releases demand and cannot renew the same job wait', async () => {
  const f = fixture(); await f.storage.put('gh-job:2', f.queued); await run(f);
  f.args.now += 600_000; const result = await run(f);
  assert.equal(result.active.length, 0); assert.equal(f.logs.at(-1).outcome, 'expired');
  assert.equal(plan({ pools: f.args.pools, jobs: f.args.jobs, units: [...f.args.units, ...result.virtual], now: f.args.now })[pool].create, 1);
  assert.equal((await run(f)).active.length, 0);
});

test('one busy box can cover only one waiting job', async () => {
  const f = fixture(); f.args.jobs.push({ id: 3, pool, status: 'queued', queuedAt: 2 });
  const result = await run(f); assert.equal(result.active.length, 1);
  assert.equal(plan({ pools: f.args.pools, jobs: f.args.jobs, units: [...f.args.units, ...result.virtual], now: f.args.now })[pool].create, 1);
});

test('completion records exact job names and flags timeout and slow boxes', async () => {
  const storage = new Storage(), base = { repo: 'a/b', label: 'boat-large', status: 'completed', startedAt: 1000, conclusion: 'success' };
  await observe(storage, { ...base, id: 1, jobName: 'Tests (3/4)', completedAt: 101_000 }, 110_000);
  await observe(storage, { ...base, id: 2, jobName: 'check preflight', completedAt: 401_000 }, 410_000);
  await observe(storage, { ...base, id: 3, jobName: 'Tests (3/4)', completedAt: 2_001_000 }, 2_010_000);
  await observe(storage, { ...base, id: 4, conclusion: 'timed_out', completedAt: 5_001_000 }, 5_010_000);
  assert.equal((await storage.get('gh-job:3')).slowBox, true);
  assert.equal((await storage.get('gh-job:4')).slowBox, true);
  const history = await storage.get(`wait-history:${pool}`);
  assert.deepEqual(history.names[JSON.stringify('Tests (3/4)')], [100_000, 2_000_000]);
  assert.deepEqual(history.names[JSON.stringify('check preflight')], [400_000]);
});


test('a timed-out job retires its box instead of resetting it', async () => {
  const { BoxFleet } = await import('../src/router/box-fleet.mjs');
  const storage = new Storage(), machineId = 'box', project = { id: 'demo', repo: 'a/b', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, reuse: { mode: 'on' } };
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  await storage.put('box:box', { machineId, pool, state: 'finished', since: 0, createdAt: 0, runnerName: 'runner', reusable: true, baselineHash: 'abc', generation: 0, jobs: 1 });
  await storage.put('gh-job:1', { id: 1, pool, status: 'completed', runnerName: 'runner', conclusion: 'timed_out', durationRecorded: true, slowBox: true, queuedAt: 0 });
  let resets = 0;
  const fleet = new BoxFleet(storage, { lightReset: async () => { resets++; } }, () => 1_000_000, { project, budget: {} });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true }, waitForBusyBox: { enabled: true } }, project });
  assert.equal(resets, 0); assert.equal((await storage.get('box:box')).state, 'destroying'); assert.equal((await storage.get('box:box')).retirementReason, 'slow_job');
});

test('pool admission creates fresh supply immediately when a box is busy', async () => {
  const { BoxFleet } = await import('../src/router/box-fleet.mjs');
  const f = fixture(), project = { id: 'demo', repo: 'a/b', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, reuse: { mode: 'on' } };
  f.args.account.reuse = { enabled: true };
  let now = f.args.now;
  const budget = { claimKey: async key => key, enqueue: async () => {}, claim: async () => null, abandon: async () => {} };
  await f.storage.put('pool:migrated', { done: true });
  await f.storage.put('pool:snapshot', { complete: true, runners: [{ name: 'runner', status: 'online', busy: true }] });
  await f.storage.put('box:box', f.busy); await f.storage.put('gh-job:1', f.running); await f.storage.put('gh-job:2', f.queued);
  const fleet = new BoxFleet(f.storage, f.args.api, () => now, { budget, project });
  const tick = () => fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: f.args.account, project, prepareOnly: true });
  await tick(); assert.equal((await f.storage.list({ prefix: 'create:' })).size, 1);
  assert.equal(await f.storage.get('wait:claim:2'), undefined);
  now += 600_000; await tick();
  assert.equal((await f.storage.list({ prefix: 'create:' })).size, 1);
});


test('an incomplete snapshot cannot reset a box whose last result is unknown', async () => {
  const { BoxFleet } = await import('../src/router/box-fleet.mjs');
  const storage = new Storage(), project = { id: 'demo', repo: 'a/b', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, reuse: { mode: 'on' } };
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: false });
  await storage.put('box:box', { machineId: 'box', pool, state: 'finished', since: 0, createdAt: 0, runnerName: 'runner', reusable: true, baselineHash: 'abc', generation: 0, jobs: 1 });
  let resets = 0;
  const fleet = new BoxFleet(storage, { lightReset: async () => { resets++; } }, () => 1_000_000, { project, budget: {} });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true }, waitForBusyBox: { enabled: true } }, project });
  assert.equal(resets, 0); assert.equal((await storage.get('box:box')).state, 'destroying');
});


test('a box entering permanent retirement releases its claim', async () => {
  const f = fixture(); await f.storage.put('gh-job:2', f.queued); await run(f);
  f.busy.state = 'retiring'; f.busy.afterFence = null; f.args.now += 1000;
  const result = await run(f);
  assert.equal(result.active.length, 0); assert.equal(f.logs.at(-1).outcome, 'box_failed');
  assert.equal(plan({ pools: f.args.pools, jobs: f.args.jobs, units: [...f.args.units, ...result.virtual], now: f.args.now })[pool].create, 1);
});

test('paid overflow keeps its pending create when the box is busy', async () => {
  const { BoxFleet } = await import('../src/router/box-fleet.mjs');
  const f = fixture(), project = { id: 'demo', repo: 'a/b', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, reuse: { mode: 'on' } };
  f.args.account.reuse = { enabled: true };
  f.args.account.paidOverflow = { enabled: true };
  const budget = { claimKey: async key => key, enqueue: async () => {}, claim: async () => null, abandon: async () => true };
  await f.storage.put('pool:migrated', { done: true });
  await f.storage.put('pool:snapshot', { complete: true, runners: [{ name: 'runner', status: 'online', busy: true }] });
  await f.storage.put('box:box', f.busy); await f.storage.put('gh-job:1', f.running); await f.storage.put('gh-job:2', f.queued);
  await f.storage.put('create:pending', { createKey: 'pending', pool, size: 'large', state: 'pending', at: 1, queuedAt: 1, reusable: true });
  const fleet = new BoxFleet(f.storage, f.args.api, () => f.args.now, { budget, project });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: f.args.account, project, prepareOnly: true });
  assert.equal(await f.storage.get('wait:claim:2'), undefined);
  assert.equal((await f.storage.list({ prefix: 'create:' })).size, 1);
});


test('a configured minimum waits for a soon-free box even when starts are plentiful', async () => {
  const f = fixture(20);
  Object.assign(f.args.account.waitForBusyBox, { maxWaitMs: 180_000, minimumAllowanceMs: 180_000 });
  const result = await run(f);
  assert.equal(result.active.length, 1);
  assert.equal(result.active[0].until - f.args.now, 180_000);
  assert.equal(f.logs[0].expected_ms, 115_000);
  const slow = fixture(20);
  Object.assign(slow.args.account.waitForBusyBox, { maxWaitMs: 180_000, minimumAllowanceMs: 180_000 });
  slow.running.startedAt = slow.args.now;
  assert.equal((await run(slow)).active.length, 0);
});


test('a long different job is not marked slow against the pool median', async () => {
  const storage = new Storage(), base = { repo: 'a/b', label: 'boat-large', status: 'completed', startedAt: 1000, conclusion: 'success' };
  await observe(storage, { ...base, id: 10, jobName: 'short', completedAt: 11_000 }, 12_000);
  await observe(storage, { ...base, id: 11, jobName: 'long', completedAt: 101_000 }, 102_000);
  assert.notEqual((await storage.get('gh-job:11')).slowBox, true);
});
