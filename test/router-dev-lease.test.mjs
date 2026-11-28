import test from 'node:test';
import assert from 'node:assert/strict';
import { Fleet } from '../src/fleet.mjs';
import { hash } from '../src/setup.mjs';
import { fixture } from './helpers.mjs';

const TOKEN = 'a'.repeat(40);
const ID = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';

function rollingName(manifestSha256) {
  const value = BigInt(`0x${manifestSha256}`) << 4n;
  let encoded = '';
  for (let index = 51; index >= 0; index--) encoded += alphabet[Number((value >> BigInt(index * 5)) & 31n)];
  return `peek-ci-${encoded}`;
}

function devHostname(id) { return `peek-dev-${id.slice(0, 8)}`; }

async function setup({ tailnet = true, oauth = true } = {}) {
  const f = fixture();
  const tokenHash = await hash(TOKEN);
  const network = { mode: 'allow', inbound: 'boat-only', allow: ['registry.npmjs.org', 'crates.io', 'pypi.org', '*.tailscale.com', 'controlplane.tailscale.com'] };
  const clients = {
    'peek-runs': { enabled: true, project: 'project-a', maxActive: 5, startsPerDay: 60, ttlSeconds: 1800, warmReuse: false, network, tokenHash },
    'peek-dev': { enabled: true, project: 'project-a', maxActive: 1, startsPerDay: 60, ttlSeconds: 1800, rollingSnapshot: true, warmReuse: false, tailnet, devMaxActive: 1, network, tokenHash },
  };
  const env = { ...f.env, PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify(clients), ...(oauth ? { TAILSCALE_OAUTH_CLIENT_ID: 'fake-client-id', TAILSCALE_OAUTH_CLIENT_SECRET: 'fake-client-secret' } : {}) };
  const fleet = new Fleet({ storage: f.storage, waitUntil() {} }, env, undefined, f.fetcher);
  fleet.external.logger = line => f.logs.push(line);
  const send = (client, action, body = {}) => fleet.fetch(new Request(`https://fleet/router/lease/${action}`, { method: 'POST', headers: { 'X-Boat-CI-Enabled': 'true', 'X-Lease-Client': client, Authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(body) }));
  return { f, fake: f.fake, storage: f.storage, fleet, env, send };
}

async function seedProject(storage) {
  await storage.put('project:project-a:pool:mode', 'on');
  await storage.put('project:project-a:pool:snapshot', { complete: true, at: Date.now(), runners: [] });
}

function seedRolling(fake) {
  const digest = '0'.repeat(64), name = rollingName(digest);
  fake.rollingSnapshots = [{ name, status: 'ready', snapshotId: fake.rollingSnapshotId }];
  return { digest, name };
}

function activeDevLease(storage, fake, { keyId = 'key-1', key = 'tskey-auth-fake-seeded', deviceId = 'device-1' } = {}) {
  const hostname = devHostname(ID), machineId = 'bx_23456789';
  fake.tailnet.keys = [{ id: keyId, key, body: {}, path: '' }];
  fake.tailnet.devices = [{ id: deviceId, hostname }];
  return Promise.all([
    storage.put(`external-lease:peek-dev:${ID}`, { id: ID, client: 'peek-dev', project: 'project-a', state: 'active', machineId, size: 'default', pool: '["a/b","boat-default"]', expiresAt: Date.now() + 600_000, dev: true, tailnet: { hostname }, devKey: { id: keyId, key } }),
    storage.put(`project:project-a:box:${machineId}`, { machineId, state: 'leased', leaseId: ID, leaseClient: 'peek-dev', size: 'default', pool: '["a/b","boat-default"]' }),
  ]).then(() => ({ hostname, machineId }));
}

function boatCreates(fake) {
  return fake.requests.filter(item => item.host === 'boat.dev' && item.path.endsWith('/sandboxes') && item.method === 'POST');
}

test('dev preflight names the missing client flag and environment without leasing', async () => {
  const t = await setup({ tailnet: false, oauth: false });
  const response = await t.send('peek-dev', 'dev-preflight');
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.deepEqual(body.missing, ['client_not_tailnet_enabled', 'TAILSCALE_OAUTH_CLIENT_ID', 'TAILSCALE_OAUTH_CLIENT_SECRET']);
  assert.equal(t.fake.tailnet.tokens, 0);
  assert.equal(t.fake.tailnet.keys.length, 0);
  assert.equal((await t.storage.list({ prefix: 'external-lease:' })).size, 0);
});

test('dev preflight reports an OAuth failure without the secret or a lease', async () => {
  const t = await setup();
  t.fake.tailnet.failures.oauth = 1;
  const response = await t.send('peek-dev', 'dev-preflight');
  const text = await response.text();
  assert.equal(response.status, 200);
  const body = JSON.parse(text);
  assert.equal(body.ok, false);
  assert.deepEqual(body.missing, ['tailscale_oauth']);
  assert.match(body.detail, /^tailscale HTTP 401$/);
  assert.equal(text.includes('fake-client-secret'), false);
  assert.equal(t.fake.tailnet.keys.length, 0);
  assert.equal((await t.storage.list({ prefix: 'external-lease:' })).size, 0);
});

test('dev preflight proves the OAuth exchange and creates no key or lease', async () => {
  const t = await setup();
  const response = await t.send('peek-dev', 'dev-preflight');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(t.fake.tailnet.tokens, 1);
  assert.equal(t.fake.tailnet.keys.length, 0);
  assert.equal(t.fake.requests.filter(item => item.host === 'api.tailscale.com').length, 1);
  assert.equal((await t.storage.list({ prefix: 'external-lease:' })).size, 0);
});

test('a client without tailnet access cannot claim a dev lease', async () => {
  const t = await setup({ tailnet: false });
  const response = await t.send('peek-dev', 'claim', { id: ID, dev: true });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { reason: 'tailnet_not_allowed' });
  assert.equal(t.fake.tailnet.tokens, 0);
  assert.equal((await t.storage.list({ prefix: 'external-lease:' })).size, 0);
});

