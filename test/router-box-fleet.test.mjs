import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet, healthGateFromLimits, effectiveHealthMode, slowBoxYields, reuseHealthMode } from '../src/router/box-fleet.mjs';

const box = { machineId: 'bx_23456789', runnerId: 1, state: 'idle' };

test('shadow retirement preview excludes busy runners and cancels pending supply first', () => {
  const fleet = new BoxFleet(null, null), pool = 'p';
  const input = { pools: [{ key: pool }], jobs: [], now: 200_000, complete: true, units: [
    { pool, kind: 'create', state: 'pending' },
    { pool, machineId: 'idle', state: 'idle', since: 0, online: true },
    { pool, machineId: 'busy', state: 'idle', since: 0, online: true, busy: true },
  ] };
  assert.deepEqual(fleet.preview(input).retire, [{ pool, machineId: 'idle', observedBusy: false }]);
  assert.deepEqual(fleet.preview({ ...input, complete: false }).retire, []);
});

test('retirement fences an idle runner before destroying its recorded box', async () => {
  const storage = new Storage(), calls = [];
  await storage.put(`box:${box.machineId}`, box);
  const fleet = new BoxFleet(storage, { removeRunner: async () => calls.push('runner'), destroy: async () => { calls.push('box'); return { operation: { id: 'op' } }; } });
  assert.equal(await fleet.destroy(box.machineId), false);
  assert.equal(await fleet.retire(box.machineId), true);
  assert.equal(await fleet.destroy(box.machineId), true);
  assert.deepEqual(calls, ['runner', 'box']);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'purging');
});

test('a runner assigned during retirement is never destroyed', async () => {
  const storage = new Storage(); await storage.put(`box:${box.machineId}`, box);
  let destroys = 0;
  const fleet = new BoxFleet(storage, { removeRunner: async () => { throw Object.assign(new Error(), { status: 422 }); }, destroy: async () => { destroys++; } });
  assert.equal(await fleet.retire(box.machineId), false);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'busy');
  assert.equal(await fleet.destroy(box.machineId), false);
  assert.equal(destroys, 0);
});

test('admission persists its key before provider creation and records the resulting box', async () => {
  const storage = new Storage(); let claim;
  const budget = {
    claimKey: async () => 'a'.repeat(64),
    enqueue: async () => {}, claim: async () => claim,
    admit: async () => { claim = { status: 'pending' }; return { ok: true }; },
    begin: async () => { claim.status = 'calling'; return true; },
    settle: async (_key, status) => { claim.status = status; return true; },
  };
  const fleet = new BoxFleet(storage, { create: async unit => {
    assert.equal((await storage.get(`create:${unit.createKey}`)).state, 'calling');
    return { sandbox: { id: box.machineId } };
  } }, () => 100, { budget });
  const [record] = await fleet.prepare('pool', 'large', 1, 1);
  assert.equal(await fleet.admit(record.createKey, {}, 3600), true);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'booting');
  assert.equal((await storage.get(`box:${box.machineId}`)).machineTtlSeconds, 3600);
  assert.equal(await storage.get(`create:${record.createKey}`), undefined);
  assert.equal(claim.status, 'created');
});

test('uncertain create stays charged until an absent lookup reaches the reconciliation window', async () => {
  const storage = new Storage(); let clock = 0, claim, settled = [];
  const budget = {
    claimKey: async () => 'a'.repeat(64), enqueue: async () => {}, claim: async () => claim,
    admit: async () => { claim = { status: 'pending' }; return { ok: true }; },
    begin: async () => { claim = { status: 'calling', callingAt: clock }; return true; },
    settle: async (_key, status) => { settled.push(status); if (status === 'not_created') claim = null; else claim.status = status; return true; },
  };
  const fleet = new BoxFleet(storage, { create: async () => { throw new Error('timeout'); }, findCreated: async () => null }, () => clock, { budget });
  const [record] = await fleet.prepare('pool', 'large', 1, 0);
  assert.equal(await fleet.admit(record.createKey, {}, 3600), false);
  assert.equal((await storage.get(`create:${record.createKey}`)).state, 'unknown');
  clock = 299_999; await fleet.admit(record.createKey, {}, 3600);
  assert.deepEqual(settled, ['unknown']);
  clock = 300_000; await fleet.admit(record.createKey, {}, 3600);
  assert.deepEqual(settled, ['unknown', 'not_created']);
  assert.equal(await storage.get(`create:${record.createKey}`), undefined);
});

test('HTTP 408 create remains uncertain and a 429 starts provider backoff', async () => {
  for (const status of [408, 429]) {
    const storage = new Storage(); let claim;
    const budget = { claimKey: async () => 'a'.repeat(64), enqueue: async () => {}, claim: async () => claim,
      admit: async () => { claim = { status: 'pending' }; return { ok: true }; },
      begin: async () => { claim.status = 'calling'; return true; },
      settle: async (_key, state) => { claim.status = state; return true; } };
    const fleet = new BoxFleet(storage, { create: async () => { throw { service: 'boat', status, retrySeconds: 60 }; } }, () => 100, { budget });
    const [record] = await fleet.prepare('pool', 'large', 1, 0);
    await fleet.admit(record.createKey, {}, 3600);
    assert.equal(claim.status, status === 408 ? 'unknown' : 'not_created');
    assert.equal(await storage.get('startBackoffUntil'), status === 429 ? 60_100 : undefined);
  }
});

test('hard deadlines trigger at their boundaries and offline removal needs a complete snapshot', async () => {
  const { boxDeadline } = await import('../src/router/box-fleet.mjs');
  assert.equal(boxDeadline({ state: 'booting', since: 0 }, 899_999), null);
  assert.equal(boxDeadline({ state: 'booting', since: 0 }, 900_000), 'boot_timeout');
  assert.equal(boxDeadline({ state: 'baseline', since: 0 }, 300_000), 'baseline_timeout');
  assert.equal(boxDeadline({ state: 'registering', since: 0 }, 120_000), 'registration_timeout');
  assert.equal(boxDeadline({ state: 'resetting', since: 0 }, 1, { reuseEnabled: false }), 'reuse_off');
  const storage = new Storage(); await storage.put(`box:${box.machineId}`, { ...box, since: 0 });
  let calls = 0;
  const fleet = new BoxFleet(storage, { removeRunner: async () => { calls++; } }, () => 120_000);
  assert.equal(await fleet.deadline(box.machineId, { snapshotComplete: false }), null);
  assert.equal(calls, 0);
  assert.equal(await fleet.deadline(box.machineId, { snapshotComplete: true }), 'offline_timeout');
  assert.equal(calls, 1);
});

