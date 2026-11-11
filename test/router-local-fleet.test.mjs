import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFleet, claimAny } from '../src/router/local-fleet.mjs';
import { Storage } from './helpers.mjs';

function fixture() {
  let time = 1000, nextId = 1;
  const storage = new Storage(), runners = new Map();
  const api = {
    async github(_job, path, options) {
      if (path.includes('generate-jitconfig')) {
        const runner = { id: nextId++, name: options.body.name, busy: false, status: 'offline' };
        runners.set(runner.id, runner);
        return { runner, encoded_jit_config: 'fake-jit' };
      }
      return { runners: [...runners.values()] };
    },
    async runner(job) { const runner = runners.get(job.runnerId); if (!runner) throw Object.assign(new Error(), { status: 404 }); return runner; },
    async removeRunner(job) { runners.delete(job.runnerId); },
  };
  const controller = { storage, api, env: { ENABLED: 'true' }, now: () => time, wake: async () => {} };
  const local = new LocalFleet(controller, { enabled: true, labels: { 'boat-large': 'browser' }, offerSeconds: 30, claimSeconds: 60 });
  const add = async id => storage.put(`job:${id}`, { id, repo: 'o/r', installation: 1, label: 'boat-large', phase: 'queued', createdAt: 1000 });
  return { storage, runners, local, add, advance: ms => { time += ms; } };
}

test('a shared mini slot chooses the oldest compatible project and then reuses the demand cache safely', async () => {
  const a = fixture(), b = fixture();
  await a.add(1); await b.add(2);
  const bJob = await b.storage.get('job:2'); await b.storage.put('job:2', { ...bJob, createdAt: 900 });
  const entries = [{ project: 'a', label: 'boat-large', local: a.local }, { project: 'b', label: 'boat-large', local: b.local }], cache = new Map();
  const first = await claimAny(entries, 'mini-a', {}, cache);
  assert.equal(first.project, 'b');
  const second = await claimAny(entries, 'mini-b', {}, cache);
  assert.equal(second.project, 'a');
  assert.equal(await claimAny(entries, 'mini-c', {}, cache), null);
});

test('claim rejection identifies disabled, empty, recent Boat and local supply', async () => {
  const f = fixture(), diagnostics = {};
  f.local.controller.env.CI_TO_MINIS = 'false';
  assert.equal(await f.local.claim('boat-large', 'mini-a', diagnostics), null);
  assert.equal(diagnostics.reason, 'project_disabled');
  f.local.controller.env.CI_TO_MINIS = 'true';
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } } };
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  assert.equal(await f.local.claim('boat-large', 'mini-a', diagnostics), null);
  assert.equal(diagnostics.reason, 'no_runnable_job');
  await f.storage.put('gh-job:1', { id: 1, pool: JSON.stringify(['o/r', 'boat-large']), status: 'in_progress', runnerName: 'boat-example', startedAt: 1000, observedAt: 1000, queuedAt: 900 });
  assert.equal(await f.local.claim('boat-large', 'mini-a', diagnostics), null);
  assert.equal(diagnostics.reason, 'boat_assigned_recently');
  await f.storage.put('gh-job:2', { id: 2, pool: JSON.stringify(['o/r', 'boat-large']), status: 'queued', queuedAt: 1000 });
  await f.storage.put('local-runner:existing', { name: 'existing', label: 'boat-large', jobId: 2, state: 'claiming', host: 'mini-b', at: 1000 });
  assert.equal(await f.local.claim('boat-large', 'mini-a', diagnostics), null);
  assert.equal(diagnostics.reason, 'local_claim_in_progress');
});

