import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, event, Storage } from './helpers.mjs';
import { FleetController } from '../src/fleet.mjs';
import { ApiError } from '../src/domain.mjs';
import { SetupController, hash } from '../src/setup.mjs';
import { APIs } from '../src/apis.mjs';

const events = async f => (await f.storage.get('alerts') ?? []).map(e => e.event);
test('B1:  runs after reverse assignment while machine 101 is still booting', async () => {
  const f = fixture(); await f.controller.ingest(event(101)); await f.controller.ingest(event(102)); await f.controller.tick();
  const m101 = (await f.storage.get('job:101')).machineId;
  const m102 = (await f.storage.get('job:102')).machineId;
  f.fake.machines.get(m101).setupStatus = 'running'; await f.pump(10);
  f.fake.jobs.set(101, { id: 101, status: 'completed', runner_name: 'boat-ci-j102' });
  await f.controller.ingest(event(101, 'boat-default', 'in_progress', 'boat-ci-j102'));
  await f.controller.ingest(event(101, 'boat-default', 'completed', 'boat-ci-j102')); await f.pump(5);
  assert.ok(f.fake.machines.has(m101), 'unassigned machine must survive its intended job finishing elsewhere');
  assert.ok(f.fake.deletes.includes(m102));
  f.fake.machines.get(m101).setupStatus = 'done'; await f.pump(6);
  assert.equal((await f.storage.get('job:101')).phase, 'running');
  f.fake.jobs.set(102, { id: 102, status: 'in_progress', runner_name: 'boat-ci-j101' });
  await f.controller.ingest(event(102, 'boat-default', 'in_progress', 'boat-ci-j101')); await f.pump(2);
  assert.ok(f.fake.machines.has(m101));
  f.fake.jobs.set(102, { id: 102, status: 'completed', runner_name: 'boat-ci-j101' });
  await f.controller.ingest(event(102, 'boat-default', 'completed', 'boat-ci-j101')); await f.pump();
  assert.equal(f.fake.jobs.get(102).status, 'completed'); assert.equal(f.fake.starts, 2);
  assert.equal(f.fake.machines.size, 0); assert.equal((await f.storage.get('job:101')).phase, 'done');
});
for (const stop of ['disabled', 'breaker']) {
  test(`F1: lost create is recorded and destroyed after cancellation while ${stop}`, async () => {
    const f = fixture(); f.fake.loseCreateResponse = true; await f.controller.ingest(event()); await f.controller.tick();
    const machine = [...f.fake.machines.keys()][0]; const key = (await f.storage.get('job:101')).createKey;
    if (stop === 'disabled') f.env.ENABLED = 'false';
    else await f.storage.put('blocked', { epoch: '0', at: f.now(), status: 402 });
    f.fake.jobs.set(101, { id: 101, status: 'completed' }); await f.controller.ingest(event(101, 'boat-default', 'completed')); await f.pump(40, 60_000);
    assert.equal(f.fake.starts, 1); assert.equal(f.fake.machines.size, 0); assert.deepEqual(f.fake.deletes, [machine]);
    assert.equal((await f.storage.get('job:101')).phase, 'done');
    const creates = f.fake.requests.filter(r => r.path.endsWith('/sandboxes') && r.method === 'POST');
    assert.equal(creates.length, 2); assert.ok(creates.every(r => r.headers['Idempotency-Key'] === key));
  });
}
test('F2: an unavailable large size cannot freeze default across RESUME_EPOCH', async () => {
  const f = fixture(); f.api.limits = async () => ({ canStart: true, billingStatus: 'active', machineTypes: [
    { type: 'default', available: true }, { type: 'large', available: false }, { type: 'xlarge', available: true }] });
  await f.controller.ingest(event(101, 'boat-large')); await f.pump(3);
  await f.controller.ingest({ ...event(102), repo: 'example-owner/project-c', installation: 2 }); await f.pump(5);
  f.env.RESUME_EPOCH = 'owner-resolved-1'; await f.pump(12, 60_000);
  assert.equal(f.fake.starts, 1); assert.equal((await f.controller.status()).blocked, false);
  assert.equal((await f.storage.get('job:102')).phase, 'running');
  assert.ok((await f.controller.status(true)).blocked_sizes.includes('large'));
});
for (const outcome of ['failed', '404']) {
  test(`F3: purge ${outcome} retries destroy with backoff, then persists an alert`, async () => {
    const f = fixture(); await f.controller.ingest(event()); await f.pump();
    f.api.deletion = async () => { if (outcome === '404') throw new ApiError('boat', 404); return { operation: { status: 'failed' } }; };
    f.fake.jobs.set(101, { id: 101, status: 'completed' }); await f.controller.ingest(event(101, 'boat-default', 'completed', 'boat-ci-j101'));
    await f.pump(100, 60_000);
    assert.equal((await f.storage.get('job:101')).phase, 'attention');
    assert.ok(f.fake.deletes.length > 1 && f.fake.deletes.length <= 4);
    assert.ok((await events(f)).includes('alert_purge_failed'));
    const count = f.fake.deletes.length; await f.pump(100, 60_000); assert.equal(f.fake.deletes.length, count);
    assert.ok(f.logs.some(line => JSON.parse(line).event === 'purge_retry' && JSON.parse(line).retry_ms > 0));
  });
}
test('F4/F5: preview GET is read-only, wrong-owner conversion reopens setup, and reset needs control auth', async () => {
  const f = fixture(); const storage = new Storage(); const origin = 'https://launcher.test';
  const token = 'first-setup-token-of-at-least-32-chars'; const control = 'fake-control-token-of-at-least-32-chars';
  const env = { ENABLED: 'false', PUBLIC_ORIGIN: origin, SETUP_BOOTSTRAP: JSON.stringify({ tokenHash: await hash(token), controlHash: await hash(control), expiresAt: f.now() + 30 * 60_000 }) };
  const c = new SetupController(storage, env, new APIs(env, async () => Response.json({ id: 9, slug: 'boat-ci', owner: { login: 'another-owner' }, pem: f.env.GITHUB_APP_PRIVATE_KEY, webhook_secret: 'fake-secret' })), f.now);
  const preview = await c.fetch(new Request(`${origin}/setup?token=${token}`));
  assert.equal(preview.status, 200); assert.equal(storage.data.size, 0); assert.equal(preview.headers.get('Set-Cookie'), null);
  assert.match(await preview.text(), /method="post"/);
  const begin = await c.fetch(new Request(`${origin}/setup`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token }) }));
  const cookie = begin.headers.get('Set-Cookie').split(';')[0]; const state = cookie.split('=')[1];
  const callback = await c.fetch(new Request(`${origin}/setup/callback?code=c&state=${state}`, { headers: { Cookie: cookie } }));
  assert.equal(callback.status, 422); assert.equal((await storage.get('setup-flow')).phase, 'rejected');
  const rotated = 'rotated-setup-token-of-at-least-32-chars';
  env.SETUP_BOOTSTRAP = JSON.stringify({ tokenHash: await hash(rotated), controlHash: await hash(control), expiresAt: f.now() + 30 * 60_000 });
  assert.equal((await c.fetch(new Request(`${origin}/setup`, { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ token: rotated }) }))).status, 200);
  assert.equal((await c.fetch(new Request(`${origin}/setup/reset`, { method: 'POST' }))).status, 401);
  assert.equal((await c.fetch(new Request(`${origin}/setup/reset`, { method: 'POST', headers: { Authorization: 'Bearer ' + control } }))).status, 204);
  assert.equal((await storage.get('setup-flow')).phase, 'reset');
});
test('F6: active slots and UTC-day create-key budgets limit machine starts', async () => {
  const f = fixture(); f.env.MAX_ACTIVE = '1'; f.env.MAX_STARTS_PER_DAY = '2';
  await f.controller.ingest(event(101)); await f.controller.ingest(event(102)); await f.controller.tick();
  assert.equal(f.fake.starts, 1);
  f.fake.jobs.set(101, { id: 101, status: 'completed' }); await f.controller.ingest(event(101, 'boat-default', 'completed', 'boat-ci-j101')); await f.pump(15);
  assert.equal(f.fake.starts, 2);
  f.fake.jobs.set(102, { id: 102, status: 'completed' }); await f.controller.ingest(event(102, 'boat-default', 'completed', 'boat-ci-j102')); await f.pump(15);
  await f.controller.ingest(event(103)); await f.pump(20); assert.equal(f.fake.starts, 2);
  assert.equal((await f.controller.status(true)).starts_today, 2);
  f.clock.time += 86400_000; await f.pump(5); assert.equal(f.fake.starts, 3);
});
for (const service of ['github', 'boat']) {
  test(`F7: permanent ${service} 4xx stops after bounded retries with a visible alert`, async () => {
    const f = fixture(); let calls = 0;
    if (service === 'github') f.api.getJob = async () => { calls++; throw new ApiError('github', 404); };
    else f.api.create = async () => { calls++; throw new ApiError('boat', 400); };
    await f.controller.ingest(event()); await f.pump(100, 60_000);
    assert.equal(calls, 3); assert.equal((await f.storage.get('job:101')).phase, 'attention');
    const status = await f.controller.status(true); assert.ok(status.alerts.some(e => e.event === 'alert_permanent_error' && e.job_id === 101));
    assert.ok(!JSON.stringify(status).includes(f.fake.jit));
  });
}
test('F7: stopped queued jobs poll GitHub at most once per ten minutes', async () => {
  const f = fixture(); f.env.ENABLED = 'false'; await f.controller.ingest(event()); await f.pump(10, 60_000);
  assert.ok(f.fake.requests.filter(r => r.path.includes('/actions/jobs/')).length <= 2);
  assert.equal(f.fake.starts, 0);
});
test('F8: bootstrap failure alerts and retries a queued job with a fresh live machine', async () => {
  const f = fixture(); await f.controller.ingest(event()); await f.controller.tick();
  const first = (await f.storage.get('job:101')).machineId; f.fake.machines.get(first).setupStatus = 'failed';
  await f.pump(30);
  const job = await f.storage.get('job:101'); assert.notEqual(job.machineId, first);
  assert.equal(job.phase, 'running'); assert.ok(f.fake.machines.has(job.machineId)); assert.equal(f.fake.starts, 2);
  assert.ok((await events(f)).includes('alert_bootstrap_failed'));
});

