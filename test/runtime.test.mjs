import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { build } from 'esbuild';

const bundle = await build({ entryPoints: ['test/runtime-worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], logLevel: 'silent' });
const runtimeScript = bundle.outputFiles[0].text;

test('authenticated lifecycle stream pushes safe events in the real Workers runtime', async () => {
  const { hash } = await import('../src/setup.mjs');
  const control = 'fake-runtime-events-control-32-characters';
  const mf = new Miniflare({
    modules: true, script: runtimeScript, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FLEET: { className: 'TestFleet', useSQLite: true } },
    bindings: { ENABLED: 'false', SETUP_BOOTSTRAP: JSON.stringify({ controlHash: await hash(control) }), GITHUB_WEBHOOK_SECRET: 'fake-events-secret' },
    log: new Log(LogLevel.ERROR), outboundService: async () => new Response(null, { status: 503 }),
  });
  try {
    assert.equal((await mf.dispatchFetch('https://launcher.test/events')).status, 401);
    const response = await mf.dispatchFetch('https://launcher.test/events', { headers: { Authorization: 'Bearer ' + control } });
    assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
    const reader = response.body.getReader(); const decode = value => new TextDecoder().decode(value);
    assert.match(decode((await reader.read()).value), /"event":"connected"/);
    const body = JSON.stringify({ action: 'queued', repository: { full_name: 'example-owner/project-b' }, installation: { id: 1 }, workflow_job: { id: 501, labels: ['boat-large'] } });
    const headers = { 'X-GitHub-Event': 'workflow_job', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', 'fake-events-secret').update(body).digest('hex') };
    await mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', headers, body });
    await mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', headers, body });
    const event = decode((await reader.read()).value);
    assert.match(event, /"event":"reuse"/); assert.match(event, /"job_id":501/);
    assert.ok(!event.includes('fake-events-secret')); assert.ok(!event.includes(control));
    await reader.cancel();
  } finally { await mf.dispose(); }
});

test('real Workers runtime persists signed events, dedupes, and arms a SQLite Durable Object alarm', async () => {
  const options = {
    modules: true, script: runtimeScript, compatibilityDate: '2026-07-30',
    compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FLEET: { className: 'TestFleet', useSQLite: true } },
    bindings: { ENABLED: 'false', GITHUB_WEBHOOK_SECRET: 'fake-runtime-webhook-secret' },
    log: new Log(LogLevel.ERROR),
    outboundService: async () => new Response(null, { status: 503 }),
  };
  const mf = new Miniflare(options);
  try {
    const payload = { action: 'queued', repository: { full_name: 'example-owner/project-b' }, installation: { id: 1 }, workflow_job: { id: 501, labels: ['boat-large'] } };
    const body = JSON.stringify(payload);
    const headers = { 'X-GitHub-Event': 'workflow_job', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', options.bindings.GITHUB_WEBHOOK_SECRET).update(body).digest('hex') };
    assert.equal((await mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', body, headers })).status, 202);
    const ns = await mf.getDurableObjectNamespace('FLEET');
    let stub = ns.get(ns.idFromName('production-v1'));
    const inspect = async () => (await stub.fetch('https://fleet/inspect')).json();
    assert.equal((await inspect()).job.size, 'large');
    assert.equal(typeof (await inspect()).alarm, 'number');
    const originalKey = (await inspect()).job.createKey;
    await mf.setOptions({ ...options, bindings: { ...options.bindings, TEST_REVISION: '2' } });
    const ns2 = await mf.getDurableObjectNamespace('FLEET');
    stub = ns2.get(ns2.idFromName('production-v1'));
    assert.equal((await mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', body, headers })).status, 202);
    assert.equal((await inspect()).activeCount, 1);
    assert.equal((await inspect()).job.createKey, originalKey);
    const health = await (await mf.dispatchFetch('https://launcher.test/health')).json();
    assert.deepEqual(health, { enabled: false, blocked: false, has_active_jobs: true });
  } finally { await mf.dispose(); }
});

test('real Workers runtime signs App JWTs and cleans up an unassigned cancelled runner', async () => {
  const { fixture } = await import('./helpers.mjs');
  const f = fixture(); f.clock.time = Date.now();
  const mf = new Miniflare({
    modules: true, script: runtimeScript, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FLEET: { className: 'TestFleet', useSQLite: true } }, bindings: f.env, log: new Log(LogLevel.ERROR),
    outboundService: async (request) => f.fetcher(request.url, { method: request.method,
      headers: Object.fromEntries(request.headers), body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text() }),
  });
  try {
    const send = async (action) => {
      const body = JSON.stringify({ action, repository: { full_name: 'example-owner/project-b' }, installation: { id: 1 },
        workflow_job: { id: 501, labels: ['boat-default'], runner_name: null } });
      const headers = { 'X-GitHub-Event': 'workflow_job', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', f.env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex') };
      return mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', body, headers });
    };
    assert.equal((await send('queued')).status, 202);
    const ns = await mf.getDurableObjectNamespace('FLEET'); const stub = ns.get(ns.idFromName('production-v1'));
    for (let i = 0; i < 5; i++) await stub.fetch('https://fleet/step');
    assert.equal((await (await stub.fetch('https://fleet/inspect')).json()).job.phase, 'running');
    assert.equal(f.fake.starts, 1); assert.equal(f.fake.files[0].content, f.fake.jit);
    assert.equal((await send('completed')).status, 202);
    for (let i = 0; i < 4; i++) await stub.fetch('https://fleet/step');
    assert.equal((await (await stub.fetch('https://fleet/inspect')).json()).job.phase, 'done');
    assert.deepEqual(f.fake.deletes, ['bx_23456782']);
  } finally { await mf.dispose(); }
});

test('real Workers runtime completes manifest setup, restarts, and uses Worker secret App credentials for a private lifecycle proof', async () => {
  const { fixture } = await import('./helpers.mjs');
  const { hash } = await import('../src/setup.mjs');
  const f = fixture(); f.clock.time = Date.now();
  const token = 'fake-runtime-setup-token-of-32-characters';
  const control = 'fake-runtime-control-token-of-32-characters';
  const secret = 'PRIVATE_FAKE_RUNTIME_MANIFEST_SECRET';
  let conversions = 0;
  const options = {
    modules: true, script: runtimeScript, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FLEET: { className: 'TestFleet', useSQLite: true } }, log: new Log(LogLevel.ERROR),
    bindings: { ENABLED: 'false', PUBLIC_ORIGIN: 'https://launcher.test', BOAT_CI_API_KEY: f.env.BOAT_CI_API_KEY,
      SETUP_BOOTSTRAP: JSON.stringify({ tokenHash: await hash(token), expiresAt: Date.now() + 30 * 60_000, controlHash: await hash(control) }) },
    outboundService: async request => {
      if (new URL(request.url).pathname.includes('/app-manifests/')) {
        conversions++; assert.equal(request.headers.get('Authorization'), null);
        return Response.json({ id: 123, slug: 'boat-ci-test', owner: { login: 'example-owner' }, pem: f.env.GITHUB_APP_PRIVATE_KEY, webhook_secret: secret });
      }
      return f.fetcher(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text() });
    },
  };
  const mf = new Miniflare(options);
  try {
    const preview = await mf.dispatchFetch('https://launcher.test/setup?token=' + token);
    assert.equal(preview.status, 200); assert.equal(preview.headers.get('Set-Cookie'), null);
    const setup = await mf.dispatchFetch('https://launcher.test/setup', { method: 'POST', headers: { Origin: 'https://launcher.test' }, body: new URLSearchParams({ token }) });
    assert.equal(setup.status, 200);
    const cookie = setup.headers.get('Set-Cookie').split(';')[0]; const state = cookie.split('=')[1];
    assert.equal((await mf.dispatchFetch(`https://launcher.test/setup/callback?code=fake-runtime-code&state=${state}`, { headers: { Cookie: cookie }, redirect: 'manual' })).status, 303);
    assert.equal((await mf.dispatchFetch('https://launcher.test/setup?token=' + token)).status, 409);
    assert.equal(conversions, 1);
    await mf.setOptions({ ...options, bindings: { ...options.bindings, ENABLED: 'true', GITHUB_APP_PRIVATE_KEY: f.env.GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET: secret } });
    const send = async (action, signingSecret = secret) => {
      const body = JSON.stringify({ action, repository: { full_name: 'example-owner/project-b' }, installation: { id: 1 },
        workflow_job: { id: 501, labels: ['boat-default'], runner_name: action === 'completed' ? 'boat-ci-j501' : null } });
      return mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', body,
        headers: { 'X-GitHub-Event': 'workflow_job', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', signingSecret).update(body).digest('hex') } });
    };
    assert.equal((await send('queued', 'wrong-secret')).status, 401);
    assert.equal((await send('queued')).status, 202);
    const ns = await mf.getDurableObjectNamespace('FLEET'); const stub = ns.get(ns.idFromName('production-v1'));
    for (let i = 0; i < 5; i++) await stub.fetch('https://fleet/step');
    assert.equal(f.fake.starts, 1); assert.equal(f.fake.files[0].content, f.fake.jit);
    const auth = f.fake.requests.find(r => r.path.endsWith('/access_tokens')).headers.authorization;
    assert.equal(JSON.parse(Buffer.from(auth.split('.')[1], 'base64url')).iss, '123');
    assert.equal((await send('completed')).status, 202);
    for (let i = 0; i < 4; i++) await stub.fetch('https://fleet/step');
    assert.equal((await mf.dispatchFetch('https://launcher.test/proof?job_id=501')).status, 401);
    assert.equal((await mf.dispatchFetch('https://launcher.test/status')).status, 401);
    const status = await mf.dispatchFetch('https://launcher.test/status', { headers: { Authorization: 'Bearer ' + control } });
    assert.equal(status.status, 200); assert.deepEqual((await status.json()).alerts, []);
    const proof = await mf.dispatchFetch('https://launcher.test/proof?job_id=501', { headers: { Authorization: 'Bearer ' + control } });
    assert.equal(proof.status, 200); assert.equal(proof.headers.get('Cache-Control'), 'no-store');
    const text = await proof.text(); const result = JSON.parse(text);
    assert.equal(result.phase, 'done'); assert.equal(result.machine_id, 'bx_23456782');
    assert.ok(result.events.some(e => e.event === 'start' && e.job_id === 501 && e.machine_id === 'bx_23456782'));
    assert.ok(result.events.some(e => e.event === 'destroy_purged' && e.machine_id === 'bx_23456782'));
    for (const value of [secret, f.env.GITHUB_APP_PRIVATE_KEY, f.fake.jit, f.env.BOAT_CI_API_KEY, control, token]) assert.ok(!text.includes(value));
    assert.deepEqual(f.fake.deletes, ['bx_23456782']);
  } finally { await mf.dispose(); }
});

test('authenticated runtime status exposes sanitized permanent-error alerts', async () => {
  const { fixture } = await import('./helpers.mjs'); const { hash } = await import('../src/setup.mjs');
  const f = fixture(); const control = 'fake-runtime-alert-control-of-32-characters';
  const mf = new Miniflare({
    modules: true, script: runtimeScript, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { FLEET: { className: 'TestFleet', useSQLite: true } }, log: new Log(LogLevel.ERROR),
    bindings: { ...f.env, SETUP_BOOTSTRAP: JSON.stringify({ controlHash: await hash(control) }) },
    outboundService: async request => {
      if (new URL(request.url).pathname.endsWith('/actions/jobs/501')) return Response.json({ message: f.fake.jit }, { status: 404 });
      return f.fetcher(request.url, { method: request.method, headers: Object.fromEntries(request.headers),
        body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.text() });
    },
  });
  try {
    const body = JSON.stringify({ action: 'queued', repository: { full_name: 'example-owner/project-b' }, installation: { id: 1 }, workflow_job: { id: 501, labels: ['boat-default'] } });
    assert.equal((await mf.dispatchFetch('https://launcher.test/webhook', { method: 'POST', body, headers: {
      'X-GitHub-Event': 'workflow_job', 'X-Hub-Signature-256': 'sha256=' + createHmac('sha256', f.env.GITHUB_WEBHOOK_SECRET).update(body).digest('hex'),
    } })).status, 202);
    const ns = await mf.getDurableObjectNamespace('FLEET'); const stub = ns.get(ns.idFromName('production-v1'));
    for (let i = 0; i < 3; i++) await stub.fetch('https://fleet/step');
    assert.equal((await mf.dispatchFetch('https://launcher.test/status')).status, 401);
    const response = await mf.dispatchFetch('https://launcher.test/status', { headers: { Authorization: 'Bearer ' + control } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const output = await response.text(); const status = JSON.parse(output);
    assert.ok(status.alerts.some(e => e.event === 'alert_permanent_error' && e.job_id === 501 && e.status === 404));
    assert.equal(status.has_active_jobs, false); assert.equal(f.fake.starts, 0);
    for (const value of [control, f.fake.jit, f.env.GITHUB_APP_PRIVATE_KEY, f.env.BOAT_CI_API_KEY]) assert.ok(!output.includes(value));
  } finally { await mf.dispose(); }
});
