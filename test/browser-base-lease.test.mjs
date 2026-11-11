import test from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.mjs';
import { hash } from '../src/setup.mjs';
import { Storage } from './helpers.mjs';
import { TenantStorage } from '../src/router/tenant-storage.mjs';
import { ExternalService } from '../src/router/external-service.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { browserBase } from '../src/router/browser-base.mjs';

test('browser base identity binds the inherited lease profile', async () => {
  const env = { BROWSER_BASE_SNAPSHOT_NAME: 'browser-ci-20261110-1234abcd', BROWSER_BASE_SNAPSHOT_ID: 'snapshot-id', BROWSER_BASE_TOOLCHAIN_SHA256: 'b'.repeat(64), BROWSER_BASE_FILES_SHA256: 'c'.repeat(64), BROWSER_BASE_PROFILE_SHA256: 'd'.repeat(64) };
  const original = await browserBase(env);
  assert.equal(original.routerSnapshot.profileSha256, env.BROWSER_BASE_PROFILE_SHA256);
  assert.notEqual((await browserBase({ ...env, BROWSER_BASE_PROFILE_SHA256: 'e'.repeat(64) })).baseId, original.baseId);
  assert.equal(await browserBase({ ...env, BROWSER_BASE_PROFILE_SHA256: '' }), null);
});

test('the browser selector is pinned and retries cannot change base', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const env = { ENABLED: 'true', PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients), BROWSER_BASE_SNAPSHOT_NAME: 'browser-ci-20261110-1234abcd', BROWSER_BASE_SNAPSHOT_ID: 'snapshot-id', BROWSER_BASE_TOOLCHAIN_SHA256: 'b'.repeat(64), BROWSER_BASE_FILES_SHA256: 'c'.repeat(64), BROWSER_BASE_PROFILE_SHA256: 'd'.repeat(64) };
  const fleet = new Fleet({ storage, waitUntil() {} }, env);
  let selection;
  fleet.external.claim = async (_client, _id, _size, _isolation, _repoKey, _tick, selected) => { selection = selected; return { machineId: 'bx_23456789', expiresAt: Date.now() + 60000, isolation: 'external-v2', base: selected?.base }; };
  const send = body => fleet.fetch(new Request('https://fleet/router/lease/claim', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, size: 'default', isolation: 'external-v2', ...body }) }));
  fleet.env.BROWSER_BASE_SNAPSHOT_ID = '';
  assert.equal((await send({ base: 'browser-v1' })).status, 503);
  fleet.env.BROWSER_BASE_SNAPSHOT_ID = 'snapshot-id';
  const first = await send({ base: 'browser-v1' });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).base, 'browser-v1');
  assert.equal(selection.routerSnapshot.snapshotId, 'snapshot-id');
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', size: 'default', ...selection, state: 'active' });
  assert.equal((await send({})).status, 409);
  assert.equal((await send({ base: 'unknown' })).status, 400);
  fleet.env.BROWSER_BASE_SNAPSHOT_ID = 'rotated';
  assert.equal((await send({ base: 'browser-v1' })).status, 200);
  assert.equal(selection.routerSnapshot.snapshotId, 'snapshot-id');
});

test('queued browser claims retain the selected identity across the admission tick', async () => {
  const id = '00000000-0000-4000-8000-000000000002', now = () => 10000, storage = new Storage();
  const projectStorage = new TenantStorage(storage, 'project-a');
  const config = { repo: 'a/b', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } }, reuse: { mode: 'on' } };
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: null, startsPerDay: null, ttlSeconds: 900, warmReuse: true } };
  const ledger = new AccountLedger(storage, { openStartQueue: true, externalClients: clients, starts: { minute: 10, hour: 10, day: 10 } }, now);
  const router = { projects: new Map([['project-a', { storage: projectStorage, config, box: true }]]), ledger, account: { openStartQueue: true, reuse: { enabled: true } } };
  const service = new ExternalService(router, storage, { limits: async () => ({ canStart: false }) }, clients, now);
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: now(), runners: [] });
  const selection = await browserBase({ BROWSER_BASE_SNAPSHOT_NAME: 'browser-ci-20261110-1234abcd', BROWSER_BASE_SNAPSHOT_ID: 'snapshot-id', BROWSER_BASE_TOOLCHAIN_SHA256: 'b'.repeat(64), BROWSER_BASE_FILES_SHA256: 'c'.repeat(64), BROWSER_BASE_PROFILE_SHA256: 'd'.repeat(64) });
  assert.equal(await service.claim('lease', id, 'default', 'external-v2', null, false, selection), null);
  const lease = await storage.get(`external-lease:lease:${id}`);
  assert.equal(lease.baseId, selection.baseId);
  assert.equal((await service.admissionEntries())[0].lease.routerSnapshot.snapshotId, 'snapshot-id');
  assert.equal(await service.claim('lease', id, 'default', 'external-v2', null, false, null), null);
  assert.equal((await storage.get(`external-lease:lease:${id}`)).baseId, selection.baseId);
});

test('runner demand cannot reclaim a seeded browser or lease box', async () => {
  const id = '00000000-0000-4000-8000-000000000003', now = () => 10000, storage = new Storage();
  const projectStorage = new TenantStorage(storage, 'project-a');
  const config = { repo: 'a/b', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } }, reuse: { mode: 'on' } };
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: null, startsPerDay: null, ttlSeconds: 900, warmReuse: true } };
  const ledger = new AccountLedger(storage, { openStartQueue: true, externalClients: clients, starts: { minute: 10, hour: 10, day: 10 } }, now);
  const router = { projects: new Map([['project-a', { storage: projectStorage, config, box: true }]]), ledger, account: { openStartQueue: true, reuse: { enabled: true } } };
  const service = new ExternalService(router, storage, {}, clients, now);
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: now(), runners: [] });
  await projectStorage.put('gh-job:1', { id: 1, queuedAt: 100, status: 'queued', pool: '["a/b","boat-default"]' });
  for (const [machineId, baseId] of [['bx_23456789', 'browser-id'], ['bx_2345678b', 'lease-id'], ['bx_2345678a', null]]) await projectStorage.put(`box:${machineId}`, { machineId, baseId, pool: '["a/b","boat-default"]', state: 'lease-warm', size: 'default', leaseClient: 'lease', leaseIsolation: 'external-v2', createdAt: 1, since: now(), baselineHash: 'a'.repeat(64), generation: 2, reusable: true });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'waiting', size: 'default', isolation: 'external-v2', baseId: 'browser-id', createdAt: 200, expiresAt: 100000 });
  await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'lease-warm');
  assert.equal((await projectStorage.get('box:bx_2345678b')).state, 'lease-warm');
  assert.equal((await projectStorage.get('box:bx_2345678a')).state, 'ready');
});