test('an idle box is not counted offline by a snapshot older than its runner start', async () => {
  const { boxDeadline } = await import('../src/router/box-fleet.mjs');
  const storage = new Storage(); let now = 500_000;
  await storage.put(`box:${box.machineId}`, { ...box, runnerName: 'boat-demo-g3', since: 400_000, startedAt: 400_000, everOnline: false });
  const fleet = new BoxFleet(storage, {}, () => now);
  await fleet.stepBox(box.machineId, { complete: true, at: 300_000, runners: [], jobs: [] });
  let record = await storage.get(`box:${box.machineId}`);
  assert.equal(record.runnerUnseen, true);
  assert.equal(record.offlineSince, null);
  assert.equal(boxDeadline(record, 900_000), null);
  await fleet.stepBox(box.machineId, { complete: true, at: 450_000, runners: [], jobs: [] });
  record = await storage.get(`box:${box.machineId}`);
  assert.equal(record.runnerUnseen, false);
  assert.equal(boxDeadline(record, 900_000), 'offline_timeout');
});

test('booted reusable box baselines and registers the machine generation', async () => {
  const storage = new Storage(); let now = 0, started;
  const machine = { machineId: box.machineId, pool: JSON.stringify(['owner/repo', 'boat-large']), state: 'booting', since: 0, generation: 0, reusable: true };
  await storage.put(`box:${box.machineId}`, machine);
  const api = {
    sandbox: async () => ({ sandbox: { state: 'ready', setupStatus: 'done' } }),
    refresh: async (_box, mode, generation) => { assert.equal(mode, 'baseline'); assert.equal(generation, 0); return { processId: 4 }; },
    refreshResult: async () => ({ ok: true, baselineHash: 'a'.repeat(64) }),
    configure: async (unit, save) => { assert.equal(unit.runnerIdentity, `boat-demo-${box.machineId}-g0`); await save(7); },
    start: async unit => { started = unit; return { success: true }; },
  };
  const fleet = new BoxFleet(storage, api, () => now, { project: { id: 'demo' }, installation: 1 });
  await fleet.stepBox(box.machineId); now = 10;
  await fleet.stepBox(box.machineId); await fleet.stepBox(box.machineId);
  const result = await storage.get(`box:${box.machineId}`);
  assert.equal(result.state, 'idle'); assert.equal(result.generation, 0);
  assert.equal(started.boxGeneration, true); assert.equal(started.generation, 0);
  assert.equal((await storage.get(`runner:${result.runnerName}`)).machineId, box.machineId);
});

test('an online runner is marked busy before offline deadline and a finished box resets to next generation', async () => {
  const storage = new Storage(); let now = 200_000;
  await storage.put(`box:${box.machineId}`, { ...box, since: 0, startedAt: 0, runnerName: 'r', reusable: true, generation: 0, baselineHash: 'a'.repeat(64) });
  const api = { lightReset: async (_box, generation) => { assert.equal(generation, 1); return { processId: 8 }; }, lightResetResult: async () => ({ ok: true, baselineHash: 'a'.repeat(64) }) };
  const fleet = new BoxFleet(storage, api, () => now);
  await fleet.stepBox(box.machineId, { complete: true, runners: [{ name: 'r', status: 'online', busy: true }] });
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'busy');
  await fleet.stepBox(box.machineId, { complete: false, runners: [] }, { reuseEnabled: true });
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'busy');
  await fleet.stepBox(box.machineId, { complete: true, runners: [] }, { reuseEnabled: true });
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'resetting');
  now++;
  await fleet.stepBox(box.machineId, { complete: true, runners: [] }, { reuseEnabled: true });
  const result = await storage.get(`box:${box.machineId}`);
  assert.equal(result.state, 'ready'); assert.equal(result.generation, 1);
});

test('three distinct online failures trip the breaker and repeats do not double-count', async () => {
  const storage = new Storage(), fleet = new BoxFleet(storage, {}, () => 1);
  for (const id of ['a', 'b', 'c']) {
    const unit = { machineId: id, size: 'large', generation: 0 };
    await fleet.verificationOutcome(unit, 'online', false);
    await fleet.verificationOutcome(unit, 'online', false);
  }
  const breaker = await storage.get('verification:breaker');
  assert.equal(breaker.counts.large, 3);
  assert.equal(breaker.tripped, true);
});

test('repeated reset failures retire boxes without blocking fresh starts', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-large']);
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large', 'boat-default'], sizes: { 'boat-large': { machine: 'large' }, 'boat-default': { machine: 'default' } } };
  const fleet = new BoxFleet(storage, { lightReset: async () => ({ processId: 1 }), lightResetResult: async () => ({ ok: false }) }, () => 1000, { project });
  for (let i = 0; i < 3; i++) {
    const machineId = `box-${i}`;
    await storage.put(`box:${machineId}`, { machineId, pool, size: 'large', state: 'finished', since: 0, generation: 0, reusable: true, baselineHash: 'a'.repeat(64) });
    await fleet.stepBox(machineId, {}, { reuseEnabled: true });
    await fleet.stepBox(machineId, {}, { reuseEnabled: true });
    assert.equal((await storage.get(`box:${machineId}`)).state, 'destroying');
  }
  assert.notEqual((await storage.get('verification:breaker'))?.tripped, true);
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 0 });
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  const result = await fleet.tick({ mode: 'shadow', project, env: { ENABLED: 'true' } });
  assert.equal(result[pool].create, 1);
});

test('reset failure records and logs its diagnostic before retiring the box', async () => {
  const storage = new Storage(), logs = [];
  const diagnostic = { ok: false, step: 'clean work dir', exitCode: 2, output: 'permission denied' };
  const fleet = new BoxFleet(storage, { lightResetResult: async () => diagnostic }, () => 1000, { project: { id: 'demo' }, logger: line => logs.push(JSON.parse(line)) });
  await storage.put('box:machine', { machineId: 'machine', state: 'resetting', generation: 1, processId: 2 });
  await fleet.stepBox('machine');
  assert.equal((await storage.get('box:machine')).state, 'destroying');
  const failure = await storage.get('verification:attempt:failure:machine:1');
  assert.deepEqual(JSON.parse(failure.message), { step: diagnostic.step, exitCode: 2, output: diagnostic.output });
  assert.deepEqual(logs.find(line => line.kind === 'reset_failed').detail, JSON.parse(failure.message));
});

test('a reused box cannot register outside its project and label', async () => {
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large', 'boat-default'], sizes: { 'boat-large': { machine: 'large' }, 'boat-default': { machine: 'default' } } };
  for (const pool of [JSON.stringify(['other/repo', 'boat-large']), JSON.stringify(['owner/repo', 'boat-default'])]) {
    const storage = new Storage(); let registrations = 0;
    const fleet = new BoxFleet(storage, { configure: async () => { registrations++; } }, () => 1000, { project, installation: 1 });
    await storage.put(`box:${box.machineId}`, { machineId: box.machineId, pool, originPool: JSON.stringify(['owner/repo', 'boat-large']), state: 'ready', generation: 1, since: 0, reusable: true });
    await fleet.stepBox(box.machineId);
    assert.equal(registrations, 0);
    assert.equal((await storage.get(`box:${box.machineId}`)).state, 'destroying');
  }
});

