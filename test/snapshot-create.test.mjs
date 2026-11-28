import test from 'node:test';
import assert from 'node:assert/strict';
import { APIs } from '../src/apis.mjs';

const snapshot = { name: 'project-ci-20261109-1234abcd', manifestSha256: 'a'.repeat(64) };
const job = { createKey: 'create-key', size: 'large', routerCreateName: 'boat-router-' + 'a'.repeat(32) };

test('a snapshot create keeps the no-environment boundary and uses the saved identity', async () => {
  let request;
  const api = new APIs({}, async (url, options) => { request = { url, options, body: JSON.parse(options.body) }; return Response.json({ sandbox: { id: 'bx_23456789' } }); });
  await api.create({ ...job, routerReusable: true, routerSnapshot: snapshot }, 3600);
  assert.equal(request.body.from, snapshot.name);
  assert.equal(request.body.noEnv, true);
  assert.deepEqual(request.body.env, {});
  assert.equal(request.options.headers['Idempotency-Key'], job.createKey);
  assert.match(request.body.setupScript, /snapshot_verify/);
  assert.match(request.body.setupScript, /--pull=never --network=none/);
  assert.doesNotMatch(request.body.setupScript, /apt-get|curl |docker pull/);
});

test('a plain create keeps the existing bootstrap path', async () => {
  let body;
  const api = new APIs({}, async (_url, options) => { body = JSON.parse(options.body); return Response.json({}); });
  await api.create(job, 3600);
  assert.equal(body.from, undefined);
  assert.match(body.setupScript, /apt-get/);
});

test('invalid or incompatible snapshot input cannot send a create request', async () => {
  let calls = 0;
  const api = new APIs({}, async () => { calls++; return Response.json({}); });
  for (const changes of [
    { routerSnapshot: { ...snapshot, name: 'other' } },
    { routerSnapshot: { ...snapshot, manifestSha256: 'invalid' } },
    { routerSnapshot: snapshot, routerResetMode: 'docker' },
    { routerSnapshot: snapshot, routerDockerAccess: true },
  ]) assert.throws(() => api.create({ ...job, ...changes }, 3600), error => error.code === 'request_not_sent');
  assert.equal(calls, 0);
});

test('Boat missing snapshot response reaches fleet as the confirmed fallback error', async () => {
  for (const body of [{ code: 'snapshot_not_found' }, { error: 'snapshot_not_found' }]) {
    const api = new APIs({}, async () => Response.json(body, { status: 404 }));
    await assert.rejects(api.create({ ...job, routerSnapshot: snapshot }, 3600), error =>
      error.service === 'boat' && error.status === 404 && error.code === 'snapshot_not_found');
  }
});

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
function rollingName(manifestSha256) {
  const value = BigInt(`0x${manifestSha256}`) << 4n;
  let encoded = '';
  for (let index = 51; index >= 0; index--) encoded += alphabet[Number((value >> BigInt(index * 5)) & 31n)];
  return `peek-ci-${encoded}`;
}

test('a peek-runs create keeps no environment and carries its registry network', async () => {
  let body;
  const api = new APIs({}, async (_url, options) => { body = JSON.parse(options.body); return Response.json({ sandbox: { id: 'bx_23456789' } }); });
  const manifestSha256 = 'f'.repeat(64);
  const network = { mode: 'allow', inbound: 'boat-only', allow: ['registry.npmjs.org', '*.npmjs.org', 'crates.io', '*.crates.io', 'static.rust-lang.org', '*.rust-lang.org', 'pypi.org', 'files.pythonhosted.org'] };
  await api.create({ ...job, routerReusable: true, noTailnet: true, network, routerSnapshot: { kind: 'peek-ci', name: rollingName(manifestSha256), snapshotId: 'rolling-snapshot-id', manifestSha256 } }, 1800);
  assert.equal(body.noEnv, true);
  assert.deepEqual(body.env ?? {}, {});
  assert.deepEqual(body.network, network);
  assert.equal(Object.keys(body).includes('noTailnet'), false, 'the tailnet check lives in the setup script');
  assert.equal(Object.keys(body).some(key => /secret|token|tailnet/i.test(key)), false);
  assert.equal(Object.keys(body.env ?? {}).length, 0);
  assert.match(body.setupScript, /phase snapshot_tailnet/);
  assert.match(body.setupScript, /test ! -e \/var\/lib\/tailscale\/tailscaled\.state/);
  assert.match(body.setupScript, /pgrep -x tailscaled/);
});
