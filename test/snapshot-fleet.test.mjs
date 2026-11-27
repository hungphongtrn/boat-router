import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { Storage } from './helpers.mjs';

const env = { BOAT_WALLET: 'example-account', PROJECT_SNAPSHOT_NAME: 'project-ci-20261109-1234abcd', PROJECT_SNAPSHOT_MANIFEST_SHA256: 'a'.repeat(64) };
const pool = '["example-owner/project-a","boat-large"]';
const rollingName = `peek-ci-${'a'.repeat(52)}`;
function setup(create, options = {}) {
  const storage = new Storage(), claims = new Map(), logs = [];
  const budget = {
    claimKey: async key => createHash('sha256').update(key).digest('hex'),
    enqueue: async () => {}, claim: async key => claims.get(key),
    admit: async key => { claims.set(key, { status: 'pending' }); return { ok: true }; },
    begin: async key => { claims.get(key).status = 'calling'; return true; },
    cancelPending: async key => { claims.delete(key); return true; },
    settle: async (key, status) => { if (status === 'not_created') claims.delete(key); else claims.get(key).status = status; return true; },
  };
  const fleet = new BoxFleet(storage, { create, findCreated: async () => null, ...(options.rollingSnapshot ? { rollingSnapshot: options.rollingSnapshot } : {}), ...(options.forIdentity ? { forIdentity: options.forIdentity } : {}) }, () => 100, {
    budget, project: options.project ?? { id: 'project-a', snapshotBoot: true }, getEnv: () => ({ ...env, ...options.env }), logger: line => logs.push(line),
  });
  return { fleet, storage, claims, budget, logs };
}

test('snapshot choice is persisted before the provider call and recorded on the box', async () => {
  let h;
  h = setup(async request => {
    const saved = await h.storage.get(`create:${request.createKey}`);
    assert.equal(saved.bootPath, 'snapshot');
    assert.deepEqual(saved.routerSnapshot, request.routerSnapshot);
    return { sandbox: { id: 'bx_23456789' } };
  });
  const [record] = await h.fleet.prepare(pool, 'large', 1, 0);
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), true);
  const box = await h.storage.get('box:bx_23456789');
  assert.equal(box.bootPath, 'snapshot');
  assert.equal(box.routerSnapshot.name, env.PROJECT_SNAPSHOT_NAME);
});

test('a fresh reusable small or default box boots the newest ready rolling generation', async () => {
  const starts = [];
  const h = setup(async request => {
    starts.push(request);
    return { sandbox: { id: ['bx_23456789', 'bx_2345678a'][starts.length - 1] } };
  }, {
    project: { id: 'project-a', snapshotBoot: true, rollingSnapshot: true },
    rollingSnapshot: async () => ({ name: rollingName, manifestSha256: '0'.repeat(64), snapshotId: 'snapshot-1' }),
  });
  for (const [size, label] of [['small', 'boat-small'], ['default', 'boat-default']]) {
    const [record] = await h.fleet.prepare(JSON.stringify(['example-owner/project-a', label]), size, 1, 0, true);
    assert.equal(await h.fleet.admit(record.createKey, {}, 3600), true);
  }
  assert.equal(starts.length, 2);
  for (const start of starts) {
    assert.equal(start.routerSnapshot.name, rollingName);
    assert.equal(start.routerReusable, true);
  }
  const boxes = [...(await h.storage.list({ prefix: 'box:' })).values()];
  assert.equal(boxes.length, 2);
  for (const box of boxes) {
    assert.equal(box.bootPath, 'snapshot');
    assert.equal(box.routerSnapshot.name, rollingName);
    assert.equal(box.reusable, true);
  }
});

test('an unready named rolling generation fails closed without a plain or fixed create', async () => {
  let calls = 0, preferred;
  const h = setup(async () => { calls++; return { sandbox: { id: 'bx_23456789' } }; }, {
    project: { id: 'project-a', snapshotBoot: true, rollingSnapshot: true },
    rollingSnapshot: async name => { preferred = name; return null; },
    env: { PROJECT_ROLLING_SNAPSHOT_NAME: rollingName },
  });
  const [record] = await h.fleet.prepare(pool, 'default', 1, 0, true);
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), false);
  assert.equal(preferred, rollingName);
  assert.equal(calls, 0);
  const stored = await h.storage.get(`create:${record.createKey}`);
  assert.equal(stored.bootPath, undefined);
  assert.equal(stored.routerSnapshot, undefined);
  assert.equal(h.logs.some(line => JSON.parse(line).event === 'snapshot_not_ready'), true);
});