test('one open dev lease refuses a second one without minting a key', async () => {
  const t = await setup();
  const { hostname } = await activeDevLease(t.storage, t.fake);
  const response = await t.send('peek-dev', 'claim', { id: OTHER, dev: true });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.reason, 'dev_lease_active');
  assert.equal(body.detail.leaseId, ID);
  assert.equal(body.detail.hostname, hostname);
  assert.equal(await t.storage.get(`external-lease:peek-dev:${OTHER}`), undefined);
  assert.equal(t.fake.tailnet.tokens, 0);
  assert.equal(t.fake.tailnet.keys.length, 1);
});

test('a dev claim mints one key into the create environment and never answers or scripts it', async () => {
  const t = await setup();
  await seedProject(t.storage);
  const { name } = seedRolling(t.fake);
  const first = await t.send('peek-dev', 'claim', { id: ID, dev: true });
  assert.equal(first.status, 202);
  let lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.dev, true);
  assert.equal(lease.tailnet.hostname, devHostname(ID));
  assert.ok(['reserved', 'waiting'].includes(lease.state));

  await t.fleet.external.admitStart({ at: lease.createdAt, rank: `external:peek-dev:${ID}`, lease });
  lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.state, 'booting');
  assert.equal(t.fake.tailnet.keys.length, 1);
  const key = t.fake.tailnet.keys[0].key;
  const [create] = boatCreates(t.fake);
  assert.deepEqual(Object.keys(create.body.env).sort(), ['PEEK_DEV_HOSTNAME', 'TAILSCALE_AUTHKEY']);
  assert.equal(create.body.env.TAILSCALE_AUTHKEY, key);
  assert.equal(create.body.env.PEEK_DEV_HOSTNAME, devHostname(ID));
  assert.equal(create.body.noEnv, true);
  assert.equal(create.body.from, name);
  assert.match(create.body.setupScript, /phase snapshot_tailnet/);
  assert.equal(create.body.setupScript.includes(key), false);

  await t.fleet.external.admitStart({ at: lease.createdAt, rank: `external:peek-dev:${ID}`, lease });
  lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.state, 'active');
  assert.equal(lease.devKey.id, t.fake.tailnet.keys[0].id);
  assert.equal(lease.devKey.key, undefined);
  assert.equal(JSON.stringify(lease).includes(key), false);

  const response = await t.send('peek-dev', 'claim', { id: ID, dev: true });
  assert.equal(response.status, 200);
  const text = await response.text();
  const body = JSON.parse(text);
  assert.deepEqual(body.tailnet, { hostname: devHostname(ID) });
  assert.equal(text.includes(key), false);
});

