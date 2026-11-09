import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AlertHooks } from '../src/router/alert-hooks.mjs';

test('hooks deduplicate crossings, recover and rearm', async () => {
  const posts = [], pending = [], storage = new Storage();
  const hooks = new AlertHooks(storage, [{ on: ['starts_day'], url: 'https://example.test', thresholdPct: 80 }], () => ({}), { now: () => 0, waitUntil: p => pending.push(p), fetcher: async (_, options) => { posts.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } });
  for (const value of [80, 90, 79, 80]) await hooks.observe('starts_day', { value, limit: 100 });
  await Promise.all(pending);
  assert.deepEqual(posts.map(p => p.event), ['starts_day', 'recovered', 'starts_day']);
});

test('failed delivery retries once without delaying observation', async () => {
  let calls = 0; const pending = [];
  const hooks = new AlertHooks(new Storage(), [{ on: ['breaker_open'], url: 'https://example.test' }], () => ({}), { waitUntil: p => pending.push(p), fetcher: async () => { calls++; throw Error('offline'); } });
  await hooks.observe('breaker_open', { active: true, value: 1, limit: 1 });
  await Promise.all(pending);
  assert.equal(calls, 2);
});

test('delivery failure logs the event and status or safe error without secrets', async () => {
  const original = console.error, logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    for (const fetcher of [async () => new Response('payload-secret', { status: 503 }), async () => { throw new TypeError('https://example.test/?token=url-secret payload-secret'); }]) {
      const pending = [];
      const hooks = new AlertHooks(new Storage(), [{ on: ['breaker_open'], url: 'https://example.test/?token=url-secret' }], () => ({}), { waitUntil: p => pending.push(p), fetcher });
      await hooks.observe('breaker_open', { active: true });
      await Promise.all(pending);
    }
    assert.deepEqual(logs, ['Alert delivery failed breaker_open HTTP 503', 'Alert delivery failed breaker_open TypeError']);
    assert.ok(logs.every(line => !line.includes('secret')));
  } finally { console.error = original; }
});

test('concurrent ticks deduplicate and a window roll can fire again', async () => {
  const posts = [], pending = [];
  const hooks = new AlertHooks(new Storage(), [{ on: ['hours'], url: 'https://example.test' }], () => ({}), { waitUntil: p => pending.push(p), fetcher: async (_, options) => { posts.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } });
  await Promise.all([hooks.observe('hours', { value: 9, limit: 10, window: 'a' }), hooks.observe('hours', { value: 9, limit: 10, window: 'a' })]);
  await hooks.observe('hours', { value: 9, limit: 10, window: 'b' });
  await Promise.all(pending);
  assert.equal(posts.length, 2);
});

