import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetupController, hash } from '../src/setup.mjs';
import { APIs } from '../src/apis.mjs';
import { Storage, fixture } from './helpers.mjs';

const origin = 'https://launcher.test';
const token = 'fake-onetime-setup-token-32-characters-long';
async function setupFixture() {
  const f = fixture();
  const storage = new Storage();
  const env = { ENABLED: 'false', PUBLIC_ORIGIN: origin, BOAT_CI_API_KEY: f.env.BOAT_CI_API_KEY,
    SETUP_BOOTSTRAP: JSON.stringify({ tokenHash: await hash(token), expiresAt: f.now() + 30 * 60_000 }) };
  const app = { id: 123, slug: 'boat-ci-test', owner: { login: 'example-owner' }, pem: f.env.GITHUB_APP_PRIVATE_KEY,
    webhook_secret: 'PRIVATE_FAKE_MANIFEST_WEBHOOK_SECRET', client_secret: 'PRIVATE_FAKE_UNUSED_CLIENT_SECRET' };
  const requests = []; const alerts = [];
  let convert = async () => Response.json(app);
  const api = new APIs(env, async (url, options) => { requests.push({ url, options }); return convert(url, options); }, f.now, () => storage.get('github-app'));
  const controller = new SetupController(storage, env, api, f.now, async event => { alerts.push(event); });
  const call = path => controller.fetch(new Request(origin + path));
  const post = () => controller.fetch(new Request(origin + '/setup', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ token }) }));
  async function begin() {
    const response = await post();
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    const state = cookie.split('=')[1];
    return { response, cookie, state };
  }
  const callback = (flow, { state = flow.state, cookie = flow.cookie, code = 'fake-code' } = {}) =>
    controller.fetch(new Request(`${origin}/setup/callback?code=${code}&state=${state}`, { headers: cookie ? { Cookie: cookie } : {} }));
  return { ...f, env, storage, app, requests, alerts, controller, call, post, begin, callback, setConvert: value => { convert = value; } };
}
test('setup auto-submits the exact manifest with private state and browser binding', async () => {
  const f = await setupFixture(); const { response, state } = await f.begin();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, new RegExp(`action="https://github.com/settings/apps/new\\?state=${state}"`));
  assert.match(html, /document.getElementById\('manifest'\).submit\(\)/);
  assert.match(html, /history.replaceState/);
  const raw = html.match(/name="manifest" value="([^"]+)"/)[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  const manifest = JSON.parse(raw);
  assert.equal(manifest.redirect_url, `${origin}/setup/callback`);
  assert.deepEqual(manifest.hook_attributes, { url: `${origin}/webhook`, active: true });
  assert.deepEqual(manifest.default_permissions, { actions: 'read', administration: 'write', metadata: 'read' });
  assert.deepEqual(manifest.default_events, ['workflow_job']); assert.equal(manifest.public, false);
  assert.match(response.headers.get('Set-Cookie'), /Secure; HttpOnly; SameSite=Lax/);
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer'); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.match(response.headers.get('Content-Security-Policy'), /frame-ancestors 'none'/);
  assert.ok(!html.includes(token)); assert.ok(!JSON.stringify([...f.storage.data]).includes(state));
  assert.equal(f.requests.length, 0);
});
test('setup status requires control authorization before accessing private App or providers', async () => {
  const f = await setupFixture();
  assert.equal((await f.call('/setup/status')).status, 401);
  assert.equal(f.requests.length, 0);
});
test('setup status lists installation repositories and sanitized deliveries without credentials', async () => {
  const f = await setupFixture();
  const control = 'fake-control-setup-status-32-characters';
  const config = JSON.parse(f.env.SETUP_BOOTSTRAP); config.controlHash = await hash(control); f.env.SETUP_BOOTSTRAP = JSON.stringify(config);
  const get = () => f.controller.fetch(new Request(origin + '/setup/status', { headers: { Authorization: 'Bearer ' + control } }));
  assert.deepEqual(await (await get()).json(), { app_configured: false, private_key_stored: false, private_key_source: null, webhook_secret_stored: false, webhook_secret_source: null, private_key_in_storage: false, webhook_secret_in_storage: false });
  await f.storage.put('github-app', { id: '123', pem: f.app.pem, webhookSecret: f.app.webhook_secret });
  f.env.GITHUB_APP_PRIVATE_KEY = f.app.pem;
  f.env.GITHUB_WEBHOOK_SECRET = f.app.webhook_secret;
  const accessToken = 'PRIVATE_FAKE_DIAGNOSTIC_INSTALLATION_TOKEN';
  f.setConvert(async url => {
    const path = new URL(url).pathname;
    if (path === '/app') return Response.json({ id: 123, slug: 'boat-ci-test' });
    if (path === '/app/installations') return Response.json([{ id: 7, account: { login: 'example-owner' }, repository_selection: 'selected', suspended_at: null, permissions: { administration: 'write' } }]);
    if (path.endsWith('/access_tokens')) return Response.json({ token: accessToken });
    if (path === '/installation/repositories') return Response.json({ total_count: 2, repositories: [{ full_name: 'example-owner/project-c' }, { full_name: 'example-owner/project-b' }] });
    if (path === '/app/hook/deliveries') return Response.json([{ id: 1, event: 'ping', status_code: 204, delivered_at: '2026-10-19T00:00:00Z', request: { headers: { authorization: accessToken } }, response: { payload: f.app.webhook_secret } }]);
    throw Error('Unexpected diagnostic request');
  });
  const response = await get(); const body = await response.text(); const status = JSON.parse(body);
  assert.equal(response.status, 200); assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(status.private_key_stored, true); assert.equal(status.webhook_secret_stored, true);
  assert.deepEqual(status.installations[0].repositories, ['example-owner/project-c', 'example-owner/project-b']);
  assert.deepEqual(status.deliveries, [{ id: 1, event: 'ping', status_code: 204, delivered_at: '2026-10-19T00:00:00Z' }]);
  for (const secret of [f.app.pem, f.app.webhook_secret, accessToken]) assert.ok(!body.includes(secret));
  const mint = f.requests.find(x => x.url.endsWith('/access_tokens'));
  assert.deepEqual(JSON.parse(mint.options.body), { permissions: { metadata: 'read' } });
});
test('invalid, expired, wrong-origin, and enabled setup attempts have no effects', async () => {
  const f = await setupFixture();
  assert.equal((await f.call('/setup')).status, 401);
  assert.equal((await f.call('/setup?token=' + 'x'.repeat(40))).status, 401);
  assert.equal((await f.controller.fetch(new Request('https://wrong.test/setup?token=' + token))).status, 400);
  f.env.ENABLED = 'true'; assert.equal((await f.call('/setup?token=' + token)).status, 409); f.env.ENABLED = 'false';
  f.clock.time += 30 * 60_000; assert.equal((await f.call('/setup?token=' + token)).status, 401);
  assert.equal(f.storage.data.size, 0); assert.equal(f.requests.length, 0);
});
test('the setup token is single-use, including concurrent requests and expiry', async () => {
  const f = await setupFixture();
  const responses = await Promise.all([f.post(), f.post()]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const flow = await f.storage.get('setup-flow');
  assert.equal((await f.call('/setup?token=' + token)).status, 409);
  assert.deepEqual(await f.storage.get('setup-flow'), flow);
  f.clock.time += 30 * 60_000;
  assert.equal((await f.call('/setup?token=' + token)).status, 401);
});
test('callbacks require a started flow, correct state, browser cookie, and unexpired deadline', async () => {
  const f = await setupFixture();
  const unknown = { state: 'a'.repeat(64), cookie: '__Host-boat-ci-setup=' + 'a'.repeat(64) };
  assert.equal((await f.callback(unknown)).status, 409);
  const flow = await f.begin();
  assert.equal((await f.callback(flow, { cookie: '' })).status, 401);
  assert.equal((await f.callback(flow, { state: 'b'.repeat(64) })).status, 401);
  assert.equal((await f.callback(unknown)).status, 409);
  assert.equal((await f.callback(flow, { code: '../bad' })).status, 401);
  f.clock.time += 30 * 60_000;
  assert.equal((await f.callback(flow)).status, 409); assert.equal(f.requests.length, 0);
});
test('conversion persists only required App credentials and closes setup without revealing them', async () => {
  const f = await setupFixture(); const flow = await f.begin();
  const response = await f.callback(flow);
  assert.equal(response.status, 303); assert.equal(response.headers.get('Location'), '/setup/installed');
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, 'https://api.github.com/app-manifests/fake-code/conversions');
  assert.equal(f.requests[0].options.method, 'POST');
  assert.equal(new Headers(f.requests[0].options.headers).get('Authorization'), null);
  assert.deepEqual(await f.storage.get('github-app'), { id: '123', slug: f.app.slug, pem: f.app.pem, webhookSecret: f.app.webhook_secret });
  const installed = await f.call('/setup/installed'); const html = await installed.text();
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => new URL(m[1].replace(/&amp;/g, '&')));
  assert.equal(links.length, 1);
  assert.equal(links[0].pathname, '/apps/boat-ci-test/installations/new/permissions');
  const output = await response.text() + html + await (await f.call('/setup?token=' + token)).text();
  for (const secret of [f.app.pem, f.app.webhook_secret, f.app.client_secret, f.env.BOAT_CI_API_KEY]) assert.ok(!output.includes(secret));
  assert.ok(!JSON.stringify([...f.storage.data]).includes(f.app.client_secret));
  assert.equal((await f.call('/setup?token=' + token)).status, 409);
  assert.equal((await f.callback(flow)).status, 409); assert.equal(f.requests.length, 1);
});
test('concurrent callbacks perform exactly one conversion', async () => {
  const f = await setupFixture(); const flow = await f.begin();
  const results = await Promise.all([f.callback(flow), f.callback(flow)]);
  assert.deepEqual(results.map(r => r.status).sort(), [303, 409]); assert.equal(f.requests.length, 1);
});
test('uncertain conversion locks setup across bootstrap rotation and never retries the effect', async () => {
  const f = await setupFixture(); const flow = await f.begin();
  f.setConvert(async () => { throw new Error(f.app.pem + f.app.webhook_secret); });
  const response = await f.callback(flow); assert.equal(response.status, 502);
  const html = await response.text(); assert.ok(!html.includes(f.app.pem)); assert.ok(!html.includes(f.app.webhook_secret));
  assert.equal((await f.callback(flow)).status, 409);
  f.clock.time += 31 * 60_000;
  f.env.SETUP_BOOTSTRAP = JSON.stringify({ tokenHash: await hash('rotated-token-of-at-least-32-characters'), expiresAt: f.now() + 30 * 60_000 });
  assert.equal((await f.controller.fetch(new Request(origin + '/setup', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ token: 'rotated-token-of-at-least-32-characters' }) }))).status, 409);
  assert.equal(f.requests.length, 1); assert.equal(await f.storage.get('github-app'), undefined);
});
test('invalid conversion data and a different App owner cannot configure the launcher', async () => {
  for (const change of [{ owner: { login: 'unrelated' } }, { owner: {} }, { pem: 'invalid-key' }, { id: -1 }, { slug: '<script>' }]) {
    const f = await setupFixture(); Object.assign(f.app, change); const flow = await f.begin();
    assert.equal((await f.callback(flow)).status, change.owner?.login === 'unrelated' ? 422 : 502); assert.equal(await f.storage.get('github-app'), undefined);
  }
});
test('the environment credential fallback closes manifest setup', async () => {
  const f = await setupFixture(); f.env.GITHUB_APP_ID = '123';
  assert.equal((await f.call('/setup?token=' + token)).status, 409); assert.equal(f.requests.length, 0);
});