test('F1: stopping starts resolves an uncertain create even without a cancellation', async () => {
  const f = fixture(); f.fake.loseCreateResponse = true; await f.controller.ingest(event()); await f.controller.tick();
  f.env.ENABLED = 'false'; await f.pump(12, 60_000);
  assert.equal(f.fake.starts, 1); assert.equal(f.fake.machines.size, 0);
  assert.equal((await f.storage.get('job:101')).phase, 'queued');
  assert.equal((await f.controller.status(true)).active_reservations, 0);
});
test('F6: reserved capacity and daily budget survive a lost response and controller restart', async () => {
  const f = fixture(); f.env.MAX_ACTIVE = '1'; f.env.MAX_STARTS_PER_DAY = '1'; f.fake.loseCreateResponse = true;
  await f.controller.ingest(event(101)); await f.controller.ingest(event(102));
  await Promise.all([f.controller.tick(), f.controller.tick()]);
  assert.equal(f.fake.starts, 1);
  const restarted = new FleetController(f.storage, f.env, f.api, f.now, line => f.logs.push(line));
  for (let i = 0; i < 12; i++) { f.clock.time += 30_000; await restarted.tick(); }
  assert.equal(f.fake.starts, 1); assert.equal((await f.storage.get('job:101')).phase, 'running');
  const status = await restarted.status(true); assert.equal(status.active_reservations, 1); assert.equal(status.starts_today, 1);
  assert.equal((await f.storage.get('job:102')).phase, 'queued');
});
test('F6: a definitively refused key is charged against each UTC day in which it can start', async () => {
  const f = fixture(); f.env.MAX_STARTS_PER_DAY = '1'; f.fake.refusals.push({ status: 503, code: 'out_of_capacity' });
  await f.controller.ingest(event(101)); await f.controller.tick(); assert.equal(f.fake.starts, 0);
  f.clock.time += 86400_000; await f.controller.tick(); await f.controller.ingest(event(102)); await f.pump(5);
  assert.equal(f.fake.starts, 1); assert.equal((await f.controller.status(true)).starts_today, 1);
  assert.equal((await f.storage.get('job:102')).phase, 'queued');
  assert.equal((await f.storage.get('job:101')).phase, 'running');
  assert.equal(f.fake.machines.size, 1);
});
test('F6: default guards reserve at most four machines and report a 100-key daily budget', async () => {
  const f = fixture(); for (let id = 101; id <= 106; id++) await f.controller.ingest(event(id)); await f.pump(15, 5000);
  assert.equal(f.fake.starts, 4); const status = await f.controller.status(true);
  assert.equal(status.max_active, 4); assert.equal(status.max_starts_per_day, 100); assert.equal(status.starts_today, 4);
});
test('F7: loss of a repository with a known machine cleans up and exposes an alert', async () => {
  const f = fixture(); await f.controller.ingest(event()); await f.pump();
  f.api.getJob = async () => { throw new ApiError('github', 404); }; await f.pump(30, 60_000);
  assert.equal(f.fake.machines.size, 0); assert.equal(f.fake.starts, 1);
  assert.equal((await f.storage.get('job:101')).phase, 'attention');
  assert.ok((await events(f)).includes('alert_job_unavailable')); assert.ok((await events(f)).includes('alert_permanent_error'));
});
test('F8: repeated assignment timeouts stop at three machines with an explicit exhausted alert', async () => {
  const f = fixture(); await f.controller.ingest(event()); await f.pump(100, 60_000);
  assert.equal(f.fake.starts, 3); assert.equal(f.fake.machines.size, 0);
  assert.equal((await f.storage.get('job:101')).phase, 'attention');
  assert.ok((await events(f)).includes('alert_assignment_timeout')); assert.ok((await events(f)).includes('alert_job_retries_exhausted'));
  await f.pump(50, 60_000); assert.equal(f.fake.starts, 3);
});