test('Boat and mini reservations do not book the same job and equivalent assignment rebooks the target', async () => {
  const f = fixture(), pool = JSON.stringify(['o/r', 'boat-large']);
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, dispatchOnly: true, sizes: { 'boat-large': { machine: 'large' } } };
  f.local.config.registeredHoldSeconds = 180;
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  await f.storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 1000 });
  await f.storage.put('gh-job:2', { id: 2, pool, status: 'queued', queuedAt: 1001 });
  await f.storage.put('box:one', { machineId: 'one', pool, state: 'idle', dispatchJobId: 1, dispatchAt: 1000 });
  const first = await f.local.claim('boat-large', 'mini-a');
  assert.ok(first);
  assert.equal((await f.storage.get(`local-runner:${first.name}`)).jobId, 2);
  await f.local.ingest({ repo: 'o/r', label: 'boat-large', id: 1, status: 'in_progress', runnerName: first.name });
  const second = await f.local.claim('boat-large', 'mini-b');
  assert.ok(second);
  assert.equal((await f.storage.get(`local-runner:${second.name}`)).jobId, 2);
});

test('idle mini capacity leaves an idle Boat runner available', async () => {
  const f = fixture();
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } } };
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [{ id: 7, name: 'boat-test', status: 'online', busy: false }] });
  await f.storage.put('box:bx_test', { machineId: 'bx_test', pool: JSON.stringify(['o/r', 'boat-large']), state: 'idle', runnerId: 7, runnerName: 'boat-test' });
  await f.storage.put('gh-job:1', { id: 1, pool: JSON.stringify(['o/r', 'boat-large']), status: 'queued', queuedAt: 1000 });
  f.runners.set(7, { id: 7, name: 'boat-test', busy: false });
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
  assert.equal(f.runners.has(7), true);
  assert.equal((await f.storage.get('box:bx_test')).state, 'idle');
  assert.equal(await f.storage.get('local-room:boat-large'), undefined);
});

test('the CI-to-minis switch stops claims and leaves Boat runners registered', async () => {
  const f = fixture();
  f.local.controller.poolProject = { repo: 'o/r' };
  f.local.controller.env.CI_TO_MINIS = 'false';
  f.local.config.holdWarmOnLocal = true;
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('box:bx_test', { machineId: 'bx_test', pool: JSON.stringify(['o/r', 'boat-large']), state: 'idle', runnerId: 7 });
  f.runners.set(7, { id: 7, busy: false });
  assert.equal(await f.local.claim('boat-large', 'mini-a'), null);
  assert.equal(f.runners.has(7), true);
  assert.equal((await f.storage.get('box:bx_test')).state, 'idle');
});

test('a no-capacity report withdraws the local heartbeat', async () => {
  const f = fixture();
  await f.storage.put('local-room:boat-large', 1000);
  assert.equal(await f.local.unavailable('boat-large'), true);
  assert.equal(await f.storage.get('local-room:boat-large'), undefined);
});

test('local claim never fences a Boat runner', async () => {
  const f = fixture(); await f.add(1);
  f.local.api.removeRunner = async () => { throw new Error('unexpected fence'); };
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
});

test('a local claim does not cancel an existing Boat reservation', async () => {
  const f = fixture(); await f.add(1);
  await f.storage.put('create:pending', { createKey: 'pending', state: 'pending' });
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
  assert.ok(await f.storage.get('create:pending'));
});

test('a booting Boat box does not reserve demand while mini capacity is fresh', async () => {
  const f = fixture();
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } } };
  f.local.config.holdWarmOnLocal = true;
  await f.storage.put('pool:mode', 'on');
  const pool = JSON.stringify(['o/r', 'boat-large']);
  await f.storage.put('local-room:boat-large', 1000);
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  await f.storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 1000 });
  await f.storage.put('box:bx_test', { machineId: 'bx_test', pool, state: 'booting', since: 1000 });
  const counts = await f.storage.transaction(tx => f.local.counts(tx, 'boat-large'));
  assert.equal(counts.jobs.length, 1);
  assert.equal(counts.supply, 0);
});

test('local claims respect workflow matrix concurrency across pools', async () => {
  const f = fixture();
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } }, workflowConcurrency: [{ workflow: 'CI', jobPrefix: 'shard', maxParallel: 1 }] };
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  const base = { workflowName: 'CI', jobName: 'shard', runId: 7, queuedAt: 1000 };
  await f.storage.put('gh-job:1', { ...base, id: 1, pool: JSON.stringify(['o/r', 'other']), status: 'in_progress' });
  await f.storage.put('gh-job:2', { ...base, id: 2, pool: JSON.stringify(['o/r', 'boat-large']), status: 'queued' });
  assert.equal((await f.storage.transaction(tx => f.local.counts(tx, 'boat-large'))).jobs.length, 0);
  await f.storage.put('gh-job:1', { ...base, id: 1, pool: JSON.stringify(['o/r', 'other']), status: 'completed' });
  assert.equal((await f.storage.transaction(tx => f.local.counts(tx, 'boat-large'))).jobs.length, 1);
});