test('reused runner registration failure records safe API details and quarantines', async () => {
  const project = { id: 'demo', repo: 'owner/repo', sizes: { 'boat-large': { machine: 'large' } } };
  const pool = JSON.stringify([project.repo, 'boat-large']), storage = new Storage(), logs = [];
  await storage.put(`box:${box.machineId}`, { machineId: box.machineId, pool, originPool: pool, state: 'ready', generation: 1, since: 0, reusable: true });
  const api = { configure: async () => { throw Object.assign(new Error('secret-value'), { service: 'github', status: 503 }); } };
  const fleet = new BoxFleet(storage, api, () => 1000, { project, installation: 1, logger: line => logs.push(JSON.parse(line)) });
  await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'quarantined');
  const failure = await storage.get(`verification:attempt:failure:${box.machineId}:1`);
  const detail = { step: 're-register runner', exitCode: null, output: '', service: 'github', status: 503 };
  assert.deepEqual(JSON.parse(failure.message), detail);
  assert.deepEqual(logs.find(line => line.kind === 'registration_uncertain').detail, detail);
  assert.doesNotMatch(JSON.stringify({ failure, logs }), /secret-value/);
});

test('shadow planning never creates or writes even with uncovered demand', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-large']);
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 0 });
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  const before = structuredClone([...storage.data]);
  const fleet = new BoxFleet(storage, new Proxy({}, { get() { throw new Error('unexpected API access'); } }), () => 60_000);
  const result = await fleet.tick({ mode: 'shadow', env: { ENABLED: 'true' }, project: { repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } } } });
  assert.equal(result[pool].create, 1);
  assert.deepEqual([...storage.data], before);
});

test('active controller refuses work until migration is complete', async () => {
  const storage = new Storage(); const fleet = new BoxFleet(storage, {}, () => 0);
  await assert.rejects(fleet.tick({ mode: 'on', project: { repo: 'owner/repo', labels: [] } }), /migration required/);
});

test('two distinct idle snapshots fence a previously busy runner before reuse', async () => {
  const storage = new Storage(); let calls = 0;
  await storage.put(`box:${box.machineId}`, { ...box, state: 'busy', runnerName: 'runner', since: 0, jobs: 0 });
  const fleet = new BoxFleet(storage, { removeRunner: async () => { calls++; } }, () => 100);
  const runner = { name: 'runner', id: 1, status: 'online', busy: false };
  await fleet.stepBox(box.machineId, { complete: true, at: 1, runners: [runner] });
  await fleet.stepBox(box.machineId, { complete: true, at: 1, runners: [runner] });
  assert.equal(calls, 0);
  await fleet.stepBox(box.machineId, { complete: true, at: 2, runners: [runner] });
  assert.equal(calls, 1);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'finished');
});

test('busy box can be destroyed only at TTL and its runner is unregistered afterward', async () => {
  const storage = new Storage(); let destroyed = 0, removed = 0;
  await storage.put(`box:${box.machineId}`, { ...box, state: 'busy', createdAt: 0, since: 0 });
  const fleet = new BoxFleet(storage, { destroy: async () => { destroyed++; return { operation: { id: 'op' } }; }, removeRunner: async () => { removed++; } }, () => 1_000);
  await fleet.stepBox(box.machineId, {}, { ttlSeconds: 2 });
  assert.equal(destroyed, 0);
  await fleet.stepBox(box.machineId, {}, { ttlSeconds: 1 });
  assert.equal(destroyed, 1);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'unregister');
  await fleet.stepBox(box.machineId);
  assert.equal(removed, 1);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'purging');
});

test('a 422 during completion fencing does not count the job twice', async () => {
  const storage = new Storage(); let calls = 0;
  await storage.put(`box:${box.machineId}`, { ...box, state: 'busy', runnerName: 'runner', since: 0, jobs: 0 });
  const fleet = new BoxFleet(storage, { removeRunner: async () => { calls++; if (calls === 1) throw Object.assign(new Error(), { status: 422 }); } }, () => 100);
  const runner = { name: 'runner', id: 1, status: 'online', busy: false };
  await fleet.stepBox(box.machineId, { complete: true, at: 1, runners: [runner], jobs: [{ status: 'completed', runnerName: 'runner' }] });
  assert.equal((await storage.get(`box:${box.machineId}`)).jobs, 0);
  await fleet.stepBox(box.machineId, { complete: true, at: 2, runners: [runner], jobs: [{ status: 'completed', runnerName: 'runner' }] });
  assert.equal((await storage.get(`box:${box.machineId}`)).jobs, 1);
});

test('unclaimed demand keeps its uncalled Boat create', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-large']);
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: 1, complete: true, runners: [] });
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 1000 });
  await storage.put('create:key', { pool, createKey: 'key', state: 'pending', at: 0 });
  let cancelled = 0;
  const budget = { claim: async () => ({ status: 'pending' }), cancelPending: async () => { cancelled++; return true; } };
  const fleet = new BoxFleet(storage, {}, () => 10_000, { budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: { repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, localFirst: { enabled: true, labels: { 'boat-large': 'generic' } } } });
  assert.equal(cancelled, 0);
  assert.ok(await storage.get('create:key'));
});

test('pool tick starts a box for uncovered demand and follows the assigned runner', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-large']);
  const claims = new Map(); let now = 100_000, creates = 0, destroys = 0;
  const budget = {
    claimKey: async () => 'a'.repeat(64), enqueue: async () => {}, claim: async key => claims.get(key),
    admit: async key => { claims.set(key, { status: 'pending' }); return { ok: true }; },
    begin: async key => { claims.set(key, { status: 'calling', callingAt: now }); return true; },
    settle: async (key, status) => { claims.set(key, { status }); return true; },
  };
  const api = {
    limits: async () => ({ canStart: true, machineTypes: [{ type: 'large', available: true }] }), create: async () => { creates++; return { sandbox: { id: box.machineId } }; },
    sandbox: async () => ({ sandbox: { state: 'ready', setupStatus: 'done' } }),
    configure: async (_unit, save) => save(7), start: async () => ({ success: true }),
    destroy: async () => { destroys++; return { operation: { id: 'op' } }; },
    deletion: async () => ({ operation: { status: 'completed' } }),
  };
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, caps: { concurrent: 2 } };
  const fleet = new BoxFleet(storage, api, () => now, { budget, project, installation: 1 });
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: now, complete: true, runners: [] });
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 0 });
  const tick = () => fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project });
  await tick(); assert.equal(creates, 1);
  now++; await tick(); now++; await tick();
  const name = (await storage.get(`box:${box.machineId}`)).runnerName;
  await storage.put('gh-job:1', { id: 1, pool, status: 'in_progress', runnerName: name, queuedAt: 0 });
  await storage.put('pool:snapshot', { at: ++now, complete: true, runners: [{ id: 7, name, status: 'online', busy: true }] });
  await tick(); assert.equal((await storage.get(`box:${box.machineId}`)).state, 'busy');
  await storage.put('gh-job:1', { id: 1, pool, status: 'completed', runnerName: name, queuedAt: 0 });
  await storage.put('pool:snapshot', { at: ++now, complete: true, runners: [] });
  await tick(); now++; await tick(); now++; await tick();
  assert.equal(creates, 1); assert.equal(destroys, 1);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'deleted');
});

