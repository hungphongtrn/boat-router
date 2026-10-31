import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalFleet } from '../src/router/local-fleet.mjs';
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

test('disabled pool modes leave legacy queued demand unclaimed before migration', async () => {
  for (const mode of [undefined, 'off', 'shadow', 'drain']) {
    const f = fixture();
    f.local.controller.poolProject = { repo: 'o/r' };
    if (mode !== undefined) await f.storage.put('pool:mode', mode);
    await f.add(1);
    assert.equal(await f.local.claim('boat-large'), null);
    assert.equal(f.runners.size, 0);
    assert.equal((await f.storage.get('job:1')).phase, 'queued');
    assert.equal((await f.storage.list({ prefix: 'local-runner:' })).size, 0);
  }
});

test('claim consumes demand, excludes Boat, and returns a one-time configuration', async () => {
  const f = fixture(); await f.add(1);
  const [first, second] = await Promise.all([f.local.claim('boat-large'), f.local.claim('boat-large')]);
  assert.equal([first, second].filter(Boolean).length, 1);
  assert.equal((first ?? second).jitConfig, 'fake-jit');
  assert.equal(JSON.stringify([...f.storage.data.values()]).includes('fake-jit'), false);
  f.advance(30_000);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), false);
});

test('unclaimed demand falls through only after the offer window', async () => {
  const f = fixture(); await f.add(1);
  const allow = () => f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' }));
  assert.equal(await allow(), false);
  f.advance(30_000);
  assert.equal(await allow(), true);
});

test('release deletes the unregistered GitHub runner before returning demand', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large');
  assert.equal(f.runners.size, 1);
  assert.equal(await f.local.release(claim.name), true);
  assert.equal(f.runners.size, 0);
  f.advance(30_000);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('a withdrawn job retires excess local supply', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large');
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentDone: true });
  await f.local.sweep();
  assert.equal(f.runners.size, 0);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
});

test('an unassigned runner times out and is deleted', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large');
  await f.local.started(claim.name);
  f.advance(60_000); await f.local.sweep();
  assert.equal(f.runners.size, 0);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('a started runner remains claimed after the offer window', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large');
  await f.local.started(claim.name);
  f.advance(30_000); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'started');
  assert.equal(f.runners.size, 1);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), false);
});

test('a failed removal holds supply and prevents a Boat reservation', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large');
  f.runners.get(1).busy = true;
  assert.equal(await f.local.release(claim.name), false);
  f.advance(30_000);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), false);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retiring');
});

test('a lost GitHub response retires after confirmed absence', async () => {
  const f = fixture(); await f.add(1);
  f.local.api.github = async (_job, path) => {
    if (path.includes('generate-jitconfig')) throw new Error('lost response');
    return { runners: [] };
  };
  await assert.rejects(f.local.claim('boat-large'));
  f.advance(120_000); await f.local.sweep();
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('assignment follows the runner name and can bind a different job', async () => {
  const f = fixture(); await f.add(1); await f.add(2);
  const claim = await f.local.claim('boat-large');
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
  assert.equal(await f.local.claim('boat-large'), null);
  assert.equal(f.runners.size, 0);
  await f.storage.put(`job:${old}`, { ...(await f.storage.get(`job:${old}`)), intentDone: true });
  assert.ok(await f.local.claim('boat-large'));
});

test('local and Boat supply cannot overlap for the same label', async () => {
  const f = fixture(); await f.add(1); await f.add(2);
  const local = await f.local.claim('boat-large'); assert.ok(local);
  f.advance(30_000);
  const allow = () => f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' }));
  assert.equal(await allow(), false);
  await f.local.release(local.name);
  assert.equal(await allow(), true);
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), createPending: true, createAttemptedAt: 31_000 });
  await f.storage.put('job:2', { ...(await f.storage.get('job:2')), createdAt: 31_000 });
  assert.equal(await f.local.claim('boat-large'), null);
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentStarted: true, assignedJobId: 1 });
  assert.ok(await f.local.claim('boat-large'));
});

