import test from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.mjs';
import { hash } from '../src/setup.mjs';
import { Storage } from './helpers.mjs';

async function fixture() {
  const storage = new Storage(), control = 'c'.repeat(40);
  const env = { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a,project-b', SETUP_BOOTSTRAP: JSON.stringify({ controlHash: await hash(control) }) };
  const headers = { Authorization: `Bearer ${control}` };
  const fleet = new Fleet({ storage }, env);
  const call = (path, method = 'GET') => fleet.fetch(new Request(`https://fleet${path}`, { method, headers }));
  return { storage, env, call };
}

test('off events survive off-on transitions and revision protects newer manual changes', async () => {
  const { storage, env, call } = await fixture(), base = '/router/reuse?project=project-a';
  const initial = await (await call(base)).json();
  assert.equal(initial.revision, 0); assert.deepEqual(initial.offEvents, []);
  const nonce = 'a'.repeat(32);
  const off = await (await call(`${base}&mode=off&caller_nonce=${nonce}`, 'POST')).json();
  assert.equal(off.revision, 1); assert.equal(off.offEvents[0].callerNonce, nonce); assert.equal(off.offEvents[0].source, 'control');
  assert.equal((await call(`${base}&mode=config&if_revision=1`, 'POST')).status, 200);
  const later = await (await call(`${base}&mode=off`, 'POST')).json();
  assert.equal(later.revision, 3); assert.equal(later.offEvents.length, 2);
  assert.equal((await call(`${base}&mode=config&if_revision=1`, 'POST')).status, 412);
  const restored = new Fleet({ storage }, env), headers = { Authorization: `Bearer ${'c'.repeat(40)}` };
  const saved = await (await restored.fetch(new Request(`https://fleet${base}`, { headers }))).json();
  assert.equal(saved.override, 'off'); assert.equal(saved.revision, 3); assert.equal(saved.offEvents[0].callerNonce, nonce);
  assert.equal(saved.offEvents[1].revision, 3);
});

test('nonce and conditional revision are strictly validated and project scoped', async () => {
  const { call } = await fixture(), base = '/router/reuse?project=project-a';
  for (const query of ['mode=off&caller_nonce=abc', `mode=config&caller_nonce=${'a'.repeat(32)}`, 'mode=off&if_revision=0', 'mode=config&if_revision=-1', 'mode=config&if_revision=01', 'mode=config&if_revision=9007199254740992']) {
    assert.equal((await call(`${base}&${query}`, 'POST')).status, 400, query);
  }
  await call(`${base}&mode=off`, 'POST');
  const other = await (await call('/router/reuse?project=project-b')).json();
  assert.equal(other.revision, 0); assert.deepEqual(other.offEvents, []);
});

test('pool-mode off writes create project events and invalidate prior revisions', async () => {
  const { call } = await fixture();
  assert.equal((await call('/router/pool-mode?mode=on', 'POST')).status, 202);
  for (const project of ['project-a', 'project-b']) {
    const base = `/router/reuse?project=${project}`, value = await (await call(base)).json();
    assert.equal(value.override, 'off'); assert.equal(value.revision, 1);
    assert.deepEqual(value.offEvents.map(({ revision, source }) => ({ revision, source })), [{ revision: 1, source: 'pool_mode' }]);
    assert.equal((await call(`${base}&mode=config&if_revision=0`, 'POST')).status, 412);
  }
});

test('off-event retention is bounded and exposes the last discarded revision', async () => {
  const { call } = await fixture(), base = '/router/reuse?project=project-a';
  for (let i = 0; i < 258; i++) assert.equal((await call(`${base}&mode=off`, 'POST')).status, 200);
  const value = await (await call(base)).json();
  assert.equal(value.revision, 258); assert.equal(value.offEvents.length, 256);
  assert.equal(value.offEventFloor, 2); assert.equal(value.offEvents[0].revision, 3);
});

test('lost off response and off-on-before-poll remain visible; manual off defeats stale recovery', async () => {
  const { call } = await fixture(), base = '/router/reuse?project=project-a', nonce = 'b'.repeat(32);
  await call(`${base}&mode=off&caller_nonce=${nonce}`, 'POST'); // Simulate a response lost after the write.
  await call(`${base}&mode=config`, 'POST');
  let observed = await (await call(base)).json();
  assert.equal(observed.override, 'config');
  assert.equal(observed.offEvents[0].callerNonce, nonce);
  assert.equal(observed.offEvents[0].revision, 1);
  await call(`${base}&mode=off`, 'POST'); // Another controller's later explicit off.
  assert.equal((await call(`${base}&mode=config&if_revision=1`, 'POST')).status, 412);
  observed = await (await call(base)).json();
  assert.equal(observed.override, 'off');
  assert.deepEqual(observed.offEvents.map(event => event.revision), [1, 3]);
});