test('a provider limits outage does not prevent cleanup of a separate box', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-large']);
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: 1, complete: true, runners: [] });
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 0 });
  await storage.put('create:key', { pool, size: 'large', createKey: 'key', state: 'pending', at: 0 });
  await storage.put(`box:${box.machineId}`, { machineId: box.machineId, pool, state: 'destroying', since: 0 });
  let destroys = 0;
  const budget = { claim: async () => ({ status: 'pending' }) };
  const fleet = new BoxFleet(storage, { limits: async () => { throw new Error('outage'); }, destroy: async () => { destroys++; return { operation: { id: 'op' } }; } }, () => 60_000, { budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: { repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } } } });
  assert.equal(destroys, 1);
});

test('orphan sweep adopts only project ledger sandboxes and fences a busy runner', async () => {
  const storage = new Storage(), accountStorage = new Storage(), id = 'bx_23456789', name = `boat-demo-${id}-g0`, hash = 'a'.repeat(64);
  await accountStorage.put('account:ledger', { claims: { [hash]: { project: 'demo', status: 'created' } } });
  const api = { listSandboxes: async () => [{ id, name: `boat-router-${hash.slice(0, 32)}` }, { id: 'bx_2345678a', name: 'unrelated' }] };
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large'] };
  const fleet = new BoxFleet(storage, api, () => 100, { project, installation: 4, budget: { ledger: { storage: accountStorage, key: 'account:ledger' } } });
  const snapshot = { complete: true, runners: [{ id: 9, name, busy: true, status: 'online' }] };
  await fleet.sweepOrphans(snapshot, project);
  assert.equal((await storage.get(`box:${id}`)).drainOnly, true);
  assert.equal(await storage.get('box:bx_2345678a'), undefined);
  await fleet.stepBox(id, snapshot);
  assert.equal((await storage.get(`box:${id}`)).state, 'busy');
});

test('orphan sweep releases a create whose provider call never answered', async () => {
  const storage = new Storage(), accountStorage = new Storage(), hash = 'b'.repeat(64), name = `boat-router-${hash.slice(0, 32)}`;
  await accountStorage.put('account:ledger', { claims: {} });
  await storage.put('create:gone', { createKey: 'gone', routerCreateName: name, state: 'unknown', at: 0, callingAt: 0 });
  const api = { listSandboxes: async () => [] };
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large'] };
  const fleet = new BoxFleet(storage, api, () => 300_000, { project, budget: { ledger: { storage: accountStorage, key: 'account:ledger' } } });
  await fleet.sweepOrphans({ complete: true, runners: [] }, project);
  assert.equal(await storage.get('create:gone'), undefined);
});

test('orphan sweep keeps a create its sandbox answers for, one still claimed, and one inside the grace', async () => {
  const storage = new Storage(), accountStorage = new Storage(), hash = 'c'.repeat(64), name = `boat-router-${hash.slice(0, 32)}`;
  await accountStorage.put('account:ledger', { claims: { [hash]: { project: 'demo', status: 'unknown' } } });
  await storage.put('create:listed', { createKey: 'listed', routerCreateName: 'boat-router-listed', state: 'unknown', at: 0, callingAt: 0 });
  await storage.put('create:claimed', { createKey: 'claimed', routerCreateName: name, state: 'unknown', at: 0, callingAt: 0 });
  await storage.put('create:young', { createKey: 'young', routerCreateName: 'boat-router-young', state: 'unknown', at: 299_000, callingAt: 299_000 });
  await storage.put('create:pending', { createKey: 'pending', routerCreateName: 'boat-router-pending', state: 'pending', at: 0 });
  const api = { listSandboxes: async () => [{ id: 'bx_23456789', name: 'boat-router-listed' }] };
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large'] };
  const fleet = new BoxFleet(storage, api, () => 300_000, { project, budget: { ledger: { storage: accountStorage, key: 'account:ledger' } } });
  await fleet.sweepOrphans({ complete: true, runners: [] }, project);
  for (const key of ['listed', 'claimed', 'young', 'pending']) assert.notEqual(await storage.get(`create:${key}`), undefined, key);
});

test('orphan waits for a named running job before cleanup', async () => {
  const storage = new Storage(), id = 'bx_23456789', name = `boat-demo-${id}-g0`;
  await storage.put(`box:${id}`, { machineId: id, state: 'quarantined', drainOnly: true, orphan: true, aliases: [name], noRunnerKnown: false });
  const fleet = new BoxFleet(storage, {}, () => 1, { project: { id: 'demo' } });
  await fleet.stepBox(id, { complete: true, runners: [], jobs: [{ status: 'in_progress', runnerName: name }] });
  assert.equal((await storage.get(`box:${id}`)).state, 'quarantined');
  await fleet.stepBox(id, { complete: true, runners: [], jobs: [] });
  assert.equal((await storage.get(`box:${id}`)).state, 'destroying');
});

test('orphan sweep resumes after adoption commits without adopting twice', async () => {
  const storage = new Storage(), accountStorage = new Storage(), hash = 'a'.repeat(64), id = 'bx_23456789';
  await accountStorage.put('account:ledger', { claims: { [hash]: { project: 'demo', status: 'created' } } });
  const api = { listSandboxes: async () => [{ id, name: `boat-router-${hash.slice(0, 32)}` }] };
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large'] };
  const fleet = new BoxFleet(storage, api, () => 100, { project, budget: { ledger: { storage: accountStorage, key: 'account:ledger' } } });
  const tx = storage.transaction.bind(storage); let interrupt = true;
  storage.transaction = async fn => { const result = await tx(fn); if (interrupt) { interrupt = false; throw new Error('interrupted after commit'); } return result; };
  await assert.rejects(fleet.sweepOrphans({ complete: true, runners: [] }, project), /interrupted/);
  assert.equal((await storage.get(`box:${id}`)).drainOnly, true);
  assert.equal(await storage.get('pool:orphan-sweep'), undefined);
  await fleet.sweepOrphans({ complete: true, runners: [] }, project);
  assert.equal((await storage.list({ prefix: 'box:' })).size, 1);
  assert.equal(await storage.get('pool:orphan-sweep'), 100);
});

test('project cap admits the oldest uncovered job across its pools', async () => {
  const storage = new Storage(), enqueued = [];
  const project = { id: 'example', repo: 'example/repo', labels: ['newer', 'older'], sizes: { newer: { machine: 'large' }, older: { machine: 'large' } }, caps: { concurrent: 1 } };
  const budget = { claimKey: async key => key, enqueue: async (key, at) => enqueued.push({ key, at }) };
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  for (const [label, at] of [['newer', 200], ['older', 100]]) await storage.put(`gh-job:${at}`, { id: at, pool: JSON.stringify([project.repo, label]), status: 'queued', queuedAt: at });
  const fleet = new BoxFleet(storage, {}, () => 1000, { project, budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, prepareOnly: true });
  const creates = [...(await storage.list({ prefix: 'create:' })).values()];
  assert.equal(creates.length, 1);
  assert.equal(JSON.parse(creates[0].pool)[1], 'older');
  assert.ok(enqueued.every(item => item.at === 100));
});