test('a secondary box resolves the named rolling generation in its own account', async () => {
  let preferred, creates = 0;
  const h = setup(async () => { creates++; return { sandbox: { id: 'bx_23456789' } }; }, {
    project: { id: 'project-a', snapshotBoot: true, rollingSnapshot: true },
    env: { PROJECT_ROLLING_SNAPSHOT_NAME: 'primary-only', PROJECT_ROLLING_SNAPSHOT_NAME_SECONDARY: rollingName },
    forIdentity: async record => {
      assert.equal(record.account, 'secondary');
      return { rollingSnapshot: async name => { preferred = name; return { name: rollingName, manifestSha256: '0'.repeat(64), snapshotId: 'snapshot-1' }; } };
    },
  });
  const [record] = await h.fleet.prepare(pool, 'default', 1, 0, true);
  await h.storage.put(`create:${record.createKey}`, { ...record, account: 'secondary' });
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), true);
  assert.equal(preferred, rollingName);
  assert.equal(creates, 1);
  assert.equal((await h.storage.get('box:bx_23456789')).routerSnapshot.name, rollingName);
});

test('a confirmed missing snapshot creates a separately keyed plain fallback', async () => {
  const calls = [];
  const h = setup(async request => {
    calls.push(request);
    if (calls.length === 1) throw { service: 'boat', status: 404, code: 'snapshot_not_found' };
    return { sandbox: { id: 'bx_23456789' } };
  });
  const [record] = await h.fleet.prepare(pool, 'large', 1, 0);
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), false);
  const entries = [...(await h.storage.list({ prefix: 'create:' })).values()];
  assert.equal(entries.length, 1);
  const fallback = entries[0];
  assert.notEqual(fallback.createKey, record.createKey);
  assert.equal(fallback.bootPath, 'plain_fallback');
  assert.equal(fallback.routerSnapshot, undefined);
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), true);
  assert.equal(calls[1].routerSnapshot, undefined);
  assert.equal((await h.storage.get('box:bx_23456789')).bootPath, 'plain_fallback');
});

test('an ambiguous snapshot create remains unresolved without a plain fallback', async () => {
  const h = setup(async () => { throw new Error('timeout'); });
  const [record] = await h.fleet.prepare(pool, 'large', 1, 0);
  await h.fleet.admit(record.createKey, {}, 3600);
  const entries = [...(await h.storage.list({ prefix: 'create:' })).values()];
  assert.equal(entries.length, 1);
  assert.equal(entries[0].state, 'unknown');
  assert.equal(entries[0].bootPath, 'snapshot');
});

test('a missing snapshot fallback resumes after a ledger interruption', async () => {
  const h = setup(async () => { throw { service: 'boat', status: 404, code: 'snapshot_not_found' }; });
  const settle = h.budget.settle;
  h.budget.settle = async () => { throw new Error('interrupted'); };
  const [record] = await h.fleet.prepare(pool, 'large', 1, 0);
  await assert.rejects(h.fleet.admit(record.createKey, {}, 3600), /interrupted/);
  const stored = await h.storage.get(`create:${record.createKey}`);
  assert.equal(stored.state, 'snapshot_missing');
  h.budget.settle = settle;
  await h.fleet.admit(record.createKey, {}, 3600);
  const [fallback] = [...(await h.storage.list({ prefix: 'create:' })).values()];
  assert.equal(fallback.createKey, stored.fallbackKey);
  assert.equal(fallback.bootPath, 'plain_fallback');
});

