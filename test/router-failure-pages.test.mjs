import test from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.mjs';
import { hash } from '../src/setup.mjs';
import { Storage } from './helpers.mjs';
import { TenantStorage } from '../src/router/tenant-storage.mjs';
import { prunePool } from '../src/router/pool-prune.mjs';

async function fixture() {
  const control = 'k'.repeat(40), storage = new Storage();
  const env = { PLUGIN_ROUTER:'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET:'team_test', ROUTER_PROJECTS:'project-a,project-b', SETUP_BOOTSTRAP: JSON.stringify({controlHash:await hash(control)}) };
  const fleet = new Fleet({ storage }, env), headers = { Authorization:`Bearer ${control}` };
  const url = 'https://fleet/router/verification-failures?project=project-a';
  const get = query => fleet.fetch(new Request(url + query, {headers}));
  return { storage, fleet, url, get };
}

test('authenticated pages preserve stable identities across identical timestamps and failures', async () => {
  const { storage, fleet, url, get } = await fixture(), prefix = 'project:project-a:verification:attempt:failure:';
  assert.equal((await fleet.fetch(new Request(url + '&limit=2'))).status, 401);
  for (const id of ['bx_z:0', 'bx_a:0', 'bx_b:1', 'bx_c:0', 'bx_d:0']) await storage.put(prefix + id, { kind:'boot_failed', phase:'booting', size:'large', at:1234, createdAt:1200 });
  let cursor = null, rows = [];
  do {
    const response = await get('&limit=2' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''));
    assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const page = await response.json(); rows.push(...page.failures); cursor = page.nextCursor;
  } while (cursor);
  assert.equal(rows.length,5); assert.equal(new Set(rows.map(row => row.id)).size,5);
  assert.ok(rows.every(row => row.at === 1234 && row.createdAt === 1200 && row.size === 'large' && row.kind === 'boot_failed'));
  assert.deepEqual(rows.map(row => row.boxId), ['bx_a','bx_b','bx_c','bx_d','bx_z']);
  // A later inserted key can sort before the previous cursor. A fresh scan sees it.
  await storage.put(prefix + 'bx_0:0', {kind:'boot_timeout',at:1234});
  assert.equal((await (await get('&limit=2')).json()).failures[0].boxId, 'bx_0');
});

test('pagination validates cursors and limits; legacy response stays an array', async () => {
  const {storage,get} = await fixture();
  await storage.put('project:project-a:verification:attempt:failure:bx_a:0',{at:5,kind:'boot_failed'});
  for (const query of ['&limit=0','&limit=129','&limit=1.5','&limit=01','&cursor=bogus','&cursor='+encodeURIComponent('project:project-b:verification:attempt:failure:bx:0')]) assert.equal((await get(query)).status,400,query);
  const legacy = await (await get('')).json();
  assert.deepEqual(legacy,[{kind:'boot_failed',phase:null,boxId:'bx_a',generation:0,at:5,message:null}]);
  assert.equal((await (await get('&limit=1')).json()).failures.length,1);
});

test('paged diagnostics expose only allowlisted categories and normalized output', async () => {
  const {storage,get} = await fixture(), prefix = 'project:project-a:verification:attempt:failure:';
  const secret = 'EXAMPLE_SECRET_DO_NOT_ECHO';
  await storage.put(prefix+'bx_a:0',{ kind:'boot_failed', phase:'booting', size:'large', at:1, message:JSON.stringify({ state:'error', setupStatus:'failed', providerErrorCategory:'network', captureStatus:'ok', retryEligible:true, setupOutput:['BOAT_SETUP_PHASE apt_update',`TOKEN=${secret}`,'[apt network failure]'], rawError:secret }) });
  await storage.put(prefix+'bx_b:0',{kind:secret, phase:secret, size:secret, at:2, message:secret});
  const page = await (await get('&limit=10')).json(), serialized = JSON.stringify(page);
  assert.equal(serialized.includes(secret),false);
  const diag = JSON.parse(page.failures[0].message);
  assert.equal(diag.providerErrorCategory,'network');
  assert.deepEqual(diag.setupOutput,['BOAT_SETUP_PHASE apt_update','TOKEN=[redacted]','[apt network failure]']);
  assert.equal(page.failures[1].message,null); assert.equal(page.failures[1].size,null);
});

