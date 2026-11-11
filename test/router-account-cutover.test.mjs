import test from 'node:test';
import assert from 'node:assert/strict';
import { accountApi, cutoverBudget, externalCutoverLedger, tagCutoverRecords } from '../src/router/account-cutover.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { Storage } from './helpers.mjs';
import { APIs } from '../src/apis.mjs';
import { installRouter } from '../src/router/install.mjs';

test('box lifecycle calls follow persisted account and creates follow their own account', async () => {
  const storage = new Storage(), calls = [];
  const methods = ['sandbox', 'setupDiagnostics', 'configure', 'start', 'refresh', 'refreshResult', 'lightReset', 'lightResetResult', 'jitProbe', 'removeRunner', 'destroy', 'deletion'];
  const service = account => Object.fromEntries([...methods, 'create', 'findCreated', 'limits', 'listSandboxes'].map(name => [name, async () => { calls.push([account, name]); }]));
  const secondary = service('secondary'), primary = service('primary');
  const api = accountApi(storage, secondary, primary);
  await storage.put('box:old', { machineId: 'old' });
  await storage.put('box:new', { machineId: 'new', account: 'primary' });
  for (const name of methods) {
    await api[name]({ machineId: 'old' });
    await api[name]({ machineId: 'new' });
  }
  await api.create({ account: 'primary', createKey: 'new' });
  await api.findCreated({ account: 'secondary', createKey: 'old' });
  await api.limits();
  assert.equal(await api.forIdentity({ machineId: 'old' }), secondary);
  assert.equal(await api.forIdentity({ machineId: 'new' }), primary);
  assert.deepEqual(calls.map(c => c[0]), methods.flatMap(() => ['secondary', 'primary']).concat(['primary', 'secondary', 'primary']));
});

test('the cutover installs work limits and keeps legacy boxes on secondary credentials', async () => {
  const storage = new Storage(), requests = [];
  const env = { BOAT_WALLET: 'example-account', ACCOUNT_CUTOVER: 'true', ACCOUNT_CUTOVER_POLICY: JSON.stringify({ ledgerKey: 'account:ledger:example-account', projectAccounts: ['project-a', 'project-b', 'project-c'], dayReserve: 150, maxOwnedStartsPerDay: 150, forbidPaidStarts: true, poolPacing: { enabled: true, mode: 'dynamic', hardDayReserve: 150, floorStartsPerHour: 10 } }), BOAT_PROVIDER_WALLET: 'work-wallet', BOAT_SECONDARY_PROVIDER_WALLET: 'secondary-wallet', BOAT_CI_API_KEY: 'secondary-key', BOAT_WORK_API_KEY: 'work-key', ROUTER_PROJECTS: 'project-a,project-b,project-c' };
  const api = new APIs(env, async (url, options) => { requests.push({ url, headers: options.headers }); return new Response(JSON.stringify({ canStart: true, starts: { day: { limit: 600, used: 6, remaining: 594 } } })); });
  const router = installRouter(storage, () => env, { SuiteController: class {}, api, suiteApi: {}, now: () => 1000 });
  assert.equal(router.ledger.key, 'account:ledger:example-account');
  assert.equal(router.account.poolPacing.floorStartsPerHour, 10);
  assert.equal(router.account.poolPacing.hardDayReserve, 150);
  await router.accountLimits();
  assert.equal(requests[0].headers.Authorization, 'Bearer work-key');
  assert.equal(requests[0].headers['X-Boat-Org'], 'work-wallet');
  await storage.put('project:project-a:box:old', { machineId: 'old' });
  const oldApi = await router.externalApi.forIdentity({ machineId: 'old' });
  assert.equal(oldApi.env.BOAT_PROVIDER_WALLET, 'secondary-wallet');
  assert.equal(oldApi.env.BOAT_CI_API_KEY, 'secondary-key');
});

test('lease has an independent primary daily budget without raising the secondary budget', () => {
  const storage = new Storage();
  const client = { enabled: true, project: 'project-a', maxActive: 24, startsPerDay: 60, ttlSeconds: 900, tokenHash: 'a'.repeat(64) };
  const env = { BOAT_WALLET: 'example-account', ACCOUNT_CUTOVER: 'true', ACCOUNT_CUTOVER_POLICY: JSON.stringify({ ledgerKey: 'account:ledger:example-account', dayReserve: 150, maxOwnedStartsPerDay: 450, forbidPaidStarts: true, poolPacing: { enabled: true, mode: 'dynamic', hardDayReserve: 150 } }), ACCOUNT_POOL_POLICY: JSON.stringify({ accounts: { secondary: { enabled: true }, primary: { enabled: true } } }), BOAT_PROVIDER_WALLET: 'work-wallet', BOAT_SECONDARY_PROVIDER_WALLET: 'secondary-wallet', BOAT_WORK_API_KEY: 'work-key', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify({ lease: client }), EXTERNAL_LEASE_POLICY: JSON.stringify({ lease: { primaryStartsPerDay: 120 } }) };
  const api = new APIs(env, async () => new Response('{}'));
  const router = installRouter(storage, () => env, { SuiteController: class {}, api, suiteApi: {} });
  assert.equal(router.accountPools.secondary.ledger.policy.externalClients.lease.startsPerDay, 60);
  assert.equal(router.accountPools.primary.ledger.policy.externalClients.lease.startsPerDay, 120);
  assert.equal(router.account.dayReserve, 150);
  assert.equal(router.account.poolPacing.hardDayReserve, 150);
});

