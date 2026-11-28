import test from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.mjs';
import { hash } from '../src/setup.mjs';
import { Storage } from './helpers.mjs';

test('lease authentication grants only the named configured client', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001';
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, concurrencyReserve: 2, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage: new Storage(), waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  const send = (client, credential) => fleet.fetch(new Request('https://fleet/router/lease/renew', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': client, Authorization: `Bearer ${credential}` }, body: JSON.stringify({ id }) }));
  assert.equal((await send('lease', token)).status, 409);
  assert.equal((await send('lease', 'b'.repeat(40))).status, 401);
  assert.equal((await send('other', token)).status, 401);
});

test('open queue removes client caps while preserving reuse and authentication', async () => {
  const clients = { lease: { enabled: true, seededBase: true, project:'project-a', maxActive:6, startsPerDay:60, ttlSeconds:900, tokenHash:'a'.repeat(64) } };
  const policy = { lease: {maxActive:12,warmReuse:true,startsPerDay:600,tokenHash:'b'.repeat(64)}, other:{maxActive:100} };
  const fleet = new Fleet({storage:new Storage(),waitUntil(){}},{PLUGIN_ROUTER:'true',BOAT_WALLET: 'example-account',BOAT_PROVIDER_WALLET:'team_test',ROUTER_PROJECTS:'project-a',EXTERNAL_LEASE_CLIENTS:JSON.stringify(clients),EXTERNAL_LEASE_POLICY:JSON.stringify(policy)});
  assert.equal(fleet.external.config('lease').maxActive,null);
  assert.equal(fleet.external.config('lease').warmReuse,true);
  assert.equal(fleet.external.config('lease').startsPerDay,null);
  assert.equal(fleet.external.config('lease').tokenHash,'a'.repeat(64));
  assert.equal(fleet.external.config('other'),null);
});

test('only an active isolated lease can record its requested repository mirror', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', key = 'b'.repeat(64), storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project:'project-a', maxActive:6, startsPerDay:60, ttlSeconds:900, tokenHash:await hash(token) } };
  const fleet = new Fleet({storage,waitUntil(){}},{PLUGIN_ROUTER:'true',BOAT_WALLET: 'example-account',BOAT_PROVIDER_WALLET:'team_test',ROUTER_PROJECTS:'project-a',EXTERNAL_LEASE_CLIENTS:JSON.stringify(clients)});
  await storage.put(`external-lease:lease:${id}`, { id, client:'lease', project:'project-a', state:'active', isolation:'external-v2', machineId:'bx_12345678', repoKey:key, expiresAt:Date.now()+60000 });
  await storage.put('project:project-a:box:bx_12345678', { machineId:'bx_12345678', leaseId:id, state:'leased' });
  const send = repoKey => fleet.fetch(new Request('https://fleet/router/lease/mirror-record', {method:'POST',headers:{'X-Boat-CI-Enabled':'true','X-Lease-Client':'lease',Authorization:`Bearer ${token}`},body:JSON.stringify({id,repoKey,sha:'d'.repeat(40)})}));
  assert.equal((await send('c'.repeat(64))).status, 400);
  assert.equal((await send(key)).status, 204);
  assert.deepEqual((await storage.get('project:project-a:box:bx_12345678')).mirrorKeys, [key]);
  assert.equal((await storage.get('project:project-a:box:bx_12345678')).mirrorHeads[key], 'd'.repeat(40));
});

