import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountLedger, snapshotLimits } from '../src/router/ledger.mjs';
import { cutoverBudget, availablePacedStarts } from '../src/router/account-cutover.mjs';
import { Storage } from './helpers.mjs';

const now = () => 1000000;
const limits = used => ({ observedAt: now(), canStart: true, activeSandboxes: 0, maxActiveSandboxes: 20, machineTypes: [{ type: 'large', available: true }], startLimits: { perMinute: 2, perHour: 2, perDay: 2 }, starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 2, used, remaining: 2 - used }])) });
async function fixture({ used = 0, secondaryEnabled = true, workEnabled = true } = {}) {
  const storage = new Storage(), secondary = new AccountLedger(storage, { ledgerKey: 'secondary', starts: { minute: 2, hour: 2, day: 2 } }, now), work = new AccountLedger(storage, { ledgerKey: 'work', starts: { minute: 2, hour: 2, day: 2 } }, now);
  const budget = cutoverBudget(storage, secondary, work, 'project-a', now, { secondaryEnabled, workEnabled, secondaryLimits: async () => limits(used) });
  await storage.put('create:one', { createKey: 'one', state: 'pending', account: 'primary', queuedAt: 500, pool: JSON.stringify(['owner/repo', 'boat-large']) });
  await budget.enqueue('one', 500, undefined, { pool: true });
  return { storage, secondary, work, budget };
}

test('secondary is preferred when its ledger permits a start', async () => {
  const { storage, secondary, work, budget } = await fixture();
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'secondary');
  const hash = await budget.claimKey('one');
  assert.equal((await secondary.claim(hash)).status, 'pending');
  assert.equal(await work.claim(hash), null);
  assert.deepEqual((await storage.get('work')).waiting, []);
});

test('a paced secondary account falls back to work without leaving a waiter', async () => {
  const { storage, secondary, budget } = await fixture({ used: 2 });
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'primary');
  // a secondary account with a full day window is not tried at all, so it holds no ledger state.
  assert.deepEqual((await storage.get(secondary.key))?.waiting ?? [], []);
  assert.equal((await budget.admit('one', limits(0), { pool: true })).ok, true);
});

test('disabled work refuses a new overflow, and existing secondary claims recover', async () => {
  const first = await fixture({ used: 2, workEnabled: false });
  assert.equal(await first.budget.selectAccount('one', 'large'), false);
  const recovered = await fixture({ secondaryEnabled: false, workEnabled: false });
  const hash = await recovered.budget.claimKey('one');
  await recovered.storage.put('secondary', { claims: { [hash]: { project: 'project-a', status: 'unknown', at: now() } }, waiting: [] });
  assert.equal(await recovered.budget.selectAccount('one', 'large'), true);
  assert.equal((await recovered.storage.get('create:one')).account, 'secondary');
});

test('unknown work creates stay on work even if work is disabled', async () => {
  const { storage, budget, work } = await fixture({ workEnabled: false });
  const hash = await budget.claimKey('one');
  await storage.put('work', { claims: { [hash]: { project: 'project-a', status: 'unknown', at: now() } }, waiting: [] });
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await work.claim(hash)).status, 'unknown');
  assert.equal((await storage.get('create:one')).account, 'primary');
});

test('external leases prefer secondary and preserve an existing work claim', async () => {
  const { externalCutoverLedger } = await import('../src/router/account-cutover.mjs');
  const storage = new Storage(), policy = { starts: { minute: 2, hour: 2, day: 2 }, externalClients: { lease: { startsPerDay: 2 } } };
  const secondary = new AccountLedger(storage, { ...policy, ledgerKey: 'secondary' }, now), work = new AccountLedger(storage, { ...policy, ledgerKey: 'work' }, now);
  const ledger = externalCutoverLedger(secondary, work, { secondaryEnabled: true, workEnabled: true, secondaryLimits: async () => limits(0) }, now);
  const lease = { project: 'project-a', client: 'lease', claimKey: 'lease-key', size: 'large', createdAt: 500 };
  assert.equal(await ledger.selectForLease(lease), 'secondary');
  assert.equal((await secondary.claim(lease.claimKey)).status, 'pending');
  assert.equal(await work.claim(lease.claimKey), null);
  await storage.put('work', { claims: { other: { project: 'project-a', client: 'lease', status: 'unknown', at: now() } }, waiting: [] });
  assert.equal(await ledger.selectForLease({ ...lease, claimKey: 'other' }), 'primary');
});