test('a mini claim leaves busy Boat runners untouched', async () => {
  const f = fixture(); await f.add(1);
  f.runners.set(7, { id: 7, busy: true });
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
  assert.equal(f.runners.get(7).busy, true);
});

test('disabled pool modes leave legacy queued demand unclaimed before migration', async () => {
  for (const mode of [undefined, 'off', 'shadow', 'drain']) {
    const f = fixture();
    f.local.controller.poolProject = { repo: 'o/r' };
    if (mode !== undefined) await f.storage.put('pool:mode', mode);
    await f.add(1);
    assert.equal(await f.local.claim('boat-large', 'mini-a'), null);
    assert.equal(f.runners.size, 0);
    assert.equal((await f.storage.get('job:1')).phase, 'queued');
    assert.equal((await f.storage.list({ prefix: 'local-runner:' })).size, 0);
  }
});

test('claim consumes demand, excludes Boat, and returns a one-time configuration', async () => {
  const f = fixture(); await f.add(1);
  const [first, second] = await Promise.all([f.local.claim('boat-large', 'mini-a'), f.local.claim('boat-large', 'mini-a')]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal((first ?? second).jitConfig, 'fake-jit');
  assert.equal(JSON.stringify([...f.storage.data.values()]).includes('fake-jit'), false);
  f.advance(30_000);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('unclaimed demand falls through immediately', async () => {
  const f = fixture(); await f.add(1);
  const allow = () => f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' }));
  assert.equal(await allow(), true);
  f.advance(30_000);
  assert.equal(await allow(), true);
});

test('release deletes the unregistered GitHub runner before returning demand', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a');
  assert.equal(f.runners.size, 1);
  assert.equal(await f.local.release(claim.name), true);
  assert.equal(f.runners.size, 0);
  f.advance(30_000);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('a withdrawn job retires excess local supply', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a');
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentDone: true });
  await f.local.sweep();
  assert.equal(f.runners.size, 0);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
});

test('an unassigned runner times out and is deleted', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a');
  await f.local.started(claim.name);
  f.advance(60_000); await f.local.sweep();
  assert.equal(f.runners.size, 0);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('a started but unassigned runner is released at 30 seconds', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a'); await f.local.started(claim.name);
  f.advance(29_999); assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), false);
  f.advance(1); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('registered runner holds only its queued target for at most three minutes', async () => {
  const f = fixture(); f.local.config.registeredHoldSeconds = 180;
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } } };
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  await f.storage.put('gh-job:1', { id: 1, pool: JSON.stringify(['o/r', 'boat-large']), status: 'queued', queuedAt: 1000 });
  const claim = await f.local.claim('boat-large', 'mini-a'); await f.local.started(claim.name);
  f.advance(179_999); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'started');
  f.advance(1); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
});

test('registered runner releases when the target starts elsewhere', async () => {
  const f = fixture(); f.local.config.registeredHoldSeconds = 180;
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } } };
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  const job = { id: 1, pool: JSON.stringify(['o/r', 'boat-large']), status: 'queued', queuedAt: 1000 };
  await f.storage.put('gh-job:1', job);
  const claim = await f.local.claim('boat-large', 'mini-a'); await f.local.started(claim.name);
  await f.storage.put('gh-job:1', { ...job, status: 'in_progress', runnerName: 'boat-other' });
  await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
});

test('a failed removal holds supply and prevents a Boat reservation', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a');
  f.runners.get(1).busy = true;
  assert.equal(await f.local.release(claim.name), false);
  f.advance(30_000);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retiring');
});

