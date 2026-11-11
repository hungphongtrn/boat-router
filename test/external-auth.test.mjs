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
