import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger, snapshotLimits } from '../src/router/ledger.mjs';

const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-default'] };
const now = 10_000_000;
const ids = ['bx_23456789', 'bx_2345678a', 'bx_2345678b'];
const name = hash => `boat-router-${hash.repeat(32).slice(0, 32)}`;

function fleetFor({ sandboxes, ledger = {}, snapshot = {}, projectCount = 1, boxes = [], creates = [], runners = [] } = {}) {
  const storage = new Storage(), accountStorage = new Storage(), calls = { destroy: 0, removeRunner: 0, sandbox: 0 };
  accountStorage.put('account:ledger', ledger);
  for (const box of boxes) storage.put(`box:${box.machineId}`, box);
  for (const create of creates) storage.put(`create:${create.createKey}`, create);
  for (const runner of runners) storage.put(`runner:${runner.name}`, runner);
  const api = {
    listSandboxes: async () => sandboxes,
    sandbox: async () => { calls.sandbox++; return {}; },
    destroy: async () => { calls.destroy++; return { operation: { id: 'op' } }; },
    removeRunner: async () => { calls.removeRunner++; return {}; },
  };
  const events = [];
  const fleet = new BoxFleet(storage, api, () => now, {
    project, projectCount, logger: line => events.push(JSON.parse(line)),
    budget: { ledger: { storage: accountStorage, key: 'account:ledger' } },
  });
  return { fleet, storage, calls, events, view: { complete: true, at: now, runners: snapshot.runners ?? [], jobs: snapshot.jobs ?? [] } };
}

test('unknown router boxes that hold every slot are retired through the router destroy path', async () => {
  const sandboxes = ids.map((id, i) => ({ id, name: name(['a', 'b', 'c'][i]) }));
  const { fleet, storage, calls, events, view } = fleetFor({ sandboxes });
  await fleet.sweepOrphans(view, project);
  for (const id of ids) {
    const box = await storage.get(`box:${id}`);
    assert.equal(box.drainOnly, true);
    assert.equal(box.orphan, true);
    assert.equal(box.noRunnerKnown, true);
    assert.equal(box.state, 'purging');
  }
  assert.equal(calls.destroy, 3);
  assert.deepEqual(events.filter(event => event.event === 'orphan_sweep').map(event => event.decision), ['retire', 'retire', 'retire']);
});

test('an unknown box never holds the live budget and the sweep still retires it', async () => {
  const storage = new Storage(), accountStorage = new Storage();
  accountStorage.put('account:ledger', { claims: {}, waiting: [] });
  const ledger = new AccountLedger(accountStorage, { requireConcurrency: true, liveSandboxCap: 3, starts: { minute: 12, hour: 60, day: 200 }, margin: 0, dayReserve: 0 }, () => now);
  const limits = active => ({ canStart: true, activeSandboxes: active, maxActiveSandboxes: 100, starts: { minute: { limit: 12, used: 0 }, hour: { limit: 60, used: 0 }, day: { limit: 200, used: 0 } } });
  await ledger.enqueue('demo', 'first', now);
  // Three sandboxes live on the account and this router records none of them,
  // so the local live budget is untouched and the create goes ahead.
  const admitted = await ledger.admit('demo', 'first', snapshotLimits(limits(3), now), { ownLive: 0 });
  assert.equal(admitted.ok, true);
  await ledger.abandon('demo', 'first');

  const sandboxes = ids.map((id, i) => ({ id, name: name(['d', 'e', 'f'][i]) }));
  const api = { listSandboxes: async () => sandboxes, sandbox: async () => ({}), destroy: async () => ({ operation: { id: 'op' } }) };
  const fleet = new BoxFleet(storage, api, () => now, { project, projectCount: 1, budget: { ledger: { storage: accountStorage, key: 'account:ledger' } } });
  await fleet.sweepOrphans({ complete: true, at: now, runners: [], jobs: [] }, project);
  for (const id of ids) assert.equal((await storage.get(`box:${id}`)).orphan, true);
});

test('an unknown box with a busy runner is adopted and not destroyed', async () => {
  const id = ids[0], runner = { id: 9, name: `boat-demo-${id}-g0`, busy: true, status: 'online' };
  const { fleet, storage, calls, view } = fleetFor({ sandboxes: [{ id, name: name('a') }], snapshot: { runners: [runner] } });
  await fleet.sweepOrphans(view, project);
  const box = await storage.get(`box:${id}`);
  assert.equal(box.noRunnerKnown, false);
  assert.equal(box.runnerName, runner.name);
  assert.equal(box.state, 'quarantined');
  assert.equal(calls.destroy, 0);
  await fleet.stepBox(id, view);
  assert.equal((await storage.get(`box:${id}`)).state, 'busy');
});

test('a router-named box with no claim is left alone when the account holds several projects', async () => {
  const id = ids[0];
  const { fleet, storage, calls } = fleetFor({ sandboxes: [{ id, name: name('a') }], projectCount: 2 });
  await fleet.sweepOrphans({ complete: true, at: now, runners: [], jobs: [] }, project);
  assert.equal(await storage.get(`box:${id}`), undefined);
  assert.equal(calls.destroy, 0);
});

test('an unrelated sandbox and a sandbox a create record owns are never adopted', async () => {
  const { fleet, storage, calls } = fleetFor({
    sandboxes: [{ id: ids[0], name: 'unrelated' }, { id: ids[1], name: name('b') }],
    creates: [{ createKey: 'live', routerCreateName: name('b'), state: 'pending', at: now }],
  });
  await fleet.sweepOrphans({ complete: true, at: now, runners: [], jobs: [] }, project);
  assert.equal(await storage.get(`box:${ids[0]}`), undefined);
  assert.equal(await storage.get(`box:${ids[1]}`), undefined);
  assert.equal(calls.destroy, 0);
});

test('a claimed orphan with no runner is still adopted and retired', async () => {
  const id = ids[0], hash = 'a'.repeat(64);
  const { fleet, storage, calls } = fleetFor({
    sandboxes: [{ id, name: `boat-router-${hash.slice(0, 32)}` }],
    ledger: { claims: { [hash]: { project: 'demo', status: 'created' } } },
  });
  await fleet.sweepOrphans({ complete: true, at: now, runners: [], jobs: [] }, project);
  // The sweep adopts a claimed orphan; the reconcile's own stepBox pass then
  // releases it from quarantine and destroys it.
  assert.equal((await storage.get(`box:${id}`)).state, 'quarantined');
  const view = { complete: true, at: now, runners: [], jobs: [] };
  await fleet.stepBox(id, view);
  await fleet.stepBox(id, view);
  assert.equal((await storage.get(`box:${id}`)).state, 'purging');
  assert.equal(calls.destroy, 1);
});