test('an older discovered job replaces an uncalled newer reservation under a project cap', async () => {
  const storage = new Storage(), enqueued = [], cancelled = [];
  const project = { id: 'sample', repo: 'example/repo', labels: ['newer', 'older'], sizes: { newer: { machine: 'large' }, older: { machine: 'large' } }, caps: { concurrent: 1 } };
  const key = label => JSON.stringify([project.repo, label]);
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  for (const [label, at] of [['newer', 200], ['older', 100]]) await storage.put(`gh-job:${at}`, { id: at, pool: key(label), status: 'queued', queuedAt: at });
  await storage.put('create:newer', { createKey: 'newer', pool: key('newer'), size: 'large', state: 'pending', queuedAt: 200, at: 200 });
  const budget = { claim: async () => ({ status: 'pending' }), cancelPending: async id => { cancelled.push(id); return true; }, claimKey: async id => id, enqueue: async (_id, at) => enqueued.push(at) };
  const fleet = new BoxFleet(storage, {}, () => 1000, { project, budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, prepareOnly: true });
  const creates = [...(await storage.list({ prefix: 'create:' })).values()];
  assert.deepEqual(cancelled, ['newer']);
  assert.equal(creates.length, 1); assert.equal(creates[0].queuedAt, 100);
  assert.ok(enqueued.every(at => at === 100));
});

test('local-only demand never creates Boat supply, including after the offer window', async () => {
  const { poolKey } = await import('../src/router/pool.mjs');
  const { AccountLedger } = await import('../src/router/ledger.mjs');
  const { SharedBudget } = await import('../src/router/shared-budget.mjs');
  const storage = new Storage(), ledger = new Storage(), now = 300_000;
  const label = 'sample-trial', pool = poolKey('owner/repo', label);
  const project = { id: 'sample', repo: 'owner/repo', labels: [label], sizes: { [label]: { machine: 'default' } }, localFirst: { enabled: true, labels: { [label]: 'browser' }, localOnly: [label] } };
  const budget = new SharedBudget(new AccountLedger(ledger, { requireConcurrency: true }, () => now), project.id, () => now);
  let creates = 0;
  const api = { limits: async () => ({canStart: true, activeSandboxes: 0, maxActiveSandboxes: 8, machineTypes: [{type:'default',available:true}]}), create: async () => { creates++; throw new Error('unexpected create'); } };
  await storage.put('pool:migrated', {done:true});
  await storage.put('pool:snapshot', {complete:true, runners:[]});
  await storage.put('gh-job:1', {id:1,pool,status:'queued',queuedAt:0});
  const fleet = new BoxFleet(storage, api, () => now, {project,budget});
  const actual = await fleet.tick({mode:'on',env:{ENABLED:'true'},project});
  assert.equal(actual[pool].reason, 'local_only');
  assert.equal(actual[pool].create, 0);
  assert.equal((await storage.list({prefix:'create:'})).size, 0);
  assert.equal(creates, 0);
});

test('failed light resets delete boxes and allow fresh provider creates', async () => {
  const storage = new Storage(); let claim, creates = 0, deletes = 0;
  const pool = JSON.stringify(['owner/repo', 'boat-large']);
  const budget = {
    claimKey: async (_pool, sequence) => String(sequence).padStart(64, '0'),
    enqueue: async () => {}, claim: async () => claim,
    admit: async () => { claim = { status: 'pending' }; return { ok: true }; },
    begin: async () => { claim.status = 'calling'; return true; },
    settle: async (_key, status) => { claim.status = status; return true; },
  };
  const api = {
    lightReset: async () => ({ processId: 1 }), lightResetResult: async () => ({ ok: false }),
    destroy: async () => { deletes++; return { operation: { id: 'op' } }; },
    create: async () => { creates++; return { sandbox: { id: `bx_2345678${creates + 1}` } }; },
  };
  const fleet = new BoxFleet(storage, api, () => 1000, { budget });
  for (let i = 0; i < 3; i++) {
    const machineId = `failed-${i}`;
    await storage.put(`box:${machineId}`, { machineId, pool, state: 'finished', size: 'large', since: 0, generation: 0, reusable: true, baselineHash: 'a'.repeat(64), runnerFenced: true });
    await fleet.stepBox(machineId, {}, { reuseEnabled: true });
    await fleet.stepBox(machineId, {}, { reuseEnabled: true });
    assert.equal(await fleet.destroy(machineId), true);
    claim = null;
    const [record] = await fleet.prepare(pool, 'large', 1, 1);
    assert.equal(await fleet.admit(record.createKey, {}, 3600), true);
  }
  assert.equal(deletes, 3);
  assert.equal(creates, 3);
  assert.notEqual((await storage.get('verification:breaker'))?.tripped, true);
});

 test('pool breaker honors the configured verification threshold', async () => {
  const storage = new Storage();
  const fleet = new BoxFleet(storage, {}, () => 1, { getEnv: () => ({ VERIFICATION_FAILURE_THRESHOLD: '2' }) });
  await fleet.verificationOutcome({ machineId: 'a', size: 'large' }, 'online', false);
  assert.equal((await storage.get('verification:breaker')).tripped, false);
  await fleet.verificationOutcome({ machineId: 'b', size: 'large' }, 'online', false);
  assert.equal((await storage.get('verification:breaker')).tripped, true);
});


test('purging requires a fenced runner and a missing sandbox when deletion is incomplete', async () => {
  for (const [fenced, sandboxStatus, operationStatus, expected] of [
    [true, 404, 'blocked', 'deleted'],
    [false, 404, 'blocked', 'purging'],
    [true, 200, 'blocked', 'purging'],
    [true, 200, 'completed', 'deleted'],
  ]) {
    const storage = new Storage();
    const record = { ...box, state: 'purging', runnerFenced: fenced, operationId: 'op' };
    await storage.put(`box:${box.machineId}`, record);
    let sandboxCalls = 0;
    const fleet = new BoxFleet(storage, {
      deletion: async () => ({ operation: { id: 'op', status: operationStatus } }),
      sandbox: async received => { sandboxCalls++; assert.equal(received.operationId, 'op'); if (sandboxStatus === 404) throw Object.assign(new Error(), { status: 404 }); return {}; },
    });
    await fleet.stepBox(box.machineId);
    const actual = await storage.get(`box:${box.machineId}`);
    assert.equal(actual.state, expected);
    if (fenced && sandboxStatus === 404) {
      assert.equal(actual.deletedBy, 'sandbox_404');
      assert.equal(actual.deletionOperationId, 'op');
      assert.equal(actual.deletionOperationStatus, 'blocked');
    }
    if (operationStatus === 'completed') assert.equal(sandboxCalls, 0);
  }
});