test('a provider retry reuses the key the lease already minted', async () => {
  const t = await setup();
  await seedProject(t.storage);
  seedRolling(t.fake);
  await t.send('peek-dev', 'claim', { id: ID, dev: true });
  let lease = await t.storage.get(`external-lease:peek-dev:${ID}`);

  let calls = 0;
  const attempts = [];
  const create = t.fleet.external.api.create.bind(t.fleet.external.api);
  t.fleet.external.api.create = async (...args) => {
    calls++;
    attempts.push(args[0]);
    if (calls === 1) {
      const error = new Error('no ready machine');
      Object.assign(error, { service: 'boat', status: 503, code: 'no_ready_machine' });
      throw error;
    }
    return create(...args);
  };

  await t.fleet.external.admitStart({ at: lease.createdAt, rank: `external:peek-dev:${ID}`, lease });
  lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.state, 'waiting');
  assert.equal(typeof lease.devKey.key, 'string');
  assert.equal(t.fake.tailnet.keys.length, 1);

  await t.fleet.external.admitStart({ at: lease.createdAt, rank: `external:peek-dev:${ID}`, lease });
  lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.state, 'booting');
  assert.equal(calls, 2);
  assert.equal(t.fake.tailnet.keys.length, 1);
  assert.equal(t.fake.tailnet.tokens, 1);
  const creates = boatCreates(t.fake);
  assert.equal(creates.length, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].devEnv.TAILSCALE_AUTHKEY, attempts[1].devEnv.TAILSCALE_AUTHKEY);
  assert.equal(creates[0].body.env.TAILSCALE_AUTHKEY, attempts[0].devEnv.TAILSCALE_AUTHKEY);
});

test('release deletes the device, revokes the key and keeps the key out of every request and log', async () => {
  const t = await setup();
  const { hostname } = await activeDevLease(t.storage, t.fake);
  const key = 'tskey-auth-fake-seeded';

  const response = await t.send('peek-dev', 'release', { id: ID });
  assert.equal(response.status, 204);
  assert.equal((await response.text()).includes(key), false);
  assert.deepEqual(t.fake.tailnet.deletes, ['device-1']);
  assert.deepEqual(t.fake.tailnet.revokes, ['key-1']);
  assert.deepEqual(t.fake.tailnet.devices, []);
  assert.equal(t.fake.tailnet.keys.length, 0);
  assert.equal(JSON.stringify(t.fake.requests).includes(key), false);
  assert.equal(t.f.logs.join('\n').includes(key), false);

  const lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.tailnetCleaned, true);
  assert.equal(lease.devKey.key, undefined);
  assert.equal(lease.devKey.id, 'key-1');
  assert.equal(JSON.stringify(lease).includes(key), false);
  assert.equal(await t.storage.get(`dev-cleanup:peek-dev:${ID}`), undefined);
  assert.equal(hostname, devHostname(ID));
});

test('a failed cleanup stays durable, logs, and a fresh router finishes it after a restart', async () => {
  const t = await setup();
  await activeDevLease(t.storage, t.fake);
  t.fake.tailnet.failures.devices = 1;

  const response = await t.send('peek-dev', 'release', { id: ID });
  assert.equal(response.status, 204);
  const record = await t.storage.get(`dev-cleanup:peek-dev:${ID}`);
  assert.equal(record.attempts, 1);
  assert.equal(record.hostname, devHostname(ID));
  assert.equal(record.keyId, 'key-1');
  assert.ok(record.nextAt > Date.now());
  assert.deepEqual(t.fake.tailnet.devices.map(item => item.hostname), [devHostname(ID)]);
  assert.deepEqual(t.fake.tailnet.revokes, [], 'a failed device list must not skip the retry record');
  assert.ok(t.f.logs.some(line => line.includes('dev_tailnet_cleanup_failed')));
  assert.equal(t.f.logs.join('\n').includes('tskey-auth'), false);

  await t.storage.put(`dev-cleanup:peek-dev:${ID}`, { ...record, nextAt: 0 });
  const restarted = new Fleet({ storage: t.storage, waitUntil() {} }, t.env, undefined, t.f.fetcher);
  restarted.external.logger = line => t.f.logs.push(line);
  await restarted.external.sweep();

  assert.deepEqual(t.fake.tailnet.devices, []);
  assert.deepEqual(t.fake.tailnet.deletes, ['device-1']);
  assert.deepEqual(t.fake.tailnet.revokes, ['key-1']);
  assert.equal(await t.storage.get(`dev-cleanup:peek-dev:${ID}`), undefined);
  const lease = await t.storage.get(`external-lease:peek-dev:${ID}`);
  assert.equal(lease.tailnetCleaned, true);
});

test('an ordinary lease never asks for a key and keeps an empty create environment', async () => {
  const t = await setup();
  await seedProject(t.storage);
  const first = await t.send('peek-runs', 'claim', { id: ID });
  assert.equal(first.status, 202);
  const lease = await t.storage.get(`external-lease:peek-runs:${ID}`);
  assert.equal(lease.dev, undefined);
  await t.fleet.external.admitStart({ at: lease.createdAt, rank: `external:peek-runs:${ID}`, lease });
  const [create] = boatCreates(t.fake);
  assert.deepEqual(create.body.env ?? {}, {});
  assert.equal(create.body.noEnv, true);
  assert.equal(t.fake.tailnet.tokens, 0);
  assert.equal(t.fake.tailnet.keys.length, 0);
  assert.equal(t.fake.requests.filter(item => item.host === 'api.tailscale.com').length, 0);
});
