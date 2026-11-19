import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, event } from './helpers.mjs';
import { FleetController } from '../src/fleet.mjs';

function sizes(f, xlarge) {
  f.api.limits = async () => ({ canStart: true, billingStatus: 'active', machineTypes: [
    ...['small', 'default', 'large'].map(type => ({ type, available: true })),
    ...(xlarge === null ? [] : [{ type: 'xlarge', available: xlarge }]),
  ] });
}
async function complete(f, id) {
  f.fake.jobs.set(id, { id, status: 'completed', runner_name: `boat-ci-j${id}` });
  await f.controller.ingest(event(id, 'boat-xlarge', 'completed', `boat-ci-j${id}`));
  await f.pump(10);
  assert.equal((await f.storage.get(`job:${id}`)).phase, 'done');
}
for (const availability of [null, false]) {
  test(`xlarge ${availability === null ? 'absent' : 'unavailable'} provisions large, retains the runner label, and reports one downgrade`, async () => {
    const f = fixture(); sizes(f, availability);
    await f.controller.ingest(event(101, 'boat-xlarge')); await f.pump(6);
    const job = await f.storage.get('job:101');
    assert.equal(job.phase, 'running'); assert.equal(f.fake.machines.get(job.machineId).size, 'large');
    const jit = f.fake.requests.find(r => r.path.endsWith('/generate-jitconfig'));
    assert.deepEqual(jit.body.labels, ['boat-xlarge']);
    const status = await f.controller.status(true);
    assert.equal(status.downgrade_count, 1);
    assert.deepEqual(status.downgrades.map(d => [d.job_id, d.machine_id, d.requested_size, d.size]), [[101, job.machineId, 'xlarge', 'large']]);
    await f.controller.ingest(event(101, 'boat-xlarge')); await f.pump(2);
    assert.equal((await f.controller.status(true)).downgrade_count, 1);
    await complete(f, 101); assert.equal(f.fake.machines.size, 0); assert.equal(f.fake.starts, 1);
  });
}
test('new allocations return to xlarge automatically when the live limits allow it', async () => {
  const f = fixture(); sizes(f, false);
  await f.controller.ingest(event(101, 'boat-xlarge')); await f.pump(6); await complete(f, 101);
  sizes(f, true);
  await f.controller.ingest(event(102, 'boat-xlarge')); await f.pump(6);
  const job = await f.storage.get('job:102');
  assert.equal(job.phase, 'running'); assert.equal(f.fake.machines.get(job.machineId).size, 'xlarge');
  assert.equal((await f.controller.status(true)).downgrade_count, 1);
  await complete(f, 102); assert.equal(f.fake.machines.size, 0); assert.equal(f.fake.starts, 2);
});
test('an uncertain downgraded create keeps its key and size across an upgrade and restart', async () => {
  const f = fixture(); sizes(f, false); f.fake.loseCreateResponse = true;
  await f.controller.ingest(event(101, 'boat-xlarge')); await f.controller.tick();
  const key = (await f.storage.get('job:101')).createKey; sizes(f, true);
  const restarted = new FleetController(f.storage, f.env, f.api, f.now, line => f.logs.push(line));
  for (let n = 0; n < 6; n++) { f.clock.time += 15_000; await restarted.tick(); }
  const creates = f.fake.requests.filter(r => r.path.endsWith('/sandboxes') && r.method === 'POST');
  assert.equal(creates.length, 2); assert.ok(creates.every(r => r.body.type === 'large' && r.headers['Idempotency-Key'] === key));
  assert.equal(f.fake.starts, 1); assert.equal((await restarted.status(true)).downgrade_count, 1);
  await complete(f, 101); assert.equal(f.fake.machines.size, 0);
});
test('reverse assignments on downgraded machines complete both xlarge jobs without leaks', async () => {
  const f = fixture(); sizes(f, false);
  await f.controller.ingest(event(101, 'boat-xlarge')); await f.controller.ingest(event(102, 'boat-xlarge'));
  await f.pump(6);
  for (const [id, runner] of [[101, 102], [102, 101]]) {
    f.fake.jobs.set(id, { id, status: 'completed', runner_name: `boat-ci-j${runner}` });
    await f.controller.ingest(event(id, 'boat-xlarge', 'completed', `boat-ci-j${runner}`));
    await f.pump(10);
  }
  assert.equal(f.fake.starts, 2); assert.equal(f.fake.machines.size, 0);
  assert.equal((await f.storage.get('job:101')).phase, 'done'); assert.equal((await f.storage.get('job:102')).phase, 'done');
  assert.equal((await f.controller.status(true)).downgrade_count, 2);
});
test('a fresh replacement rechecks xlarge after cleaning up its downgraded predecessor', async () => {
  const f = fixture(); sizes(f, false);
  await f.controller.ingest(event(101, 'boat-xlarge')); await f.controller.tick();
  const first = (await f.storage.get('job:101')).machineId;
  f.fake.machines.get(first).setupStatus = 'failed'; sizes(f, true); await f.pump(15);
  const job = await f.storage.get('job:101');
  assert.equal(job.phase, 'running'); assert.equal(f.fake.machines.get(job.machineId).size, 'xlarge');
  assert.equal((await f.controller.status(true)).downgrade_count, 1);
  f.fake.jobs.set(101, { id: 101, status: 'completed', runner_name: 'boat-ci-j101-g1' });
  await f.controller.ingest(event(101, 'boat-xlarge', 'completed', 'boat-ci-j101-g1')); await f.pump(10);
  assert.equal(f.fake.machines.size, 0); assert.equal((await f.storage.get('job:101')).phase, 'done');
});
test('a Boat start-limit refusal remains queued and is visible in authenticated status', async () => {
  const f = fixture(); f.fake.refusals.push({ status: 429, code: 'limit_reached', retryAfterSeconds: 60 });
  await f.controller.ingest(event()); await f.controller.tick();
  assert.equal((await f.storage.get('job:101')).phase, 'queued');
  assert.ok((await f.controller.status(true)).alerts.some(a => a.event === 'alert_start_limit' && a.job_id === 101 && a.status === 429));
  await f.pump(8); assert.equal((await f.storage.get('job:101')).phase, 'running'); assert.equal(f.fake.starts, 1);
});
test('configured minute and hour admission caps defer starts and reopen automatically', async () => {
  const f = fixture(); f.clock.time = 3600_000;
  f.env.MAX_STARTS_PER_MINUTE = '1'; f.env.MAX_STARTS_PER_HOUR = '2';
  for (const id of [101, 102, 103]) await f.controller.ingest(event(id));
  await f.controller.tick(); assert.equal(f.fake.starts, 1);
  f.clock.time += 61_000; await f.controller.tick(); assert.equal(f.fake.starts, 2);
  for (const id of [101, 102]) {
    f.fake.jobs.set(id, { id, status: 'completed' });
    await f.controller.ingest(event(id, 'boat-default', 'completed'));
  }
  await f.pump(10, 1000); assert.equal(f.fake.starts, 2);
  const status = await f.controller.status(true);
  assert.equal(status.max_starts_per_minute, 1); assert.equal(status.max_starts_per_hour, 2);
  assert.equal(status.starts_this_hour, 2);
  f.clock.time += 3600_000; await f.pump(2, 1000); assert.equal(f.fake.starts, 3);
});