test('unresolved Boat history fences local claims until the job starts or finishes', async () => {
  for (const history of [{ phase: 'attention' }, { localBoatHistory: true }, { createAttemptedAt: 1 }, { lastMachineId: 'bx_old' }, { retryCount: 1 }, { attempts: 1 }]) {
    const f = fixture(); await f.add(1); await f.add(2);
    await f.storage.put('job:1', { ...(await f.storage.get('job:1')), ...history });
    assert.equal(await f.local.claim('boat-large'), null);
    await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentDone: true });
    assert.ok(await f.local.claim('boat-large'));
  }
});

test('disabled Worker never creates a local JIT runner', async () => {
  const f = fixture(); await f.add(1);
  f.local.controller.env.ENABLED = 'false';
  assert.equal(await f.local.claim('boat-large'), null);
  assert.equal(f.runners.size, 0);
});

test('uncertain runner lookup does not stop the cleanup sweep', async () => {
  const f = fixture(); await f.add(1);
  f.local.api.github = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.local.claim('boat-large'));
  f.advance(120_000);
  await assert.doesNotReject(f.local.sweep());
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), false);
});

test('started remains successful when the job event arrives first', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large');
  await f.local.ingest({ repo: 'o/r', label: 'boat-large', id: 1, runnerName: claim.name, status: 'in_progress' });
  assert.equal(await f.local.started(claim.name), true);
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'assigned');
});

test('a definite refusal does not block later demand', async () => {
  const f = fixture(); await f.add(1);
  const original = f.local.api.github;
  f.local.api.github = async () => { throw Object.assign(new Error(), { status: 422 }); };
  await assert.rejects(f.local.claim('boat-large'));
  const records = [...f.storage.data.entries()].filter(([key]) => key.startsWith('local-runner:')).map(([, value]) => value);
  assert.equal(records[0].state, 'retired');
  await f.storage.put('job:1', { ...(await f.storage.get('job:1')), intentDone: true, phase: 'done' });
  f.advance(86400000); await f.add(2); await f.storage.put('job:2', { ...(await f.storage.get('job:2')), createdAt: 86401000 }); f.local.api.github = original;
  assert.ok(await f.local.claim('boat-large'));
});
test('retired and cleanup phases cannot consume new demand', async () => {
  for (const phase of ['attention', 'destroying', 'unregister', 'purging', 'reconciling']) {
    const f = fixture(); await f.add(9);
    await f.storage.put('job:9', { ...(await f.storage.get('job:9')), phase, machineId: 'bx_aaaaaaaa', intentDone: true });
    f.advance(86400000); await f.add(2); await f.storage.put('job:2', { ...(await f.storage.get('job:2')), createdAt: 86401000 });
    assert.ok(await f.local.claim('boat-large'), phase);
  }
});
test('retiring alert fires once and operator can retry release', async () => {
  const f = fixture(), alerts = []; f.local.controller.emit = async (...args) => alerts.push(args);
  await f.add(1); const claim = await f.local.claim('boat-large');
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
  const claim = await f.local.claim('boat-large');
  f.advance(30_000); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retired');
  assert.equal(f.runners.size, 0);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), true);
});

test('offer expiry does not remove a busy local runner', async () => {
  const f = fixture(); await f.add(1);
  const claim = await f.local.claim('boat-large'); f.runners.get(1).busy = true;
  f.advance(30_000); await f.local.sweep();
  assert.equal((await f.storage.get(`local-runner:${claim.name}`)).state, 'retiring');
  assert.equal(f.runners.size, 1);
  assert.equal(await f.storage.transaction(tx => f.local.allowBoat(tx, { label: 'boat-large' })), false);
});

test('external claimer accepts a configured class without knowing its implementation', () => {
  const fleet = new LocalFleet({ storage: new Storage(), now: () => 0 }, { enabled: true, labels: { work: 'custom-pool' } });
  assert.equal(fleet.enabled('work'), true);
  assert.equal(fleet.enabled('other'), false);
  const disabled = new LocalFleet({ storage: new Storage(), now: () => 0 }, { labels: { work: 'custom-pool' } });
  assert.equal(disabled.enabled('work'), false);
});