test('completed jobs clear consecutive boot failures even with an incomplete snapshot', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-default']);
  let now = 1000;
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } } };
  const fleet = new BoxFleet(storage, {}, () => now, { project });
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: false });
  await storage.put('box:good', { machineId: 'good', runnerId: 1, runnerName: 'runner-good', size: 'default', state: 'busy', pool, since: 0 });
  await fleet.verificationOutcome({ machineId: 'bad1', size: 'default' }, 'boot_failed', false);
  now = 3000;
  await storage.put('gh-job:1', { id: 1, pool, runnerName: 'runner-good', status: 'completed', conclusion: 'success', completedAt: 2000 });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project });
  assert.equal((await storage.get('verification:breaker')).counts.default, 0);
  now = 4000;
  await fleet.verificationOutcome({ machineId: 'bad2', size: 'default' }, 'boot_failed', false);
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project });
  assert.equal((await storage.get('verification:breaker')).counts.default, 1, 'duplicate success must not clear a later failure');
  await storage.put('gh-job:2', { id: 2, pool, runnerName: 'runner-good', status: 'completed', conclusion: 'success', completedAt: 2000 });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project });
  assert.equal((await storage.get('verification:breaker')).counts.default, 1, 'late old success must not clear a later failure');
  await fleet.verificationOutcome({ machineId: 'bad3', size: 'default' }, 'boot_failed', false);
  assert.equal((await storage.get('verification:breaker')).tripped, false);
});

test('project concurrency cap limits old pending creates and preserves uncertain recovery', async () => {
  const storage = new Storage(), project = { caps: { concurrent: 2 } };
  const fleet = new BoxFleet(storage, {}, () => 1000, { project, budget: {} });
  await storage.put('box:one', { state: 'idle' });
  await storage.put('box:two', { state: 'busy' });
  await storage.put('create:old', { createKey: 'old', queuedAt: 1, state: 'pending' });
  await storage.put('create:new', { createKey: 'new', queuedAt: 2, state: 'pending' });
  assert.equal(await fleet.concurrentCapReached(project), true);
  assert.deepEqual(await fleet.admissionEntries(), []);
  await storage.put('create:uncertain', { createKey: 'uncertain', queuedAt: 0, state: 'unknown' });
  assert.deepEqual((await fleet.admissionEntries()).map(x => x.key), ['uncertain']);
  await storage.put('create:uncertain', { createKey: 'uncertain', queuedAt: 0, state: 'pending' });
  await storage.put('box:two', { state: 'deleted' });
  assert.deepEqual((await fleet.admissionEntries()).map(x => x.key), ['uncertain']);
  assert.equal(await fleet.concurrentCapReached(project), false);
});

test('an incomplete prepare does not touch each pending create', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-default']);
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } }, caps: { concurrent: 1 } };
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: false });
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 1 });
  await storage.put('create:old', { createKey: 'old', pool, queuedAt: 1, state: 'pending', reusable: false });
  let withdrawals = 0;
  const budget = { project: 'demo', ledger: { withdrawPoolWaiters: async () => { withdrawals++; } } };
  const fleet = new BoxFleet(storage, {}, () => 1000, { project, budget });
  const result = await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, prepareOnly: true });
  assert.equal(result[pool].reason, 'snapshot_incomplete');
  assert.equal(withdrawals, 1);
  assert.ok(await storage.get('create:old'));
});

test('zero account pool cap pauses new boxes but preserves uncertain reconciliation', async () => {
  const storage = new Storage(), project = { caps: { concurrent: 0 } };
  const fleet = new BoxFleet(storage, {}, () => 1000, { project, budget: {} });
  await storage.put('create:new', { createKey: 'new', queuedAt: 2, state: 'pending' });
  await storage.put('create:unknown', { createKey: 'unknown', queuedAt: 1, state: 'unknown' });
  assert.equal(await fleet.concurrentCapReached(project), true);
  assert.deepEqual((await fleet.admissionEntries()).map(x => x.key), ['unknown']);
});


test('reset outcomes include successes, failures and timeouts without duplicate generations', async () => {
  const storage = new Storage(); let now = 1000;
  const fleet = new BoxFleet(storage, { lightResetResult: async box => ({ ok: box.machineId === 'good' }) }, () => now);
  for (const id of ['good', 'bad']) {
    await storage.put(`box:${id}`, { machineId: id, state: 'resetting', since: 0, generation: 1, processId: 2 });
    await fleet.stepBox(id);
  }
  await fleet.recordResetOutcome({ machineId: 'good', generation: 1 }, true);
  now = 301000;
  await storage.put('box:slow', { machineId: 'slow', state: 'resetting', since: 1000, generation: 1 });
  await fleet.deadline('slow');
  const records = await storage.get('verification:reset-outcomes');
  assert.deepEqual(records.map(({ machineId, ok }) => ({ machineId, ok })), [{ machineId: 'good', ok: true }, { machineId: 'bad', ok: false }, { machineId: 'slow', ok: false }]);
});


test('a reset killed with 137 collects kernel classification before retirement', async () => {
  const storage = new Storage(), calls = [];
  const api = { lightResetResult: async () => ({ ok: false, exitCode: 137, step: 'docker prune' }), lightResetDiagnostics: async () => { calls.push('diagnose'); return { dmesgReadable: true, oomObserved: true }; } };
  const fleet = new BoxFleet(storage, api, () => 1000);
  await storage.put('box:machine', { machineId: 'machine', state: 'resetting', generation: 1, processId: 2 });
  await fleet.stepBox('machine');
  assert.deepEqual(calls, ['diagnose']);
  assert.equal((await storage.get('box:machine')).state, 'destroying');
  const failure = await storage.get('verification:attempt:failure:machine:1');
  assert.deepEqual(JSON.parse(failure.message).kernel, { dmesgReadable: true, oomObserved: true });
});

test('queued incompatible work releases only the idle slots it needs', async () => {
  const storage = new Storage(), large = JSON.stringify(['owner/repo', 'boat-large']), small = JSON.stringify(['owner/repo', 'boat-default']);
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large', 'boat-default'], sizes: { 'boat-large': { machine: 'large' }, 'boat-default': { machine: 'default' } }, caps: { concurrent: 3 }, reuse: { mode: 'on', idleHoldSeconds: 3600 } };
  const runners = [];
  for (let i = 0; i < 3; i++) {
    const machineId = `box${i}`, runnerName = `runner${i}`;
    await storage.put(`box:${machineId}`, { machineId, runnerId: i + 1, runnerName, pool: large, state: 'idle', since: 0, onlineAt: 0, reusable: true });
    runners.push({ name: runnerName, status: 'online', busy: false });
  }
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: 200_000, complete: true, runners });
  await storage.put('gh-job:1', { id: 1, pool: small, status: 'queued', queuedAt: 0 });
  let removed = 0;
  const fleet = new BoxFleet(storage, { removeRunner: async () => { removed++; } }, () => 200_000, { project, budget: { claim: async () => null } });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project, preprepared: true, skipAdmission: true });
  assert.equal(removed, 1);
  assert.equal((await storage.get('box:box0')).retirementReason, 'incompatible_queue');
  assert.equal((await storage.get('box:box1')).state, 'idle');
});

