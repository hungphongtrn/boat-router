import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';

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

test('local offer window cancels an uncalled create that no longer has aged demand', async () => {
  const storage = new Storage(), pool = JSON.stringify(['owner/repo', 'boat-large']);
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: 1, complete: true, runners: [] });
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 1000 });
  await storage.put('create:key', { pool, createKey: 'key', state: 'pending', at: 0 });
  let cancelled = 0;
  const budget = { claim: async () => ({ status: 'pending' }), cancelPending: async () => { cancelled++; return true; } };
  const fleet = new BoxFleet(storage, {}, () => 10_000, { budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: { repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, localFirst: { enabled: true, labels: { 'boat-large': 'generic' } } } });
  assert.equal(cancelled, 1);
  assert.equal(await storage.get('create:key'), undefined);
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