test('a configured secret signs the exact body', async () => {
  const pending = []; let request;
  const hooks = new AlertHooks(new Storage(), [{ on: ['breaker_open'], url: 'https://example.test', secretEnv: 'HOOK_SECRET' }], () => ({ HOOK_SECRET: 'test-secret' }), { waitUntil: p => pending.push(p), fetcher: async (_, options) => { request = options; return new Response(null, { status: 204 }); } });
  await hooks.observe('breaker_open', { value: 1, limit: 1, active: true });
  await Promise.all(pending);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('test-secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(request.headers['x-boat-signature'].slice(7).match(/../g), part => parseInt(part, 16));
  assert.equal(await crypto.subtle.verify('HMAC', key, signature, new TextEncoder().encode(request.body)), true);
});

test('crossings and recovery survive a Durable Object restart', async () => {
  const storage = new Storage(), posts = [], pending = [];
  const config = [{ on: ['starts_day'], url: 'https://example.test', thresholdPct: 80 }];
  const start = () => new AlertHooks(storage, config, () => ({}), { waitUntil: p => pending.push(p), fetcher: async (_, options) => { posts.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } });
  await start().observe('starts_day', { value: 80, limit: 100 });
  await start().observe('starts_day', { value: 90, limit: 100 });
  await start().observe('starts_day', { value: 79, limit: 100 });
  await start().observe('starts_day', { value: 70, limit: 100 });
  await Promise.all(pending);
  assert.deepEqual(posts.map(({ event, recovered }) => [event, recovered]), [['starts_day', undefined], ['recovered', 'starts_day']]);
});

test('breaker clear can be subscribed to without an open notification', async () => {
  const posts = [], pending = [], storage = new Storage();
  const hooks = new AlertHooks(storage, [{ on: ['breaker_cleared'], url: 'https://example.test' }], () => ({}), { waitUntil: p => pending.push(p), fetcher: async (_, options) => { posts.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } });
  await hooks.observe('breaker_open', { active: true });
  await hooks.observe('breaker_open', { active: false });
  await hooks.observe('breaker_open', { active: false });
  await Promise.all(pending);
  assert.deepEqual(posts.map(p => p.event), ['breaker_cleared']);
});

test('hook delivery failures do not block router admission or ticks', async () => {
  const { installRouter } = await import('../src/router/install.mjs');
  for (const failure of ['timeout', '500', 'dns']) {
    const storage = new Storage(), pending = []; let admitted = 0, ticks = 0, calls = 0, release;
    const gate = new Promise(resolve => { release = resolve; });
    const fetcher = async () => {
      calls++;
      if (failure === 'timeout') { await gate; throw new Error('timeout'); }
      if (failure === 'dns') throw new Error('DNS failure');
      return new Response(null, { status: 500 });
    };
    class Controller { constructor(storage) { this.storage = storage; } }
    const router = installRouter(storage, () => ({ BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'test', ROUTER_PROJECTS: 'peek' }), {
      FleetController: Controller, api: { limits: async () => ({ starts: { day: { used: 100, limit: 100 } } }) }, suiteApi: {},
      alertConfigs: [{ on: ['starts_day'], url: 'https://example.test' }], alertFetcher: fetcher, waitUntil: p => pending.push(p),
    });
    const project = router.projects.get('peek');
    project.prepare = async () => { router.observeAlert('peek', 'starts_day', true); };
    project.admissionEntries = async () => [{ key: 'one', at: 0, rank: 'one' }];
    const { BoxFleet } = await import('../src/router/box-fleet.mjs');
    let claim;
    const budget = { claimKey: async () => 'a'.repeat(64), enqueue: async () => {}, claim: async () => claim, admit: async () => { claim = { status: 'pending' }; return { ok: true }; }, begin: async () => { claim.status = 'calling'; return true; }, settle: async (_, status) => { claim.status = status; return true; } };
    const boxes = new BoxFleet(project.storage, { create: async () => ({ sandbox: { id: 'bx_23456789' } }) }, () => 100, { budget, alert: (event, data) => router.observeAlert('peek', event, data.active) });
    const [record] = await boxes.prepare('pool', 'large', 1, 1);
    project.admitStart = async () => { assert.equal(await boxes.admit(record.createKey, {}, 3600), true); admitted++; };
    project.tick = async () => { router.observeAlert('peek', 'starts_day', true); ticks++; };
    const result = await Promise.race([router.tick(), new Promise((_, reject) => setTimeout(() => reject(new Error('tick blocked by hook')), 1000))]);
    assert.equal(result[0].ok, true); assert.equal(admitted, 1); assert.equal(ticks, 1);
    release(); await Promise.all(pending); assert.equal(calls, 2);
  }
});

test('operator controls and verification changes send transition events', async () => {
  const { installRouter } = await import('../src/router/install.mjs');
  const { Fleet, FleetController } = await import('../src/fleet.mjs');
  const { hash } = await import('../src/setup.mjs');
  const storage = new Storage(), pending = [], posts = [], token = 'x'.repeat(40);
  const env = { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'test', ROUTER_PROJECTS: 'peek', SETUP_BOOTSTRAP: JSON.stringify({ controlHash: await hash(token) }) };
  const fleet = new Fleet({ storage, waitUntil: p => pending.push(p) }, env);
  fleet.router = installRouter(storage, () => env, { FleetController, api: {}, suiteApi: {}, waitUntil: p => pending.push(p), alertConfigs: [{ on: ['pool_drain', 'reuse_off', 'breaker_open', 'breaker_cleared'], url: 'https://example.test' }], alertFetcher: async (_, options) => { posts.push(JSON.parse(options.body)); return new Response(null, { status: 204 }); } });
  const headers = { Authorization: `Bearer ${token}` }, project = fleet.router.projects.get('peek');
  await project.storage.put('pool:mode', 'on');
  assert.equal((await fleet.fetch(new Request('https://fleet/router/pool-mode?mode=drain', { method: 'POST', headers }))).status, 202);
  await Promise.all(pending.splice(0));
  assert.equal((await fleet.fetch(new Request('https://fleet/router/reuse?project=peek&mode=config', { method: 'POST', headers }))).status, 200);
  await Promise.all(pending.splice(0));
  assert.equal((await fleet.fetch(new Request('https://fleet/router/reuse?project=peek&mode=off', { method: 'POST', headers }))).status, 200);
  const boxes = project.box({ storage: project.storage, ledger: fleet.router.ledger });
  for (let i = 0; i < 3; i++) await boxes.verificationOutcome({ machineId: `box-${i}`, size: 'large' }, 'boot_failed', false);
  await Promise.all(pending.splice(0));
  assert.equal((await fleet.fetch(new Request('https://fleet/router/verification-breaker?project=peek', { method: 'POST', headers }))).status, 204);
  await Promise.all(pending.splice(0));
  assert.deepEqual(posts.map(p => p.event), ['pool_drain', 'reuse_off', 'recovered', 'reuse_off', 'breaker_open', 'breaker_cleared']);
});

test('legacy create reports failure and recovery', async () => {
  const { fixture, event } = await import('./helpers.mjs');
  const f = fixture(), events = [];
  f.controller.alertHook = (name, data) => events.push([name, data.active]);
  await f.controller.ingest(event());
  f.fake.refusals.push({ status: 429 });
  await f.pump(1);
  await f.pump(20);
  assert.deepEqual(events.slice(0, 2), [['create_failures', true], ['create_failures', false]]);
});

test('alert failure logs use the shared secret redaction', async () => {
  const original = console.error, logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  try {
    const hooks = new AlertHooks(new Storage(), [], () => ({}), { fetcher: async () => new Response(null, { status: 503 }) });
    await hooks.deliver({ url: 'https://example.test' }, { event: 'ghp_sampleSecret https://example.test/?token=sampleSecret' });
    assert.equal(logs.length, 1);
    assert.ok(!logs[0].includes('sampleSecret'));
    assert.match(logs[0], /\[REDACTED\]/);
  } finally { console.error = original; }
});