test('a browser base uses primary and does not adopt a secondary claim', async () => {
  const { externalCutoverLedger } = await import('../src/router/account-cutover.mjs');
  const storage = new Storage(), policy = { starts: { minute: 2, hour: 2, day: 2 }, externalClients: { lease: { startsPerDay: 2 } } };
  const secondary = new AccountLedger(storage, { ...policy, ledgerKey: 'secondary' }, now), work = new AccountLedger(storage, { ...policy, ledgerKey: 'work' }, now);
  const ledger = externalCutoverLedger(secondary, work, { secondaryEnabled: true, workEnabled: true, secondaryLimits: async () => limits(0) }, now);
  const lease = { project: 'project-a', client: 'lease', claimKey: 'browser', size: 'large', createdAt: 500, baseId: 'a'.repeat(64) };
  assert.equal(await ledger.selectForLease(lease), 'primary');
  assert.equal(await secondary.claim(lease.claimKey), null);
  await storage.put('secondary', { claims: { browser: { project: 'project-a', client: 'lease', status: 'unknown', at: now() } }, waiting: [] });
  assert.equal(await ledger.selectForLease(lease), null);
  assert.equal((await secondary.claim(lease.claimKey)).status, 'unknown');
});

test('external client start cap applies separately to each account', async () => {
  const { externalCutoverLedger } = await import('../src/router/account-cutover.mjs');
  const storage = new Storage(), policy = { starts: { minute: 2, hour: 2, day: 2 }, externalClients: { lease: { startsPerDay: 1 } } };
  const secondary = new AccountLedger(storage, { ...policy, ledgerKey: 'secondary' }, now), work = new AccountLedger(storage, { ...policy, ledgerKey: 'work' }, now);
  await storage.put('secondary', { claims: { prior: { project: 'project-a', client: 'lease', status: 'created', at: now(), settledAt: now() } }, waiting: [] });
  const ledger = externalCutoverLedger(secondary, work, { secondaryEnabled: true, workEnabled: true, secondaryLimits: async () => limits(0) }, now);
  assert.equal(await ledger.selectForLease({ project: 'project-a', client: 'lease', claimKey: 'new', size: 'large', createdAt: 500 }), 'primary');
  assert.equal(await secondary.claim('new'), null);
  await ledger.enqueue('project-a', 'new', 500, undefined, { client: 'lease' });
  assert.equal((await ledger.admit('project-a', 'new', snapshotLimits(limits(0), now()))).ok, true);
  assert.equal((await work.claim('new')).status, 'pending');
  assert.equal(await ledger.selectForLease({ project: 'project-a', client: 'lease', claimKey: 'next', size: 'large', createdAt: 500 }), 'primary');
  await ledger.enqueue('project-a', 'next', 500, undefined, { client: 'lease' });
  assert.equal((await ledger.admit('project-a', 'next', snapshotLimits(limits(0), now()))).reason, 'client_cap');
});