test('active isolated lease lease can extend its own seeded box lifetime', async () => {
  const token='a'.repeat(40), id='00000000-0000-4000-8000-000000000001', key='b'.repeat(64), storage=new Storage();
  const clients={lease: { enabled: true, seededBase: true,project:'project-a',maxActive:6,startsPerDay:60,ttlSeconds:900,tokenHash:await hash(token)}};
  const fleet=new Fleet({storage,waitUntil(){}},{PLUGIN_ROUTER:'true',BOAT_WALLET: 'example-account',BOAT_PROVIDER_WALLET:'team_test',ROUTER_PROJECTS:'project-a',EXTERNAL_LEASE_CLIENTS:JSON.stringify(clients)});
  const requests=[]; fleet.router.externalApi={forIdentity:async()=>({request:async (...args)=>{requests.push(args);return {};}})};
  await storage.put(`external-lease:lease:${id}`,{id,client:'lease',project:'project-a',state:'active',isolation:'external-v2',machineId:'bx_12345678',repoKey:key,expiresAt:Date.now()+60000});
  await storage.put('project:project-a:box:bx_12345678',{machineId:'bx_12345678',leaseId:id,state:'leased',machineTtlSeconds:7200});
  const send=repoKey=>fleet.fetch(new Request('https://fleet/router/lease/mirror-extend',{method:'POST',headers:{'X-Boat-CI-Enabled':'true','X-Lease-Client':'lease',Authorization:`Bearer ${token}`},body:JSON.stringify({id,repoKey})}));
  assert.equal((await send('c'.repeat(64))).status,400); assert.equal(requests.length,0);
  assert.equal((await send(key)).status,204); assert.equal(requests.length,1); assert.deepEqual(requests[0][2].body,{ttlSeconds:14400});
  assert.equal((await storage.get('project:project-a:box:bx_12345678')).machineTtlSeconds,14400);
  assert.equal((await send(key)).status,204); assert.equal(requests.length,1);
});

test('file writes wait for the current router operation and release the router during transfer', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  let unblockTick, finishWrite, writeStarted;
  const tick = new Promise(resolve => { unblockTick = resolve; });
  const entered = new Promise(resolve => { writeStarted = resolve; });
  const transfer = new Promise(resolve => { finishWrite = resolve; });
  let calls = 0;
  fleet.router.externalApi = { forIdentity: async () => ({ request: async () => { calls++; writeStarted(); await transfer; return {}; } }) };
  fleet.router.ticking = tick;
  const send = () => fleet.fetch(new Request('https://fleet/router/lease/file-write', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, path: '/tmp/chunk', content: 'YQ==', encoding: 'base64' }) }));
  const writing = send();
  for (let i = 0; i < 1000 && !fleet.leaseWriteWaiters; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(fleet.leaseWriteWaiters, 1);
  assert.equal(calls, 0);
  fleet.router.ticking = null; unblockTick();
  await entered;
  assert.equal(fleet.router.ticking, null);
  assert.ok((await storage.get(`external-lease:lease:${id}`)).fileWritePending);
  const renewal = await fleet.fetch(new Request('https://fleet/router/lease/renew', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) }));
  assert.equal(renewal.status, 200);
  fleet.env.ENABLED = 'true';
  fleet.external.claim = async () => null;
  fleet.external.pendingReason = async () => 'capacity';
  const other = '00000000-0000-4000-8000-000000000002';
  const claim = await fleet.fetch(new Request('https://fleet/router/lease/claim', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id: other }) }));
  assert.equal(claim.status, 202);
  assert.equal(calls, 1);
  finishWrite();
  assert.equal((await writing).status, 200);
  assert.equal(fleet.router.ticking, null);
});

test('a lease closed while a file write waits is never used', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  let releaseTick, calls = 0;
  fleet.router.ticking = new Promise(resolve => { releaseTick = resolve; });
  fleet.router.externalApi = { forIdentity: async () => ({ request: async () => { calls++; return {}; } }) };
  const pending = fleet.fetch(new Request('https://fleet/router/lease/file-write', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, path: '/tmp/chunk', content: 'YQ==', encoding: 'base64' }) }));
  for (let i = 0; i < 1000 && !fleet.leaseWriteWaiters; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(fleet.leaseWriteWaiters, 1);
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'closed' });
  fleet.router.ticking = null; releaseTick();
  assert.equal((await pending).status, 409);
  assert.equal(calls, 0);
});

test('release and recovery destroy a box with an uncertain file write', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  const lease = { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60000, fileWritePending: { token: 'write', deadline: Date.now() - 1 } };
  await storage.put(`external-lease:lease:${id}`, lease);
  const calls = [];
  fleet.external.fence.destroy = async (...args) => { calls.push(args); return true; };
  assert.equal(await fleet.external.release('lease', id), true);
  assert.deepEqual(calls, [['project-a', 'lease', id]]);
  calls.length = 0;
  await fleet.external.sweep();
  assert.deepEqual(calls, [['project-a', 'lease', id]]);
});