test('external lease reconciliation follows the ledger that owns its claim', async () => {
  const storage = new Storage(), now = () => 1000;
  const old = new AccountLedger(storage, { ledgerKey: 'old' }, now), work = new AccountLedger(storage, { ledgerKey: 'new' }, now);
  const ledger = externalCutoverLedger(old, work);
  await storage.put('old', { claims: { earlier: { project: 'project-a', status: 'unknown', at: 900 } }, waiting: [] });
  assert.equal((await ledger.claim('earlier')).status, 'unknown');
  await ledger.resolve('earlier', 'created');
  assert.equal((await old.claim('earlier')).status, 'created');
  assert.equal(await work.claim('earlier'), null);
});

test('cutover tags existing boxes and preserves uncertain secondary creates', async () => {
  const storage = new Storage(), now = () => 1000;
  const old = new AccountLedger(storage, { ledgerKey: 'old' }, now), work = new AccountLedger(storage, { ledgerKey: 'new' }, now);
  const budget = cutoverBudget(storage, old, work, 'project-a', now);
  await storage.put('box:old', { machineId: 'old' });
  await storage.put('create:pending', { createKey: 'pending', state: 'pending' });
  await storage.put('create:calling', { createKey: 'calling', state: 'calling' });
  const hash = await budget.claimKey('calling');
  const pendingHash = await budget.claimKey('pending');
  await storage.put('old', { claims: { [hash]: { project: 'project-a', status: 'unknown', at: 900 }, [pendingHash]: { project: 'project-a', status: 'pending', at: 900 } }, waiting: [{ project: 'project-a', key: pendingHash }], dynamicPacing: { floorStarts: [{ key: pendingHash, at: 900 }] } });
  await tagCutoverRecords(storage, budget);
  assert.equal((await storage.get('box:old')).account, 'secondary');
  assert.equal((await storage.get('create:pending')).account, 'primary');
  assert.equal((await storage.get('create:calling')).account, 'secondary');
  assert.equal((await budget.claim('calling')).status, 'unknown');
  assert.equal(await budget.claim('pending'), null);
  assert.equal(await old.claim(pendingHash), null);
  assert.deepEqual((await storage.get('old')).waiting, []);
});

test('open queue removes project and lease quotas without disabling account guards', () => {
  const storage = new Storage();
  const client = { enabled: true, project: 'project-a', maxActive: 24, startsPerDay: 60, concurrencyReserve: 10, ttlSeconds: 900, tokenHash: 'a'.repeat(64) };
  const env = { BOAT_WALLET: 'example-account', ACCOUNT_CUTOVER: 'true', ACCOUNT_CUTOVER_POLICY: JSON.stringify({ ledgerKey: 'account:ledger:example-account', openStartQueue: true, projectAccounts: ['project-a', 'project-b', 'project-c'], dayReserve: 0, forbidPaidStarts: true, poolPacing: { enabled: true, mode: 'dynamic', hardDayReserve: 0 } }), BOAT_PROVIDER_WALLET: 'work-wallet', BOAT_SECONDARY_PROVIDER_WALLET: 'secondary-wallet', BOAT_WORK_API_KEY: 'work-key', ROUTER_PROJECTS: 'project-a', EXTERNAL_LEASE_CLIENTS: JSON.stringify({ lease: client }), EXTERNAL_LEASE_POLICY: JSON.stringify({ lease: { maxActive: null, startsPerDay: null, concurrencyReserve: 0 } }) };
  const router = installRouter(storage, () => env, { SuiteController: class {}, api: new APIs(env, async () => new Response('{}')), suiteApi: {} });
  const project = router.projects.get('project-a').config;
  assert.equal(project.caps.concurrent, undefined);
  assert.equal(project.caps.startsPerDay, undefined);
  assert.deepEqual(project.lanes, []);
  // GitHub's max-parallel hold is not a project quota; the open queue keeps the matrix rules.
  assert.deepEqual(project.workflowConcurrency.map(rule => [rule.jobPrefix, rule.maxParallel]), [['test (', 8]]);
  assert.deepEqual([router.account.externalClients.lease.maxActive, router.account.externalClients.lease.startsPerDay, router.account.externalClients.lease.concurrencyReserve], [null, null, 0]);
  assert.equal(router.account.forbidPaidStarts, true);
  assert.equal(router.account.dayReserve, 0);
});