test('a failed post-reset health check retires the box outside the breaker', async () => {
  const storage = new Storage(), logs = [];
  const health = { cpuMs: 90, fsyncMs: 1900, writeMs: 300, memPct: 88, foreign: false, measured: true, failed: true, slow: true, cpu: 'AMD Ryzen 7 9700X 8-Core Processor' };
  const fleet = new BoxFleet(storage, { lightResetResult: async () => ({ ok: false, step: 'health check', exitCode: 1, output: '', guard: 'health', health }) }, () => 1000, { project: { id: 'demo' }, logger: line => logs.push(JSON.parse(line)) });
  await storage.put('box:machine', { machineId: 'machine', size: 'large', state: 'resetting', generation: 1, processId: 2 });
  await fleet.stepBox('machine');
  const box = await storage.get('box:machine');
  assert.equal(box.state, 'destroying'); assert.equal(box.retirementReason, 'health_check'); assert.deepEqual(box.resetHealth, health); assert.equal(box.hostCpu, health.cpu); assert.equal(box.slowHost, true);
  assert.equal(await storage.get('verification:attempt:failure:machine:1'), undefined);
  assert.notEqual((await storage.get('verification:breaker'))?.tripped, true);
  assert.deepEqual(logs.find(line => line.event === 'reset_health_retire')?.health, health);
});

test('a healthy reset keeps its measurements on the box', async () => {
  const storage = new Storage();
  const summary = { health: { cpuMs: 90, fsyncMs: 40, writeMs: 300, memPct: 88, foreign: false, measured: true, failed: false, slow: false, cpu: 'AMD Ryzen 9 9950X 16-Core Processor' } };
  const fleet = new BoxFleet(storage, { lightResetResult: async () => ({ ok: true, summary }) }, () => 1000, { project: { id: 'demo' } });
  await storage.put('box:machine', { machineId: 'machine', state: 'resetting', generation: 1, processId: 2 });
  await fleet.stepBox('machine');
  const box = await storage.get('box:machine');
  assert.equal(box.state, 'ready'); assert.deepEqual(box.lastResetSummary, summary); assert.equal(box.slowHost, false); assert.equal(box.hostCpu, 'AMD Ryzen 9 9950X 16-Core Processor');
});

test('the reset receives the account health mode; observe is the default', async () => {
  const seen = [];
  for (const reuseMode of [undefined, 'observe', 'enforce']) {
    const storage = new Storage();
    const fleet = new BoxFleet(storage, { lightReset: async job => { seen.push(job.healthMode); return { processId: 1 }; } }, () => 1000, { project: { id: 'demo' } });
    await storage.put('box:m', { machineId: 'm', pool: 'p', size: 'large', state: 'finished', since: 0, generation: 0, reusable: true, baselineHash: 'a'.repeat(64) });
    await fleet.stepBox('m', {}, { reuseEnabled: true, ...(reuseMode ? { reuseHealthMode: reuseMode } : {}) });
  }
  assert.deepEqual(seen, ['observe', 'observe', 'enforce']);
});

test('a fresh box is health-probed once before its first job; enforce retires a slow one', async () => {
  const slow = { cpuMs: 80, fsyncMs: 2500, writeMs: 300, memPct: 90, foreign: false, measured: true, failed: true, slow: true, cpu: 'AMD Ryzen 7 9700X 8-Core Processor' };
  const good = { ...slow, fsyncMs: 60, failed: false, slow: false };
  const run = async (health, healthMode, probe = async () => health) => {
    const storage = new Storage(); let probes = 0, registrations = 0;
    const api = { healthProbe: async box => { probes++; return probe(box); }, configure: async () => { registrations++; throw new Error('stop after register'); } };
    const fleet = new BoxFleet(storage, api, () => 1000, { project: { id: 'demo', repo: 'owner/repo' }, installation: 1 });
    await storage.put('box:m', { machineId: 'm', pool: JSON.stringify(['owner/repo', 'boat-large']), originPool: JSON.stringify(['owner/repo', 'boat-large']), size: 'large', state: 'ready', since: 0, generation: 0, reusable: true, baselineHash: 'a'.repeat(64) });
    await fleet.stepBox('m', {}, { healthMode });
    const box = await storage.get('box:m');
    return { box, probes, registrations };
  };
  const enforced = await run(slow, 'enforce');
  assert.equal(enforced.box.state, 'destroying'); assert.equal(enforced.box.retirementReason, 'health_check'); assert.equal(enforced.registrations, 0);
  const observed = await run(slow, 'observe');
  assert.deepEqual(observed.box.freshHealth, slow); assert.equal(observed.registrations, 1, 'observe keeps the box in service'); assert.equal(observed.box.slowHost, true); assert.equal(observed.box.hostCpu, slow.cpu);
  const healthy = await run(good, 'enforce');
  assert.deepEqual(healthy.box.freshHealth, good); assert.equal(healthy.registrations, 1);
  const broken = await run(null, 'enforce', async () => { throw new Error('provider error'); });
  assert.deepEqual(broken.box.freshHealth, { measured: false }); assert.equal(broken.registrations, 1, 'a probe error never retires a box');
  const unmeasured = await run({ ...slow, measured: false }, 'enforce');
  assert.equal(unmeasured.registrations, 1);
  const none = await run(slow, undefined);
  assert.equal(none.probes, 0); assert.equal(none.box.freshHealth, undefined);
});

test('the fresh probe parses only a complete numeric result', async () => {
  const { parseHealthProbe, healthProbeCommand } = await import('../src/router/light-reset.mjs');
  assert.deepEqual(parseHealthProbe({ exitCode: 0, stdout: '{"health":{"cpuMs":1,"fsyncMs":2,"writeMs":3,"memPct":90,"foreign":0,"measured":1,"failed":0,"slow":0,"cpu":"AMD_EPYC_9455_48-Core_Processor"}}\n' }), { cpuMs: 1, fsyncMs: 2, writeMs: 3, memPct: 90, foreign: false, measured: true, failed: false, slow: false, cpu: 'AMD EPYC 9455 48-Core Processor' });
  for (const response of [{ exitCode: 1, stdout: '' }, { running: true }, { exitCode: 0, stdout: 'x' }, { exitCode: 0, stdout: '{"health":{"cpuMs":-1}}' }]) assert.equal(parseHealthProbe(response), null);
  assert.match(Buffer.from(healthProbeCommand().match(/[A-Za-z0-9+/]{80,}={0,2}/)[0], 'base64').toString(), /health_enforce=0/);
});

test('auto health mode enforces only while the window and credit can replace a box', async () => {
  const limits = (remaining, credit, canStart = true) => ({ starts: { day: { remaining } }, creditBalanceHours: credit, canStart });
  assert.equal(healthGateFromLimits(limits(20, 5)), true);
  assert.equal(healthGateFromLimits(limits(19, 5)), false);
  assert.equal(healthGateFromLimits(limits(200, 0)), false);
  assert.equal(healthGateFromLimits(limits(200, 5, false)), false);
  assert.equal(healthGateFromLimits(null), false);
  const account = mode => ({ reuse: { healthCheck: mode, healthEnforceMinStarts: 20 } });
  assert.equal(await effectiveHealthMode(account('auto'), { limits: async () => limits(150, 3) }, 1000), 'enforce');
  assert.equal(await effectiveHealthMode(account('auto'), { limits: async () => limits(0, 3) }, 1000), 'observe');
  assert.equal(await effectiveHealthMode(account('auto'), { limits: async () => { throw new Error('down'); } }, 1000), 'observe');
  assert.equal(await effectiveHealthMode(account('enforce'), {}, 1000), 'enforce');
  assert.equal(await effectiveHealthMode(account(undefined), { limits: async () => limits(150, 3) }, 1000), 'observe');
  let reads = 0; const api = { limits: async () => { reads++; return limits(150, 3); } };
  await effectiveHealthMode(account('auto'), api, 1000); await effectiveHealthMode(account('auto'), api, 20_000); await effectiveHealthMode(account('auto'), api, 40_000);
  assert.equal(reads, 2, 'one provider read per 30 s');
});