test('an ambiguous provider write remains fenced until the box is destroyed', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60000 });
  fleet.router.externalApi = { forIdentity: async () => ({ request: async () => { throw new Error('uncertain transport'); } }) };
  const result = await fleet.fetch(new Request('https://fleet/router/lease/file-write', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, path: '/tmp/chunk', content: 'YQ==', encoding: 'base64' }) }));
  assert.equal(result.status, 503);
  assert.equal((await storage.get(`external-lease:lease:${id}`)).fileWritePending.failed, true);
  let destroyed = false;
  fleet.external.fence.destroy = async () => { destroyed = true; return true; };
  await fleet.external.sweep();
  assert.equal(destroyed, true);
});

test('contending file writes have a bounded wait and run one at a time', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  let releaseTick, active = 0, maxActive = 0;
  fleet.router.ticking = new Promise(resolve => { releaseTick = resolve; });
  fleet.router.externalApi = { forIdentity: async () => ({ request: async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    return {};
  } }) };
  const send = () => fleet.fetch(new Request('https://fleet/router/lease/file-write', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, path: '/tmp/chunk', content: 'YQ==', encoding: 'base64' }) }));
  const pending = [send(), send(), send(), send()];
  for (let i = 0; i < 1000 && fleet.leaseWriteWaiters !== 3; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(fleet.leaseWriteWaiters, 3);
  assert.equal((await Promise.race(pending)).status, 409);
  fleet.router.ticking = null; releaseTick();
  const statuses = (await Promise.all(pending)).map(response => response.status).sort();
  assert.deepEqual(statuses, [200, 409, 409, 409]);
  assert.equal(maxActive, 1);
});

test('a rotated token hash in EXTERNAL_LEASE_TOKEN_HASHES replaces the installed hash and nothing else', async () => {
  const oldToken = 'a'.repeat(40), newToken = 'c'.repeat(40), id = '00000000-0000-4000-8000-000000000001';
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, concurrencyReserve: 2, ttlSeconds: 900, tokenHash: await hash(oldToken) } };
  const make = hashes => new Fleet({ storage: new Storage(), waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients), ...(hashes === undefined ? {} : { EXTERNAL_LEASE_TOKEN_HASHES: hashes }) });
  const send = (fleet, credential) => fleet.fetch(new Request('https://fleet/router/lease/renew', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${credential}` }, body: JSON.stringify({ id }) }));
  const rotated = make(JSON.stringify({ lease: await hash(newToken), stranger: await hash(newToken) }));
  assert.equal((await send(rotated, newToken)).status, 409);
  assert.equal((await send(rotated, oldToken)).status, 401);
  assert.equal(rotated.external.config('lease').maxActive, null);
  assert.equal(rotated.external.config('lease').ttlSeconds, 900);
  assert.equal(rotated.external.config('stranger'), null);
  for (const hashes of [undefined, 'not json', JSON.stringify({ lease: 'short' }), JSON.stringify({ lease: null }), JSON.stringify([await hash(newToken)])]) {
    const fleet = make(hashes);
    assert.equal((await send(fleet, oldToken)).status, 409, String(hashes));
    assert.equal((await send(fleet, newToken)).status, 401, String(hashes));
  }
});

test('a stalled lease stream handshake times out and releases the router', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  fleet.router.externalApi = { forIdentity: async () => ({ env: {}, fetch: async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true })) }) };
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 10_000 ? 5 : delay, ...args);
  try {
    const headers = { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` };
    const result = await fleet.fetch(new Request('https://fleet/router/lease/stream', { method: 'POST', headers, body: JSON.stringify({ id, processId: 1, stdoutOffset: 0, stderrOffset: 0 }) }));
    assert.equal(result.status, 503);
    assert.equal(fleet.router.ticking, null);
    const renewed = await fleet.fetch(new Request('https://fleet/router/lease/renew', { method: 'POST', headers, body: JSON.stringify({ id }) }));
    assert.equal(renewed.status, 200);
  } finally { globalThis.setTimeout = original; }
});