test('a missing snapshot fallback resumes after the ledger was settled', async () => {
  const h = setup(async () => { throw new Error('unexpected create'); });
  const [record] = await h.fleet.prepare(pool, 'large', 1, 0);
  const fallbackKey = 'fallback-key';
  await h.storage.put(`create:${record.createKey}`, { ...record, state: 'snapshot_missing', bootPath: 'snapshot', fallbackKey, fallbackName: 'boat-router-' + 'a'.repeat(32) });
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), true);
  assert.equal((await h.storage.get(`create:${fallbackKey}`)).bootPath, 'plain_fallback');
});

test('another account does not receive the Project A snapshot', async () => {
  let call;
  const h = setup(async request => { call = request; return { sandbox: { id: 'bx_23456789' } }; });
  const [record] = await h.fleet.prepare(pool, 'large', 1, 0);
  await h.storage.put(`create:${record.createKey}`, { ...record, account: 'secondary' });
  await h.fleet.admit(record.createKey, {}, 3600);
  assert.equal(call.routerSnapshot, undefined);
  assert.equal((await h.storage.get('box:bx_23456789')).bootPath, 'plain');
});

test('a failed snapshot waits for removal before its plain fallback starts', async () => {
  let calls = 0;
  const h = setup(async () => { calls++; return { sandbox: { id: 'bx_2345678a' } }; });
  h.fleet.verificationOutcome = async () => {};
  const box = { machineId: 'bx_23456789', state: 'booting', since: 0, pool, size: 'large', createKey: 'old', bootPath: 'snapshot', reusable: false };
  await h.storage.put('box:bx_23456789', box);
  await h.fleet.failedBoot(box, 'boot_failed', null);
  const [fallback] = [...(await h.storage.list({ prefix: 'create:' })).values()];
  assert.equal(fallback.bootPath, 'plain_fallback');
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), false);
  assert.equal(calls, 0);
  await h.storage.put('box:bx_23456789', { ...box, state: 'deleted' });
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), true);
  assert.equal(calls, 1);
});

test('a rate-limited failed snapshot records failure and queues a plain fallback', async () => {
  let calls = 0;
  const h = setup(async request => { calls++; assert.equal(request.routerSnapshot, undefined); return { sandbox: { id: 'bx_2345678a' } }; });
  h.fleet.api.setupDiagnostics = async () => ({ providerErrorCategory: 'rate_limited', captureStatus: 'ok', setupOutput: [] });
  const box = { machineId: 'bx_23456789', state: 'booting', since: 0, pool, size: 'large', createKey: 'old', bootPath: 'snapshot', reusable: false };
  await h.storage.put('box:bx_23456789', box);
  await h.fleet.failedBoot(box, 'boot_failed', null);
  const failed = await h.storage.get('box:bx_23456789');
  assert.equal(failed.failureReason, 'provider_limited');
  assert.ok(failed.history.some(item => item.event === 'boot_failed'));
  assert.equal(await h.storage.get('startBackoffUntil'), 60_100);
  const fallback = await h.storage.get(`create:${failed.retryCreateKey}`);
  assert.equal(fallback.bootPath, 'plain_fallback');
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), false);
  assert.equal(calls, 0);
  await h.storage.put('box:bx_23456789', { ...failed, state: 'deleted' });
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), true);
  assert.equal(calls, 1);
});


test('a snapshot with a prior retry flag still gets one plain fallback', async () => {
  let calls = 0;
  const h = setup(async request => { calls++; assert.equal(request.routerSnapshot, undefined); return { sandbox: { id: 'bx_2345678a' } }; });
  h.fleet.verificationOutcome = async () => {};
  const box = { machineId: 'bx_23456789', state: 'booting', since: 0, pool, size: 'large', createKey: 'old', bootPath: 'snapshot', setupRetry: true, reusable: false };
  await h.storage.put('box:bx_23456789', box);
  await h.fleet.failedBoot(box, 'boot_failed', null);
  const failed = await h.storage.get('box:bx_23456789');
  const fallback = await h.storage.get(`create:${failed.retryCreateKey}`);
  assert.equal(fallback.bootPath, 'plain_fallback');
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), false);
  await h.storage.put('box:bx_23456789', { ...failed, state: 'deleted' });
  assert.equal(await h.fleet.admit(fallback.createKey, {}, 3600), true);
  assert.equal(calls, 1);
});
