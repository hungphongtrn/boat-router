import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { ExternalLeases } from '../src/router/external-leases.mjs';

const a = '00000000-0000-4000-8000-000000000001', b = '00000000-0000-4000-8000-000000000002';
test('reservations are idempotent and cleanup holds the concurrency slot', async () => {
  const store = new Storage(); let now = 10_000; const leases = new ExternalLeases(store, () => now);
  assert.ok(await leases.reserve('compute', a, 1, 5000));
  assert.equal((await leases.reserve('compute', a, 1, 5000)).id, a);
  assert.equal(await leases.reserve('compute', b, 1, 5000), null);
  await leases.transition('compute', a, ['reserved'], 'active');
  now += 1000; assert.equal((await leases.renew('compute', a, 5000)).expiresAt, 16000);
  await leases.transition('compute', a, ['active'], 'cleaning');
  assert.equal(await leases.reserve('compute', b, 1, 5000), null);
  await leases.transition('compute', a, ['cleaning'], 'closed');
  assert.ok(await leases.reserve('compute', b, 1, 5000));
});
test('expired and wrong-client leases cannot be renewed', async () => {
  const store = new Storage(); let now = 10_000; const leases = new ExternalLeases(store, () => now);
  await leases.reserve('compute', a, 1, 1000); await leases.transition('compute', a, ['reserved'], 'active');
  assert.equal(await leases.renew('other', a, 1000), null);
  now += 1000; assert.equal(await leases.renew('compute', a, 1000), null);
});

import { WarmLeaseFence } from '../src/router/external-leases.mjs';
test('a warm lease cannot cross a base identity boundary', async () => {
  for (const [boxBase, leaseBase] of [[null, 'browser-a'], ['browser-a', null], ['browser-a', 'browser-b']]) {
    const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
    await leases.reserve('compute', a, 1, 5000);
    await leases.transition('compute', a, ['reserved'], 'reserved', { isolation: 'external-v2', baseId: leaseBase });
    const key = 'project:project-a:box:bx_23456789';
    await store.put(key, { machineId: 'bx_23456789', state: 'lease-warm', leaseClient: 'compute', leaseIsolation: 'external-v2', baseId: boxBase });
    const fence = new WarmLeaseFence(store, {}, now);
    assert.equal(await fence.takeWarm('project-a', 'compute', a, 'bx_23456789'), false);
    assert.equal((await store.get(key)).state, 'lease-warm');
    await store.put(key, { machineId: 'bx_23456789', state: 'idle', runnerId: 7, reusable: true, baselineHash: 'hash', baseId: boxBase });
    assert.equal(await fence.fence('project-a', 'compute', a, 'bx_23456789'), false);
    assert.equal((await store.get(key)).state, 'idle');
  }
});
test('atomic warm admission rejects a size mismatch and seeded runner handoff', async () => {
  const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  await leases.transition('compute', a, ['reserved'], 'reserved', { size: 'large', isolation: 'external-v2', baseId: 'seed' });
  const key = 'project:project-a:box:bx_23456789';
  const fence = new WarmLeaseFence(store, {}, now);
  await store.put(key, { machineId: 'bx_23456789', state: 'lease-warm', size: 'default', leaseClient: 'compute', leaseIsolation: 'external-v2', baseId: 'seed' });
  assert.equal(await fence.takeWarm('project-a', 'compute', a, 'bx_23456789'), false);
  await store.put(key, { machineId: 'bx_23456789', state: 'idle', size: 'large', runnerId: 7, reusable: true, baselineHash: 'hash', baseId: 'seed' });
  assert.equal(await fence.fence('project-a', 'compute', a, 'bx_23456789'), false);
  assert.equal((await store.get(key)).state, 'idle');
});
test('warm lease fences the runner and verifies reset before access', async () => {
  const store = new Storage(); let now = 10_000;
  const leases = new ExternalLeases(store, () => now); await leases.reserve('compute', a, 1, 5000);
  const key = 'project:project-a:box:bx_23456789';
  await store.put(key, { machineId: 'bx_23456789', state: 'idle', runnerId: 7, reusable: true, baselineHash: 'hash', generation: 0 });
  let verified = false;
  const fence = new WarmLeaseFence(store, { removeRunner: async () => {}, lightReset: async () => ({ processId: 9 }), lightResetResult: async () => verified ? { ok: true } : null }, () => now);
  assert.equal(await fence.fence('project-a', 'compute', a, 'bx_23456789'), true);
  assert.equal((await store.get(key)).state, 'lease-resetting');
  assert.equal(await fence.completeReset('project-a', 'compute', a), false);
  verified = true; assert.equal(await fence.completeReset('project-a', 'compute', a), true);
  assert.equal((await store.get(key)).state, 'leased');
  assert.equal(await fence.destroy('project-a', 'compute', a), true);
  assert.equal((await store.get(key)).state, 'destroying');
  assert.equal((await store.get(`external-lease:compute:${a}`)).state, 'cleaning');
});
test('a runner assigned during fencing returns to CI and cannot be leased', async () => {
  const store = new Storage(), leases = new ExternalLeases(store, () => 10_000);
  await leases.reserve('compute', a, 1, 5000);
  const key = 'project:project-a:box:bx_23456789';
  await store.put(key, { machineId: 'bx_23456789', state: 'idle', runnerId: 7, reusable: true, baselineHash: 'hash' });
  const fence = new WarmLeaseFence(store, { removeRunner: async () => { throw Object.assign(new Error(), { status: 422 }); } }, () => 10_000);
  assert.equal(await fence.fence('project-a', 'compute', a, 'bx_23456789'), false);
  assert.equal((await store.get(key)).state, 'busy');
  assert.equal((await store.get(`external-lease:compute:${a}`)).state, 'reserved');
});