test('an established lease stream stays open after the handshake deadline', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients) });
  await storage.put(`external-lease:lease:${id}`, { id, client: 'lease', project: 'project-a', state: 'active', machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  let signal;
  fleet.router.externalApi = { forIdentity: async () => ({ env: {}, fetch: async (_url, options) => { signal = options.signal; return new Response('stream data'); } }) };
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => original(callback, delay === 10_000 ? 5 : delay, ...args);
  try {
    const headers = { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` };
    const result = await fleet.fetch(new Request('https://fleet/router/lease/stream', { method: 'POST', headers, body: JSON.stringify({ id, processId: 1, stdoutOffset: 0, stderrOffset: 0 }) }));
    assert.equal(result.status, 200);
    await new Promise(resolve => original(resolve, 20));
    assert.equal(signal.aborted, false);
    assert.equal(await result.text(), 'stream data');
    assert.equal(fleet.router.ticking, null);
  } finally { globalThis.setTimeout = original; }
});

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
function rollingName(manifestSha256) {
  const value = BigInt(`0x${manifestSha256}`) << 4n;
  let encoded = '';
  for (let index = 51; index >= 0; index--) encoded += alphabet[Number((value >> BigInt(index * 5)) & 31n)];
  return `peek-ci-${encoded}`;
}

function leaseFleet(storage, clients, extra = {}) {
  return new Fleet({ storage, waitUntil() {} }, { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients), ...extra });
}
const claimRequest = (client, token, id, body) => new Request('https://fleet/router/lease/claim', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': client, Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, ...body }) });

test('a claim body asking for a rolling generation reports the selected snapshot', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  const manifestSha256 = 'a'.repeat(64), name = rollingName(manifestSha256), pins = [];
  fleet.controller.api = { rollingSnapshot: async preferred => { pins.push(preferred); return { name, manifestSha256, snapshotId: 'snapshot-9' }; } };
  let captured;
  fleet.external.claim = async (...args) => { captured = args; return { machineId: 'bx_12345678', expiresAt: Date.now() + 60_000, routerSnapshot: { kind: 'peek-ci', name, snapshotId: 'snapshot-9', manifestSha256 } }; };
  const response = await fleet.fetch(claimRequest('lease', token, id, { rollingSnapshot: true, isolation: 'external-v2' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.snapshotName, name);
  assert.equal(body.manifestSha256, manifestSha256);
  assert.deepEqual(pins, [null]);
  const [, , , , , , selection, rolling] = captured;
  assert.equal(rolling, true);
  assert.deepEqual(selection.routerSnapshot, { kind: 'peek-ci', name, snapshotId: 'snapshot-9', manifestSha256 });
  assert.equal(selection.baseId, manifestSha256);
});

test('a client default selects the rolling generation and a plain lease reports null', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, rollingSnapshot: true, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  const manifestSha256 = 'b'.repeat(64), name = rollingName(manifestSha256);
  fleet.controller.api = { rollingSnapshot: async () => ({ name, manifestSha256, snapshotId: 'snapshot-8' }) };
  let captured;
  fleet.external.claim = async (...args) => { captured = args; return { machineId: 'bx_12345678', expiresAt: Date.now() + 60_000, routerSnapshot: { kind: 'peek-ci', name, snapshotId: 'snapshot-8', manifestSha256 } }; };
  const rolling = await fleet.fetch(claimRequest('lease', token, id, {}));
  assert.equal(rolling.status, 200);
  assert.equal(captured[7], true);
  fleet.external.claim = async () => ({ machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  const plain = await fleet.fetch(claimRequest('lease', token, id, { rollingSnapshot: false }));
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json().then(({ snapshotName, manifestSha256: digest }) => [snapshotName, digest]), [null, null]);
});

test('a pending claim returns a canonical reason and the specific detail', async () => {
  const token = 'a'.repeat(40), id = '00000000-0000-4000-8000-000000000001', storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  fleet.external.claim = async () => null;
  for (const [detail, reason] of [['lease_cap', 'pool_full'], ['concurrency', 'pool_full'], ['spend_budget', 'budget_exhausted'], ['ci_snapshot_unavailable', 'snapshot_unavailable'], ['start_capacity', 'start_capacity'], ['lease_pool_preparing', 'starting']]) {
    fleet.external.pendingReason = async () => detail;
    const response = await fleet.fetch(claimRequest('lease', token, id, {}));
    assert.equal(response.status, 202, detail);
    assert.deepEqual(await response.json(), { reason, detail }, detail);
  }
});

test('the installed peek-runs client takes its policy from config and its token from the secret', async () => {
  const storage = new Storage();
  const env = { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'peek' };
  const fleet = new Fleet({ storage, waitUntil() {} }, env);
  const config = fleet.external.config('peek-runs');
  assert.equal(config.project, 'peek');
  assert.equal(config.ttlSeconds, 1800);
  assert.equal(config.rollingSnapshot, true);
  assert.equal(config.warmReuse, false);
  assert.equal(config.maxActive, null, 'the open start queue owns admission');
  assert.equal(config.startsPerDay, null);
  const token = 'e'.repeat(40), id = '00000000-0000-4000-8000-000000000001';
  const rotated = new Fleet({ storage: new Storage(), waitUntil() {} }, { ...env, EXTERNAL_LEASE_TOKEN_HASHES: JSON.stringify({ 'peek-runs': await hash(token) }) });
  assert.equal(rotated.external.config('peek-runs').ttlSeconds, 1800);
  const renew = client => rotated.fetch(new Request('https://fleet/router/lease/renew', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': client, Authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) }));
  assert.equal((await renew('peek-runs')).status, 409);
  assert.equal((await renew('stranger')).status, 401);
});

const id = '00000000-0000-4000-8000-000000000001';
const leaseLease = (state = 'active') => ({ id, client: 'lease', project: 'project-a', state, machineId: 'bx_12345678', expiresAt: Date.now() + 60_000, ...(state === 'held' ? { heldUntil: Date.now() + 60_000 } : {}) });
const cancelRequest = (token, client, body) => new Request('https://fleet/router/lease/cancel', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': client, Authorization: `Bearer ${token}` }, body: JSON.stringify(body) });

test('cancel kills an owned process once and refuses a wrong client, a bad id and an unknown lease', async () => {
  const token = 'a'.repeat(40), stranger = 'b'.repeat(40), storage = new Storage();
  const clients = {
    lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) },
    stranger: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(stranger) },
  };
  const fleet = leaseFleet(storage, clients);
  const calls = [];
  fleet.external.api = { request: async (...args) => { calls.push(args); return {}; } };
  await storage.put(`external-lease:lease:${id}`, leaseLease());
  for (const processId of [7.5, '7x', -1, true, {}, '0', 0, '1e3']) {
    assert.equal((await fleet.fetch(cancelRequest(token, 'lease', { id, processId }))).status, 400, JSON.stringify(processId));
  }
  assert.equal((await fleet.fetch(cancelRequest(stranger, 'stranger', { id, processId: 7 }))).status, 404);
  assert.equal((await fleet.fetch(cancelRequest(token, 'lease', { id: '00000000-0000-4000-8000-000000000009', processId: 7 }))).status, 404);
  const first = await fleet.fetch(cancelRequest(token, 'lease', { id, processId: '7' }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { id, processId: 7, cancelled: true });
  assert.deepEqual(calls, [['boat', '/sandboxes/bx_12345678/commands/7', { method: 'DELETE' }]]);
  const second = await fleet.fetch(cancelRequest(token, 'lease', { id, processId: 7 }));
  assert.equal(second.status, 200);
  assert.deepEqual(await second.json(), { id, processId: 7, cancelled: false });
  assert.equal(calls.length, 1);
  assert.deepEqual((await storage.get(`external-lease:lease:${id}`)).cancelledProcessIds, [7]);
});

test('cancel passes a provider 404 through as process_not_found', async () => {
  const token = 'a'.repeat(40), storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  fleet.external.api = { request: async () => { throw Object.assign(new Error('gone'), { status: 404 }); } };
  await storage.put(`external-lease:lease:${id}`, leaseLease());
  const result = await fleet.fetch(cancelRequest(token, 'lease', { id, processId: 7 }));
  assert.equal(result.status, 404);
  assert.deepEqual(await result.json(), { reason: 'process_not_found' });
});

test('release holds a lease for a bounded keep and refuses every other value', async () => {
  const token = 'a'.repeat(40), storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  const calls = [];
  fleet.router.externalApi = { forIdentity: async () => ({ request: async (...args) => { calls.push(args); return {}; } }) };
  await storage.put(`external-lease:lease:${id}`, leaseLease());
  await storage.put('project:project-a:box:bx_12345678', { machineId: 'bx_12345678', leaseId: id, leaseClient: 'lease', state: 'leased', generation: 0 });
  const send = body => fleet.fetch(new Request('https://fleet/router/lease/release', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, ...body }) }));
  for (const keepOnFailSeconds of [901, -1, 1.5, '60', true, null]) assert.equal((await send({ keepOnFailSeconds })).status, 400, String(keepOnFailSeconds));
  const response = await send({ keepOnFailSeconds: 900 });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.id, id);
  assert.ok(body.heldUntil > Date.now());
  assert.deepEqual(calls, [['boat', '/sandboxes/bx_12345678', { method: 'PATCH', body: { ttlSeconds: 900 } }]]);
  assert.equal((await storage.get(`external-lease:lease:${id}`)).state, 'held');
  const renew = await fleet.fetch(new Request('https://fleet/router/lease/renew', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) }));
  assert.equal(renew.status, 409);
  const execute = await fleet.fetch(new Request('https://fleet/router/lease/execute', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, command: 'ls' }) }));
  assert.equal(execute.status, 200);
  assert.deepEqual(calls[1], ['boat', '/sandboxes/bx_12345678/commands', { method: 'POST', body: { command: 'ls', detached: true } }]);
  const write = await fleet.fetch(new Request('https://fleet/router/lease/file-write', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id, path: '/tmp/chunk', content: 'YQ==', encoding: 'base64' }) }));
  assert.equal(write.status, 409, 'only read, stream and execute work during a hold');
});

test('release without a keep deletes the box', async () => {
  const token = 'a'.repeat(40), storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  await storage.put(`external-lease:lease:${id}`, leaseLease());
  await storage.put('project:project-a:box:bx_12345678', { machineId: 'bx_12345678', leaseId: id, leaseClient: 'lease', state: 'leased', generation: 0 });
  const result = await fleet.fetch(new Request('https://fleet/router/lease/release', { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': 'lease', Authorization: `Bearer ${token}` }, body: JSON.stringify({ id }) }));
  assert.equal(result.status, 204);
  assert.equal((await storage.get(`external-lease:lease:${id}`)).state, 'cleaning');
});

test('a lease client network policy is validated and named on the claim', async () => {
  const token = 'a'.repeat(40), storage = new Storage();
  const network = { mode: 'allow', inbound: 'boat-only', allow: ['registry.npmjs.org', '*.crates.io'] };
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token), network } };
  const fleet = leaseFleet(storage, clients);
  assert.deepEqual(fleet.external.config('lease').network, network);
  fleet.external.claim = async () => ({ machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  const response = await fleet.fetch(claimRequest('lease', token, id, {}));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).network, { mode: 'allow', inbound: 'boat-only' });
  for (const malformed of [
    { mode: 'proxy', allow: [], inbound: 'boat-only' },
    { mode: 'allow', allow: ['https://registry.npmjs.org'], inbound: 'boat-only' },
    { mode: 'allow', allow: ['registry.npmjs.org/path'], inbound: 'boat-only' },
    { mode: 'allow', allow: Array.from({ length: 101 }, () => 'a.example.com'), inbound: 'boat-only' },
    { mode: 'allow', allow: [], inbound: 'open' },
    { mode: 'allow', allow: [], inbound: 'boat-only', extra: true },
  ]) {
    const broken = leaseFleet(new Storage(), { lease: { ...clients.lease, network: malformed } });
    assert.equal(broken.external.config('lease'), null, JSON.stringify(malformed));
  }
});

test('a client without a network policy claims without one', async () => {
  const token = 'a'.repeat(40), storage = new Storage();
  const clients = { lease: { enabled: true, project: 'project-a', maxActive: 6, startsPerDay: 60, ttlSeconds: 900, tokenHash: await hash(token) } };
  const fleet = leaseFleet(storage, clients);
  fleet.external.claim = async () => ({ machineId: 'bx_12345678', expiresAt: Date.now() + 60_000 });
  const response = await fleet.fetch(claimRequest('lease', token, id, {}));
  assert.equal((await response.json()).network, undefined);
});