test('a slow box is handed out last and never takes a large shard when a healthy box is about to be free', () => {
  const pool = 'p', now = 1_000_000, job = { id: 1, queuedAt: now - 10_000 };
  const slow = { machineId: 's', pool, size: 'large', state: 'ready', slowHost: true };
  assert.equal(slowBoxYields(slow, job, [slow, { machineId: 'h', pool, state: 'ready' }], now), true);
  assert.equal(slowBoxYields(slow, job, [slow, { machineId: 'h', pool, state: 'resetting' }], now), true);
  assert.equal(slowBoxYields({ ...slow, size: 'default' }, job, [slow, { machineId: 'h', pool, state: 'resetting' }], now), false);
  assert.equal(slowBoxYields(slow, job, [slow, { machineId: 'h', pool, state: 'busy' }], now), false, 'no healthy box free: the slow box serves');
  assert.equal(slowBoxYields(slow, job, [slow, { machineId: 'h', pool: 'other', state: 'ready' }], now), false);
  assert.equal(slowBoxYields(slow, job, [slow, { machineId: 'h2', pool, state: 'ready', slowHost: true }], now), false);
  assert.equal(slowBoxYields(slow, { ...job, queuedAt: now - 130_000 }, [slow, { machineId: 'h', pool, state: 'ready' }], now), false, 'a long-waiting job is not held back');
  assert.equal(slowBoxYields(slow, { ...job, queuedAt: now - 70_000 }, [slow, { machineId: 'h', pool, state: 'resetting' }], now), false);
});

test('reuse refusal: enforce enforces the reset check; a window without spare starts observes', async () => {
  const limits = (remaining, credit, canStart = true) => ({ starts: { day: { remaining } }, creditBalanceHours: credit, canStart });
  assert.equal(reuseHealthMode({ reuse: { healthCheck: 'auto' } }), 'observe', 'no reading of the window keeps the box');
  assert.equal(reuseHealthMode({ reuse: { healthCheck: 'auto' } }, limits(150, 3)), 'enforce');
  assert.equal(reuseHealthMode({ reuse: { healthCheck: 'auto' } }, limits(0, 3)), 'observe', 'an empty day window keeps a slow host rather than burning a start');
  assert.equal(reuseHealthMode({ reuse: { healthCheck: 'enforce' } }), 'enforce');
  assert.equal(reuseHealthMode({ reuse: { healthCheck: 'enforce' } }, limits(0, 0)), 'enforce');
  assert.equal(reuseHealthMode({ reuse: { healthCheck: 'observe' } }), 'observe');
  assert.equal(reuseHealthMode({ reuse: {} }), 'observe');
  const project = { id: 'demo', repo: 'owner/repo' };
  const run = async (fields, reuseMode) => {
    const storage = new Storage(); let registrations = 0;
    const fleet = new BoxFleet(storage, { configure: async () => { registrations++; throw new Error('stop'); } }, () => 1000, { project, installation: 1 });
    await storage.put('box:m', { machineId: 'm', pool: JSON.stringify(['owner/repo', 'boat-large']), originPool: JSON.stringify(['owner/repo', 'boat-large']), size: 'large', state: 'ready', since: 0, generation: 2, reusable: true, baselineHash: 'a'.repeat(64), ...fields });
    await fleet.stepBox('m', {}, { reuseHealthMode: reuseMode });
    return { box: await storage.get('box:m'), registrations };
  };
  const slow = await run({ slowHost: true }, 'enforce');
  assert.equal(slow.box.state, 'destroying'); assert.equal(slow.box.retirementReason, 'health_check'); assert.equal(slow.registrations, 0);
  const failed = await run({ lastResetSummary: { health: { failed: true } } }, 'enforce');
  assert.equal(failed.box.state, 'destroying');
  const observed = await run({ slowHost: true }, 'observe');
  assert.equal(observed.registrations, 1, 'observe keeps a marked box');
  const healthy = await run({ slowHost: false }, 'enforce');
  assert.equal(healthy.registrations, 1);
  const fresh = await run({ slowHost: true, generation: 0, freshHealth: { measured: false } }, 'enforce');
  assert.equal(fresh.registrations, 1, 'a fresh box (generation 0) is not a reuse');
});

test('a provider 403 for a sandbox another API key owns finishes the destroy locally', async () => {
  const storage = new Storage(), logs = [], id = 'bx_23456789';
  await storage.put(`box:${id}`, { machineId: id, state: 'destroying', since: 0 });
  let destroys = 0;
  const fleet = new BoxFleet(storage, { destroy: async () => { destroys++; throw Object.assign(new Error('boat HTTP 403'), { service: 'boat', status: 403, code: 'api_key_action_forbidden' }); } }, () => 1000, { project: { id: 'demo' }, logger: line => logs.push(JSON.parse(line)) });
  assert.equal(await fleet.destroy(id), true);
  const box = await storage.get(`box:${id}`);
  assert.equal(box.state, 'deleted');
  assert.equal(box.deletedBy, 'not_owned');
  assert.equal(destroys, 1);
  assert.deepEqual(logs.filter(line => line.event === 'box_not_owned').map(line => line.machineId), [id]);
});

test('an adopted orphan does not consume the project cap and a queued light job gets a small box', async () => {
  const storage = new Storage(), project = { id: 'peek', repo: 'owner/repo', labels: ['peek-router', 'peek-router-light'], sizes: { 'peek-router': { machine: 'large' }, 'peek-router-light': { machine: 'small' } }, caps: { concurrent: 2 } };
  const light = JSON.stringify([project.repo, 'peek-router-light']), large = JSON.stringify([project.repo, 'peek-router']);
  await storage.put('box:bx_orphan1', { machineId: 'bx_orphan1', pool: large, state: 'destroying', since: 0, drainOnly: true, orphan: true });
  await storage.put('box:bx_orphan2', { machineId: 'bx_orphan2', pool: large, state: 'quarantined', since: 0, drainOnly: true, orphan: true });
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: 1000, complete: true, runners: [] });
  await storage.put('gh-job:1', { id: 1, pool: light, status: 'queued', queuedAt: 0 });
  const budget = { claimKey: async key => key, enqueue: async () => {} };
  const fleet = new BoxFleet(storage, {}, () => 1000, { project, budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, prepareOnly: true });
  const creates = [...(await storage.list({ prefix: 'create:' })).values()];
  assert.equal(creates.length, 1);
  assert.equal(creates[0].pool, light);
  assert.equal(creates[0].size, 'small');
});