import { ExternalLeaseStarts } from '../src/router/external-leases.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { leaseBase } from '../src/router/lease-base.mjs';
async function browserSelection() {
  return leaseBase({ LEASE_BASE_SNAPSHOT_NAME: 'lease-ci-20261110-1234abcd', LEASE_BASE_SNAPSHOT_ID: 'snapshot-id', LEASE_BASE_MANIFEST_SHA256: 'a'.repeat(64), LEASE_BASE_PROFILE_SHA256: 'b'.repeat(64) });
}
test('a lease lease persists its exact base through the provider call', async () => {
  const store = new Storage(), now = () => 10_000;
  const leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  const { baseId, routerSnapshot: snapshot } = await browserSelection();
  await leases.transition('compute', a, ['reserved'], 'reserved', { baseId, routerSnapshot: snapshot, isolation: 'external-v2', account: 'primary' });
  const ledger = new AccountLedger(store, { starts: { minute: 1, hour: 1, day: 1 }, externalClients: { compute: { startsPerDay: 1 } } }, now);
  const limits = { at: now(), canStart: true, concurrency: { active: 0, limit: 10 }, windows: Object.fromEntries(['minute', 'hour', 'day'].map(k => [k, { limit: 5, used: 0 }])) };
  let request;
  const starts = new ExternalLeaseStarts(store, ledger, { forIdentity: async identity => { assert.equal(identity.account, 'primary'); return { request: async () => ({ snapshot: { status: 'ready', snapshotId: snapshot.snapshotId } }) }; }, create: async job => { request = job; return { sandbox: { id: 'bx_23456789' } }; } }, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', limits, 7200), true);
  assert.deepEqual(request.routerSnapshot, snapshot);
  const box = await store.get('project:project-a:box:bx_23456789');
  assert.equal(box.baseId, baseId);
  assert.deepEqual(box.routerSnapshot, snapshot);
});

test('an incomplete browser selection cannot spend a provider start', async () => {
  const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  await leases.transition('compute', a, ['reserved'], 'reserved', { baseId: 'c'.repeat(64) });
  let calls = 0;
  const starts = new ExternalLeaseStarts(store, { claim: async () => { calls++; } }, { create: async () => { calls++; } }, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', {}, 7200), false);
  assert.equal(calls, 0);
});
test('a lease lease cannot start in the secondary account', async () => {
  const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  const { baseId, routerSnapshot: snapshot } = await browserSelection();
  await leases.transition('compute', a, ['reserved'], 'reserved', { baseId, routerSnapshot: snapshot, isolation: 'external-v2' });
  let calls = 0;
  const ledger = { claim: async () => null, selectForLease: async () => 'secondary', enqueue: async () => { calls++; } };
  const starts = new ExternalLeaseStarts(store, ledger, { forIdentity: async () => ({ request: async () => ({ snapshot: { status: 'ready', snapshotId: snapshot.snapshotId } }) }), create: async () => { calls++; } }, now, 'secondary');
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', {}, 7200), false);
  assert.equal(calls, 0);
});
test('a changed saved snapshot cannot spend a start', async () => {
  const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  const selection = await browserSelection();
  await leases.transition('compute', a, ['reserved'], 'reserved', { ...selection, isolation: 'external-v2' });
  let calls = 0;
  const starts = new ExternalLeaseStarts(store, { claim: async () => { calls++; } }, { forIdentity: async () => ({ request: async () => ({ snapshot: { status: 'ready', snapshotId: 'different' } }) }), create: async () => { calls++; } }, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', {}, 7200), false);
  assert.equal(calls, 0);
});
test('a snapshot changed during creation is fenced for destruction', async () => {
  const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  const selection = await browserSelection();
  await leases.transition('compute', a, ['reserved'], 'reserved', { ...selection, isolation: 'external-v2', account: 'primary' });
  const ledger = new AccountLedger(store, { starts: { minute: 1, hour: 1, day: 1 }, externalClients: { compute: { startsPerDay: 1 } } }, now);
  const limits = { at: now(), canStart: true, concurrency: { active: 0, limit: 10 }, windows: Object.fromEntries(['minute', 'hour', 'day'].map(k => [k, { limit: 5, used: 0 }])) };
  let checks = 0;
  const api = { forIdentity: async () => ({ request: async () => ({ snapshot: { status: 'ready', snapshotId: ++checks === 1 ? selection.routerSnapshot.snapshotId : 'different' } }) }), create: async () => ({ sandbox: { id: 'bx_23456789' } }) };
  const starts = new ExternalLeaseStarts(store, ledger, api, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', limits, 7200), false);
  assert.equal((await store.get('project:project-a:box:bx_23456789')).state, 'destroying');
  assert.equal((await store.get(`external-lease:compute:${a}`)).state, 'cleaning');
});
test('an uncertain create is reconciled and retired when its lease snapshot changes', async () => {
  const store = new Storage(), now = () => 10_000, selection = await browserSelection();
  const key = `external-lease:compute:${a}`;
  await store.put(key, { ...selection, client: 'compute', id: a, state: 'starting', project: 'project-a', account: 'secondary', size: 'default', pool: '["repo","label"]', isolation: 'external-v2', createdAt: 1, expiresAt: 20000, claimKey: 'claim', createKey: 'create', routerCreateName: 'boat-router-test' });
  let reconciled = 0, created = 0;
  const ledger = { claim: async () => ({ status: 'unknown' }), resolve: async () => {} };
  const api = { forIdentity: async () => ({ request: async () => ({ snapshot: { status: 'ready', snapshotId: 'changed' } }) }), findCreated: async () => { reconciled++; return { id: 'bx_23456789' }; }, create: async () => { created++; } };
  const starts = new ExternalLeaseStarts(store, ledger, api, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', {}, 7200), false);
  assert.equal(reconciled, 1);
  assert.equal(created, 0);
  assert.equal((await store.get('project:project-a:box:bx_23456789')).state, 'destroying');
  assert.equal((await store.get(key)).state, 'cleaning');
});
test('fresh lease starts pass through the shared ledger before becoming active', async () => {
  const store = new Storage(), now = () => 10_000;
  const ledger = new AccountLedger(store, { starts: { minute: 1, hour: 1, day: 1 }, externalClients: { compute: { startsPerDay: 1 } } }, now);
  const snapshot = { at: now(), canStart: true, concurrency: { active: 0, limit: 10 }, windows: Object.fromEntries(['minute', 'hour', 'day'].map(k => [k, { limit: 5, used: 0 }])) };
  await new ExternalLeases(store, now).reserve('compute', a, 1, 5000);
  let called = 0;
  const api = { create: async () => { called++; return { sandbox: { id: 'bx_23456789' } }; }, sandbox: async () => ({ sandbox: { setupStatus: 'done', state: 'ready' } }) };
  const starts = new ExternalLeaseStarts(store, ledger, api, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', snapshot, 7200), true);
  assert.equal(called, 1);
  const lease = await store.get(`external-lease:compute:${a}`);
  assert.equal((await ledger.claim(lease.claimKey)).status, 'created');
  assert.equal(await starts.ready('compute', a), true);
  assert.equal((await store.get(`external-lease:compute:${a}`)).state, 'active');
  assert.equal((await store.get('project:project-a:box:bx_23456789')).state, 'leased');
});

test('a ledger refusal remains visible on the pending lease', async () => {
  const store = new Storage(), now = () => 10_000;
  await new ExternalLeases(store, now).reserve('compute', a, 1, 5000);
  const ledger = { claim: async () => null, enqueue: async () => {}, admit: async () => ({ ok: false, reason: 'client_cap' }) };
  let created = false;
  const starts = new ExternalLeaseStarts(store, ledger, { create: async () => { created = true; } }, now);
  assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', {}, 7200), false);
  assert.equal(created, false);
  assert.equal((await store.get(`external-lease:compute:${a}`)).lastReason, 'client_cap');
});


test('unadmitted start retries warm capacity without losing uncertain claims', async () => {
  for (const existing of [null, { status: 'pending' }]) {
    const store = new Storage(), now = () => 10_000;
    await new ExternalLeases(store, now).reserve('compute', a, 1, 5000);
    const ledger = { selectForLease: async () => null, claim: async () => existing };
    const starts = new ExternalLeaseStarts(store, ledger, {}, now);
    assert.equal(await starts.start('compute', a, 'project-a', 'default', '["repo","label"]', {}, 7200), false);
    const lease = await store.get(`external-lease:compute:${a}`);
    assert.equal(lease.state, existing ? 'starting' : 'waiting');
    if (!existing) assert.equal(lease.lastReason, 'start_capacity');
  }
});


test('waiting clients do not consume a lease slot and can reserve again', async () => {
  const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
  await leases.reserve('compute', a, 1, 5000);
  await leases.transition('compute', a, ['reserved'], 'waiting');
  assert.ok(await leases.reserve('compute', b, 1, 5000));
  assert.equal(await leases.reserve('compute', a, 1, 5000), null);
  await leases.transition('compute', b, ['reserved'], 'closed');
  assert.equal((await leases.reserve('compute', a, 1, 5000)).state, 'reserved');
});


test('inconsistent waiters with a box or claim keep their slot', async () => {
  for (const evidence of [{machineId:'bx_23456789'}, {claimKey:'uncertain'}]) {
    const store = new Storage(), now = () => 10_000, leases = new ExternalLeases(store, now);
    await store.put(`external-lease:compute:${a}`, { client:'compute', id:a, state:'waiting', expiresAt:1, ...evidence });
    assert.equal(await leases.reserve('compute', b, 1, 5000), null);
    assert.equal((await store.get(`external-lease:compute:${a}`)).state, 'waiting');
  }
});