test('a lost GitHub response retires after confirmed absence', async () => {
  const f = fixture(); await f.add(1);
  f.local.api.github = async (_job, path) => {
    if (path.includes('generate-jitconfig')) throw new Error('lost response');
    return { runners: [] };
  };
  await assert.rejects(f.local.claim('boat-large', 'mini-a'));
  f.advance(120_000); await f.local.sweep();
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('assignment follows the runner name and can bind a different job', async () => {
  const f = fixture(); await f.add(1); await f.add(2);
  const claim = await f.local.claim('boat-large', 'mini-a');
  await f.local.ingest({ id: 2, repo: 'o/r', label: 'boat-large', status: 'in_progress', runnerName: claim.name });
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).assignedJobId, 2);
});

test('Queue incident: old queued attention job cannot take a local runner offered for new demand', async () => {
  const f = fixture();
  const old = 1001, fresh = 1002;
  const t = Date.parse('2020-01-01T19:04:47Z');
  await f.storage.put(`job:${old}`, { id: old, repo: 'o/r', installation: 1, label: 'boat-large', phase: 'attention', createdAt: t, machineId: 'bx_example01', createAttemptedAt: Date.parse('2020-01-01T19:21:57.091Z'), retryCount: 1 });
  f.advance(Date.parse('2020-01-01T20:16:08Z') - 1000);
  await f.storage.put(`job:${fresh}`, { id: fresh, repo: 'o/r', installation: 1, label: 'boat-large', phase: 'queued', createdAt: Date.parse('2020-01-01T20:16:08Z') });
  // GitHub still had the old job queued, despite the router's attention phase.
  assert.equal(await f.local.claim('boat-large', 'mini-a'), null);
  assert.equal(f.runners.size, 0);
  await f.storage.put(`job:${old}`, { ...(await f.storage.get(`job:${old}`)), intentDone: true });
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
});

test('local and Boat supply cannot overlap for the same label', async () => {
  const f = fixture(); await f.add(1); await f.add(2);
  const local = await f.local.claim('boat-large', 'mini-a'); assert.ok(local);
  f.advance(30_000);
  const allow = () => f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' }));
  assert.equal(await allow(), true);
  await f.local.release(local.name);
  assert.equal(await allow(), true);
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), createPending: true, createAttemptedAt: 31_000 });
  await f.storage.put('job:2', { ...(await f.storage.get('job:2')), createdAt: 31_000 });
  assert.equal(await f.local.claim('boat-large', 'mini-a'), null);
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentStarted: true, assignedJobId: 1 });
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
});

test('unresolved Boat history fences local claims until the job starts or finishes', async () => {
  for (const history of [{ phase: 'attention' }, { localBoatHistory: true }, { createAttemptedAt: 1 }, { lastMachineId: 'bx_old' }, { retryCount: 1 }, { attempts: 1 }]) {
    const f = fixture(); await f.add(1); await f.add(2);
    await f.storage.put('job:1', { ...(await f.storage.get('job:1')), ...history });
    assert.equal(await f.local.claim('boat-large', 'mini-a'), null);
    await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentDone: true });
    assert.ok(await f.local.claim('boat-large', 'mini-a'));
  }
});

test('disabled Worker never creates a local JIT runner', async () => {
  const f = fixture(); await f.add(1);
  f.local.controller.env.ENABLED = 'false';
  assert.equal(await f.local.claim('boat-large', 'mini-a'), null);
  assert.equal(f.runners.size, 0);
});

test('uncertain runner lookup does not stop the cleanup sweep', async () => {
  const f = fixture(); await f.add(1);
  f.local.api.github = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.local.claim('boat-large', 'mini-a'));
  f.advance(120_000);
  await assert.doesNotReject(f.local.sweep());
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('started remains successful when the job event arrives first', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a');
  await f.local.ingest({ repo: 'o/r', label: 'boat-large', id: 1, runnerName: claim.name, status: 'in_progress' });
  assert.equal(await f.local.started(claim.name), true);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'assigned');
});

