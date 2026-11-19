import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { TenantStorage } from '../src/router/tenant-storage.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';

async function fixture({ actualStatus = 'queued', canStart = true, used = 0 } = {}) {
  let now = 1_000_000, calls = 0, actual = actualStatus;
  const root = new Storage(), storage = new TenantStorage(root, 'demo');
  const pool = JSON.stringify(['owner/repo', 'boat-default']);
  const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } }, caps: { concurrent: 2 } };
  const ledger = new AccountLedger(root, { requireConcurrency: true }, () => now);
  const budget = new SharedBudget(ledger, 'demo', () => now);
  const api = { getJob: async () => ({ id: 1, status: actual, runner_name: null }),
    limits: async () => ({ canStart, observedAt: now, activeSandboxes: 0, maxActiveSandboxes: 10, starts: Object.fromEntries(['minute', 'hour', 'day'].map(k => [k, { limit: 100, used }])), machineTypes: [{ type: 'default', available: true }] }),
    create: async () => { calls++; return { sandbox: { id: 'bx_23456789' } }; } };
  const fleet = new BoxFleet(storage, api, () => now, { budget, project, installation: 1 });
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: false });
  await storage.put('pool:snapshot-complete', false);
  await storage.put('pool:snapshot-hold:boat-default', { since: now - 179_999 });
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: now - 200_000, observedAt: now - 200_000, source: 'webhook' });
  const prepare = () => fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, prepareOnly: true });
  return { root, storage, fleet, prepare, calls: () => calls, advance: n => { now += n; }, setActual: s => { actual = s; } };
}

test('snapshot recovery waits three minutes, checks GitHub and creates once through the ledger', async () => {
  const f = await fixture(); await f.prepare(); assert.equal((await f.storage.list({ prefix: 'create:' })).size, 0);
  f.advance(1); await f.prepare();
  const pending = [...(await f.storage.list({ prefix: 'create:' })).values()]; assert.equal(pending.length, 1);
  await f.fleet.admitQueued(pending[0].createKey, { mode: 'on', env: { ENABLED: 'true' } });
  assert.equal(f.calls(), 1); assert.equal((await f.storage.list({ prefix: 'box:' })).size, 1);
  await f.prepare(); assert.equal(f.calls(), 1);
});

test('snapshot recovery refuses a job that GitHub no longer reports queued', async () => {
  const f = await fixture({ actualStatus: 'in_progress' }); f.advance(1); await f.prepare();
  assert.equal((await f.storage.list({ prefix: 'create:' })).size, 0); assert.equal(f.calls(), 0);
  f.setActual('queued'); await f.prepare();
  const [pending] = [...(await f.storage.list({ prefix: 'create:' })).values()]; assert.ok(pending);
  f.setActual('completed'); await f.fleet.admitQueued(pending.createKey, { mode: 'on', env: { ENABLED: 'true' } });
  assert.equal((await f.storage.list({ prefix: 'create:' })).size, 0); assert.equal(f.calls(), 0);
});

test('snapshot recovery never bypasses provider availability', async () => {
  const f = await fixture({ canStart: false }); f.advance(1); await f.prepare();
  const [pending] = [...(await f.storage.list({ prefix: 'create:' })).values()]; assert.ok(pending);
  await f.fleet.admitQueued(pending.createKey, { mode: 'on', env: { ENABLED: 'true' } });
  assert.equal(f.calls(), 0); assert.ok(await f.storage.get(`create:${pending.createKey}`));
});

test('an uncalled pre-outage create is withdrawn so it cannot block snapshot recovery', async () => {
  const f = await fixture();
  const pool = JSON.stringify(['owner/repo', 'boat-default']);
  await f.fleet.prepare(pool, 'default', 1, 1);
  await f.prepare();
  assert.equal((await f.storage.list({ prefix: 'create:' })).size, 1);
  f.advance(1); await f.prepare();
  assert.equal((await f.storage.list({ prefix: 'create:' })).size, 0);
  await f.prepare();
  const [pending] = [...(await f.storage.list({ prefix: 'create:' })).values()];
  assert.equal(pending.snapshotRecoveryJobId, 1);
  await f.fleet.admitQueued(pending.createKey, { mode: 'on', env: { ENABLED: 'true' } });
  assert.equal(f.calls(), 1);
});

test('snapshot recovery does not guess whether a matrix job has an open slot', async () => {
  const f = await fixture(); f.advance(1);
  const job = await f.storage.get('gh-job:1');
  await f.storage.put('gh-job:1', { ...job, workflowName: 'CI', jobName: 'shard 1' });
  f.fleet.project.workflowConcurrency = [{ workflow: 'CI', jobPrefix: 'shard', maxParallel: 2 }];
  await f.prepare(); assert.equal((await f.storage.list({ prefix: 'create:' })).size, 0);
});


test('snapshot recovery does not bypass the account start cap', async () => {
  const f = await fixture({ used: 100 }); f.advance(1); await f.prepare();
  const [pending] = [...(await f.storage.list({ prefix: 'create:' })).values()]; assert.ok(pending);
  await f.fleet.admitQueued(pending.createKey, { mode: 'on', env: { ENABLED: 'true' } });
  assert.equal(f.calls(), 0);
});