test('GET previews and cross-origin POSTs never consume a setup token', async () => {
  const f = await setupFixture();
  for (let i = 0; i < 3; i++) {
    const response = await f.call('/setup?token=' + token); const html = await response.text();
    assert.equal(response.status, 200); assert.equal(response.headers.get('Set-Cookie'), null);
    assert.match(html, /Make sure you're signed in to GitHub/); assert.match(html, /method="post"/); assert.ok(!html.includes('.submit()'));
  }
  for (const headers of [{ Origin: 'https://preview.test' }]) {
    const response = await f.controller.fetch(new Request(origin + '/setup', { method: 'POST', headers, body: new URLSearchParams({ token }) }));
    assert.equal(response.status, 403);
  }
  assert.equal(f.storage.data.size, 0); assert.equal(f.requests.length, 0); assert.equal((await f.post()).status, 200);
});
for (const [browser, headers] of [['no Origin or Referer', {}], ['opaque Origin and no Referer', { Origin: 'null' }]]) {
  test(`browser setup with ${browser} consumes one token and completes its bound callback`, async () => {
    const f = await setupFixture();
    const submit = value => f.controller.fetch(new Request(origin + '/setup', {
      method: 'POST', headers, body: new URLSearchParams({ token: value }),
    }));
    const preview = await f.call('/setup?token=' + token);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get('Referrer-Policy'), 'no-referrer');
    assert.equal(f.storage.data.size, 0);
    assert.equal((await submit('invalid-token')).status, 401);
    assert.equal(f.storage.data.size, 0);
    const response = await submit(token);
    assert.equal(response.status, 200);
    const cookie = response.headers.get('Set-Cookie').split(';')[0];
    const flow = { cookie, state: cookie.split('=')[1] };
    assert.equal((await submit(token)).status, 409);
    assert.equal((await f.callback(flow, { cookie: '' })).status, 401);
    assert.equal((await f.callback(flow, { state: 'b'.repeat(64) })).status, 401);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.callback(flow)).status, 303);
    assert.equal((await f.callback(flow)).status, 409);
    assert.equal(f.requests.length, 1);
  });
}
test('definite GitHub conversion rejection permits a fresh token immediately', async () => {
  const f = await setupFixture(); const flow = await f.begin(); f.setConvert(async () => Response.json({}, { status: 422 }));
  assert.equal((await f.callback(flow)).status, 502); assert.equal((await f.storage.get('setup-flow')).phase, 'rejected');
  assert.deepEqual(f.alerts, ['alert_setup_rejected']);
  const replacement = 'replacement-setup-token-of-32-characters';
  f.env.SETUP_BOOTSTRAP = JSON.stringify({ tokenHash: await hash(replacement), expiresAt: f.now() + 30 * 60_000 });
  assert.equal((await f.controller.fetch(new Request(origin + '/setup', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ token: replacement }) }))).status, 200);
  assert.equal((await f.callback(flow)).status, 409);
});
test('control reset requires disabled starts, preserves used tokens, and cannot replace an existing App', async () => {
  const f = await setupFixture(); const control = 'fake-control-reset-token-of-32-characters';
  const config = JSON.parse(f.env.SETUP_BOOTSTRAP); config.controlHash = await hash(control); f.env.SETUP_BOOTSTRAP = JSON.stringify(config);
  const reset = () => f.controller.fetch(new Request(origin + '/setup/reset', { method: 'POST', headers: { Authorization: 'Bearer ' + control } }));
  const flow = await f.begin(); f.setConvert(async () => { throw new Error('uncertain conversion'); });
  assert.equal((await f.callback(flow)).status, 502); assert.equal((await reset()).status, 409);
  f.clock.time += 60_001; f.env.ENABLED = 'true'; assert.equal((await reset()).status, 409); f.env.ENABLED = 'false';
  assert.equal((await reset()).status, 204); assert.equal((await f.post()).status, 409);
  assert.equal((await f.callback(flow)).status, 409); assert.ok(f.alerts.includes('alert_setup_reset'));
  await f.storage.put('github-app', { id: '123', slug: 'configured' }); assert.equal((await reset()).status, 409);
  assert.equal((await f.storage.get('github-app')).id, '123');
});
test('a late conversion cannot overwrite a control reset and a newer browser flow', async () => {
  const f = await setupFixture(); const control = 'fake-late-conversion-control-32-characters';
  const config = JSON.parse(f.env.SETUP_BOOTSTRAP); config.controlHash = await hash(control); f.env.SETUP_BOOTSTRAP = JSON.stringify(config);
  let entered; let resolve;
  const inFlight = new Promise(r => { entered = r; });
  f.setConvert(() => { entered(); return new Promise(r => { resolve = r; }); });
  const original = await f.begin(); const pending = f.callback(original); await inFlight;
  f.clock.time += 60_001;
  assert.equal((await f.controller.fetch(new Request(origin + '/setup/reset', { method: 'POST', headers: { Authorization: 'Bearer ' + control } }))).status, 204);
  const replacement = 'replacement-late-flow-token-32-characters'; config.tokenHash = await hash(replacement); f.env.SETUP_BOOTSTRAP = JSON.stringify(config);
  const next = await f.controller.fetch(new Request(origin + '/setup', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ token: replacement }) }));
  assert.equal(next.status, 200); const cookie = next.headers.get('Set-Cookie').split(';')[0];
  resolve(Response.json(f.app)); assert.equal((await pending).status, 409);
  assert.equal(await f.storage.get('github-app'), undefined); assert.equal((await f.storage.get('setup-flow')).phase, 'started');
  f.setConvert(async () => Response.json(f.app));
  assert.equal((await f.callback({ cookie, state: cookie.split('=')[1] })).status, 303);
  assert.ok(f.alerts.includes('alert_setup_interrupted'));
});
