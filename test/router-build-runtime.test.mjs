import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, Log, LogLevel } from 'miniflare';
import { hash } from '../src/setup.mjs';

test('build stamps and disabled-only restart work in the Workers runtime', async () => {
  const commit = 'a'.repeat(40), token = 'fake-build-test-control-32-characters';
  const bundle = await build({ entryPoints: ['src/worker.mjs'], bundle: true, write: false, format: 'esm', platform: 'node', external: ['node:*'], define: { __ROUTER_BUILD_COMMIT__: JSON.stringify(commit) }, logLevel: 'silent' });
  const options = { modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-07-30', compatibilityFlags: ['nodejs_compat'], durableObjects: { FLEET: { className: 'Fleet', useSQLite: true } }, bindings: { ENABLED: 'true', PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'test-wallet', ROUTER_PROJECTS: 'project-a', SETUP_BOOTSTRAP: JSON.stringify({ controlHash: await hash(token) }) }, log: new Log(LogLevel.ERROR), outboundService: async () => new Response(null, { status: 503 }) };
  const mf = new Miniflare(options), auth = { Authorization: 'Bearer ' + token };
  try {
    assert.equal((await mf.dispatchFetch('https://router.test/router/build')).status, 401);
    let response = await mf.dispatchFetch('https://router.test/router/build', { headers: auth });
    assert.deepEqual(await response.json(), { worker_commit: commit, do_commit: commit });
    assert.equal((await mf.dispatchFetch('https://router.test/router/restart', { method: 'POST' })).status, 401);
    assert.equal((await mf.dispatchFetch('https://router.test/router/restart', { method: 'POST', headers: auth })).status, 409);
    await mf.setOptions({ ...options, bindings: { ...options.bindings, ENABLED: 'false' } });
    response = await mf.dispatchFetch('https://router.test/router/restart', { method: 'POST', headers: auth });
    assert.equal(response.status, 500);
    response = await mf.dispatchFetch('https://router.test/router/build', { headers: auth });
    assert.deepEqual(await response.json(), { worker_commit: commit, do_commit: commit });
  } finally { await mf.dispose(); }
});

test('the Worker reports the Durable Object stamp without replacing it', async () => {
  const { default: worker } = await import('../src/worker.mjs');
  const env = { ENABLED: 'false', FLEET: { idFromName: () => 'id', get: () => ({ fetch: async () => Response.json({ do_commit: 'old-object-commit' }) }) } };
  const response = await worker.fetch(new Request('https://router.test/router/build'), env);
  assert.deepEqual(await response.json(), { worker_commit: 'unbuilt', do_commit: 'old-object-commit' });
});