test('a definite refusal does not block later demand', async () => {
  const f = fixture(); await f.add(1);
  const original = f.local.api.github;
  f.local.api.github = async () => { throw Object.assign(new Error(), { status: 422 }); };
  await assert.rejects(f.local.claim('boat-large', 'mini-a'));
  const records = [...f.storage.data.entries()].filter(([key]) => key.startsWith('local-runner:')).map(([, value]) => value);
  assert.equal(records[0].state, 'retired');
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentDone: true, phase: 'done' });
  f.advance(86400000); await f.add(2); await f.storage.put('job:2', { ...(await f.storage.get('job:2')), createdAt: 86401000 }); f.local.api.github = original;
  assert.ok(await f.local.claim('boat-large', 'mini-a'));
});
test('retired and cleanup phases cannot consume new demand', async () => {
  for (const phase of ['attention', 'destroying', 'unregister', 'purging', 'reconciling']) {
    const f = fixture(); await f.add(9);
    await f.storage.put('job:9', { ...(await f.storage.get('job:9')), phase, machineId: 'bx_aaaaaaaa', intentDone: true });
    f.advance(86400000); await f.add(2); await f.storage.put('job:2', { ...(await f.storage.get('job:2')), createdAt: 86401000 });
    assert.ok(await f.local.claim('boat-large', 'mini-a'), phase);
  }
});
test('retiring alert fires once and operator can retry release', async () => {
  const f = fixture(), alerts = []; f.local.controller.emit = async (...args) => alerts.push(args);
  await f.add(1); const claim = await f.local.claim('boat-large', 'mini-a');
  f.runners.get(1).busy = true;
  assert.equal(await f.local.release(claim.name), false);
  f.advance(301000); await f.local.sweep(); await f.local.sweep();
  assert.equal(alerts.length, 1); assert.equal(alerts[0][0], 'alert_local_runner_retiring');
  f.runners.get(1).busy = false;
  assert.equal(await f.local.release(claim.name), true);
  assert.equal(await f.local.release(claim.name), true);
});

test('a stale local claim is retired at the offer deadline so Boat can serve demand', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a');
  f.advance(30_000); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
  assert.equal(f.runners.size, 0);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('offer expiry does not remove a busy local runner', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large', 'mini-a'); f.runners.get(1).busy = true;
  f.advance(30_000); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retiring');
  assert.equal(f.runners.size, 1);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('external claimer accepts a configured class without knowing its implementation', () => {
  const fleet = new LocalFleet({ storage: new Storage(), now: () => 0 }, { enabled: true, labels: { work: 'custom-pool' } });
  assert.equal(fleet.enabled('work'), true);
  assert.equal(fleet.enabled('other'), false);
  const disabled = new LocalFleet({ storage: new Storage(), now: () => 0 }, { labels: { work: 'custom-pool' } });
  assert.equal(disabled.enabled('work'), false);
});


test('a boot breaker does not block a local runner claim', async () => {
  const f = fixture(); await f.add(1);
  await f.storage.put('verification:breaker', { tripped: true });
  const claim = await f.local.claim('boat-large', 'mini-a');
  assert.ok(claim); assert.equal(claim.jitConfig, 'fake-jit');
});

test('local claims ignore a path-matched matrix whose four slots are occupied', async () => {
  const f = fixture();
  const workflowPath = '.github/workflows/full-suite.yml';
  f.local.controller.poolProject = { repo: 'o/r', installation: 1, sizes: { 'boat-large': { machine: 'large' } }, workflowConcurrency: [{ workflowPath, jobPrefix: 'browser (', maxParallel: 4 }] };
  await f.storage.put('pool:mode', 'on');
  await f.storage.put('pool:snapshot', { complete: true, runners: [] });
  const pool = JSON.stringify(['o/r', 'boat-large']);
  const base = { workflowPath, workflowName: 'dynamic-run-name', jobName: 'browser (shard)', runId: 7, queuedAt: 1000, pool };
  for (let id = 1; id <= 4; id++) await f.storage.put(`gh-job:${id}`, { ...base, id, status: 'in_progress' });
  await f.storage.put('gh-job:5', { ...base, id: 5, status: 'queued' });
  assert.equal(await f.local.claim('boat-large', 'mini-1'), null);
  await f.storage.put('gh-job:1', { ...base, id: 1, status: 'completed' });
  assert.ok(await f.local.claim('boat-large', 'mini-1'));
});