test('box admission checks the selected account limits before starting', async () => {
  const { BoxFleet } = await import('../src/router/box-fleet.mjs');
  const { accountApi } = await import('../src/router/account-cutover.mjs');
  const { storage, budget } = await fixture();
  await storage.put('create:one', { createKey: 'one', state: 'pending', account: 'primary', queuedAt: 500, size: 'large', pool: JSON.stringify(['owner/repo', 'boat-large']) });
  await storage.put('pool:snapshot', { complete: true });
  const api = accountApi(storage, { limits: async () => ({ ...limits(0), from: 'secondary' }) }, { limits: async () => ({ ...limits(0), from: 'primary' }) });
  const project = { id: 'project-a', repo: 'owner/repo', caps: {}, labels: ['boat-large'] };
  const fleet = new BoxFleet(storage, api, now, { budget, project });
  let selected;
  fleet.admit = async (_key, observed) => { selected = observed.from; return true; };
  await fleet.admitQueued('one', { mode: 'on', env: { ENABLED: 'true' }, project });
  assert.equal(selected, 'secondary');
  assert.equal((await storage.get('create:one')).account, 'secondary');
});

test('an external lease starts on secondary when work limits are unavailable', async () => {
  const { TenantStorage } = await import('../src/router/tenant-storage.mjs');
  const { accountApi, externalCutoverLedger } = await import('../src/router/account-cutover.mjs');
  const { ExternalService } = await import('../src/router/external-service.mjs');
  const root = new Storage(), scoped = new TenantStorage(root, 'project-a');
  const clients = { lease: { enabled: true, seededBase: true, project: 'project-a', maxActive: 1, startsPerDay: 2, ttlSeconds: 60 } };
  const policy = { starts: { minute: 2, hour: 2, day: 2 }, externalClients: clients };
  const secondary = new AccountLedger(root, { ...policy, ledgerKey: 'secondary' }, now), work = new AccountLedger(root, { ...policy, ledgerKey: 'work' }, now);
  const ownLimits = { ...limits(0), machineTypes: [{ type: 'default', available: true }] };
  let createdAccount;
  const secondaryApi = { limits: async () => ownLimits, create: async () => { createdAccount = 'secondary'; return { sandbox: { id: 'bx_23456789' } }; } };
  const workApi = { limits: async () => { throw new Error('work unavailable'); }, create: async () => { createdAccount = 'primary'; } };
  const api = accountApi(scoped, secondaryApi, workApi), ledger = externalCutoverLedger(secondary, work, { secondaryEnabled: true, workEnabled: true, secondaryLimits: async () => ownLimits }, now);
  const config = { id: 'project-a', repo: 'a/b', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } }, caps: { concurrent: 10 }, reuse: { mode: 'on' } };
  const router = { projects: new Map([['project-a', { storage: scoped, config, box: true }]]), ledger: work, externalLedger: ledger, externalCreateAccount: 'primary', account: { reuse: { enabled: true } } };
  const service = new ExternalService(router, root, api, clients, now), id = '00000000-0000-4000-8000-000000000001';
  await scoped.put('pool:mode', 'on');
  await scoped.put('pool:snapshot', { complete: true, at: now(), jobs: [], runners: [] });
  assert.equal(await service.claim('lease', id, 'default'), null);
  assert.equal(createdAccount, 'secondary');
  assert.equal((await root.get(`external-lease:lease:${id}`)).account, 'secondary');
  assert.equal((await scoped.get('box:bx_23456789')).account, 'secondary');
});

test('secondary admission ignores an unrelated local-only pool', async () => {
  const { storage, budget } = await fixture();
  await storage.put('project:project-a:pool:snapshot-complete', true);
  await storage.put('project:project-a:pool:status:boat-large', { reason: 'ledger:day_cap' });
  await storage.put('project:project-a:pool:status:project-a-mac-trial', { reason: 'local_only' });
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'secondary');
});

test('secondary takes priority when work has more burst credit', async () => {
  const { storage, budget } = await fixture();
  const status = credit => ({ sampledAt: now(), burstCredit: credit, remaining: { minute: 20, hour: 20, day: 20 } });
  for (const [key, credit] of [['secondary', 2], ['work', 8]]) {
    const state = await storage.get(key) ?? { claims: {}, waiting: [] };
    await storage.put(key, { ...state, pacingStatus: status(credit) });
  }
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'secondary');
  assert.equal(availablePacedStarts({ pacingStatus: status(8) }, now() + 30001), null);
});