test('existing seven-day pruning applies to paged records', async () => {
  const {storage,get} = await fixture(), now = 10 * 86400_000, prefix = 'project:project-a:verification:attempt:failure:';
  await storage.put(prefix+'bx_old:0',{at:now-8*86400_000,kind:'boot_failed'});
  await storage.put(prefix+'bx_new:0',{at:now-86400_000,kind:'boot_failed'});
  await prunePool(new TenantStorage(storage,'project-a'), now);
  const page = await (await get('&limit=10')).json();
  assert.deepEqual(page.failures.map(row=>row.boxId),['bx_new']);
});

test('storage failures record the exception and still fail the request', async () => {
  const {storage, get} = await fixture(), originalList = storage.list.bind(storage), originalError = console.error, logs = [];
  storage.list = async options => {
    if (options.prefix?.includes('verification:attempt:failure:')) throw new TypeError('storage unavailable');
    return originalList(options);
  };
  console.error = line => logs.push(JSON.parse(line));
  try {
    await assert.rejects(get('&limit=1'), /storage unavailable/);
  } finally { console.error = originalError; }
  assert.equal(logs[0].event, 'verification_failures_exception');
  assert.equal(logs[0].errorClass, 'TypeError');
  assert.match(logs[0].message, /storage unavailable/);
  assert.match(logs[0].stack, /storage unavailable/);
});

test('forwarding failures record the exception and still fail the request', async () => {
  const {default: worker} = await import('../src/worker.mjs');
  const env = { FLEET: { idFromName: () => 'id', get: () => ({ fetch: async () => { throw new TypeError('object unavailable'); } }) } };
  const originalError = console.error, logs = [];
  console.error = line => logs.push(JSON.parse(line));
  try {
    await assert.rejects(worker.fetch(new Request('https://worker/router/verification-failures?project=project-a'), env), /object unavailable/);
  } finally { console.error = originalError; }
  assert.equal(logs[0].event, 'verification_failures_forward_exception');
  assert.equal(logs[0].errorClass, 'TypeError');
  assert.match(logs[0].stack, /object unavailable/);
});

test('paged diagnostics carry the setup error category, the phase and sanitized lines; unknown vocabulary is dropped', async () => {
  const {storage,get} = await fixture(), prefix = 'project:project-a:verification:attempt:failure:';
  const secret = 'ghp_' + 'Zz9'.repeat(14);
  const message = { state:'idle', setupStatus:'failed', providerErrorCategory:'unknown', captureStatus:'ok', retryEligible:true, exitCode:22,
    setupErrorCategory:'download_http_5xx', setupPhase:'powershell_download',
    setupOutput:['BOAT_SETUP_PHASE powershell_download', `curl: (22) The requested URL returned error: 504 for https://x.example/a?token=${secret}`, `Authorization: Bearer ${secret}`, 'BOAT_SETUP_FAILED phase=powershell_download status=22 line=88'] };
  await storage.put(prefix+'bx_a:0',{ kind:'boot_failed', phase:'booting', size:'large', at:1, message:JSON.stringify(message) });
  await storage.put(prefix+'bx_b:0',{ kind:'boot_failed', phase:'booting', size:'large', at:2, message:JSON.stringify({ ...message, setupErrorCategory:secret, setupPhase:secret }) });
  const page = await (await get('&limit=10')).json(), serialized = JSON.stringify(page);
  assert.equal(serialized.includes(secret), false);
  const diag = JSON.parse(page.failures[0].message);
  assert.equal(diag.setupErrorCategory, 'download_http_5xx');
  assert.equal(diag.setupPhase, 'powershell_download');
  assert.equal(diag.exitCode, 22);
  assert.deepEqual(diag.setupOutput, ['BOAT_SETUP_PHASE powershell_download', 'curl: (22) The requested URL returned error: 504 for https://x.example/a?[redacted]', 'Authorization=[redacted]', 'BOAT_SETUP_FAILED phase=powershell_download status=22 line=88']);
  const other = JSON.parse(page.failures[1].message);
  assert.equal(other.setupErrorCategory, undefined); assert.equal(other.setupPhase, undefined);
});