test('F7: a permanent configuration refusal cleans up the known machine before giving up', async () => {
  const f = fixture(); let calls = 0; f.api.configure = async () => { calls++; throw new ApiError('github', 403); };
  await f.controller.ingest(event()); await f.pump(50, 60_000);
  assert.equal(calls, 3); assert.equal(f.fake.starts, 1); assert.equal(f.fake.machines.size, 0);
  assert.equal((await f.storage.get('job:101')).phase, 'attention');
  assert.ok((await events(f)).includes('alert_permanent_error')); assert.ok((await events(f)).includes('alert_job_abandoned'));
});
test('replacement reservations ignore late assignment events from the prior machine', async () => {
  const f = fixture(); await f.controller.ingest(event()); await f.controller.tick();
  const old = (await f.storage.get('job:101')).machineId; f.fake.machines.get(old).setupStatus = 'failed'; await f.pump(20);
  const replacement = (await f.storage.get('job:101')).machineId;
  const name = f.fake.requests.filter(r => r.path.endsWith('/generate-jitconfig')).at(-1).body.name;
  assert.notEqual(name, 'boat-ci-j101');
  await f.controller.ingest(event(201, 'boat-default', 'completed', 'boat-ci-j101')); await f.pump(3);
  assert.ok(f.fake.machines.has(replacement)); assert.equal((await f.storage.get('job:101')).assignedJobId, null);
  f.fake.jobs.set(101, { id: 101, status: 'completed', runner_name: name });
  await f.controller.ingest(event(101, 'boat-default', 'completed', name)); await f.pump();
  assert.equal(f.fake.starts, 2); assert.equal(f.fake.machines.size, 0); assert.equal((await f.storage.get('job:101')).phase, 'done');
});
