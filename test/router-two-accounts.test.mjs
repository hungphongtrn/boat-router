// primary and secondary form one open pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountLedger } from '../src/router/ledger.mjs';
import { cutoverBudget, externalCutoverLedger, accountReady, dayShareFree, preferredAccount, accountBlockKey } from '../src/router/account-cutover.mjs';
import { recentLimits } from '../src/router/install.mjs';
import { Storage } from './helpers.mjs';

const now = () => 1000000;
const limits = (used, limit = 400, extra = {}) => ({ observedAt: now(), canStart: true, billingStatus: 'active', nextStartDollars: 0, creditBalanceSeconds: 100000, creditBalanceHours: 27.7, planIncluded: { vmHours: 10, vmHoursRemaining: 0 },
  activeSandboxes: 0, maxActiveSandboxes: 200, machineTypes: [{ type: 'large', available: true }], startLimits: { perMinute: 24, perHour: 120, perDay: limit },
  starts: { minute: { limit: 24, used: 0, remaining: 24 }, hour: { limit: 120, used: 0, remaining: 120 }, day: { limit, used, remaining: limit - used } }, ...extra });

async function fixture({ secondary = limits(0), work = limits(500, 600), secondaryEnabled = true, workEnabled = true, project = 'project-b', snapshotAccounts } = {}) {
  const storage = new Storage();
  const secondaryLedger = new AccountLedger(storage, { ledgerKey: 'secondary', starts: { minute: 24, hour: 120, day: 400 }, forbidPaidStarts: true }, now);
  const workLedger = new AccountLedger(storage, { ledgerKey: 'work', starts: { minute: 36, hour: 180, day: 600 } }, now);
  const reads = { secondary: 0, work: 0 };
  const poolOptions = { secondaryEnabled, workEnabled, snapshotAccounts,
    secondaryLimits: async () => { reads.secondary++; if (secondary instanceof Error) throw secondary; return structuredClone(secondary); },
    workLimits: async () => { reads.work++; if (work instanceof Error) throw work; return structuredClone(work); } };
  const budget = cutoverBudget(storage, secondaryLedger, workLedger, project, now, poolOptions);
  await storage.put('create:one', { createKey: 'one', state: 'pending', account: 'primary', queuedAt: 500, pool: JSON.stringify(['owner/repo', 'boat-large']) });
  await budget.enqueue('one', 500, undefined, { pool: true });
  return { storage, secondaryLedger, workLedger, budget, poolOptions, reads };
}

test('accountReady skips an unfunded, refused, paid or full account and keeps omitted fields neutral', () => {
  assert.equal(accountReady(limits(0), 'large'), true);
  assert.equal(accountReady(limits(0, 400, { creditBalanceSeconds: 0, creditBalanceHours: 0, packBalanceSeconds: 0 }), 'large'), false, 'no credit and no plan hours');
  assert.equal(accountReady(limits(0, 400, { creditBalanceSeconds: 0, creditBalanceHours: 0, planIncluded: { vmHours: 10, vmHoursRemaining: 3 } }), 'large'), true, 'plan hours only');
  assert.equal(accountReady(limits(0, 400, { canStart: false }), 'large'), false);
  assert.equal(accountReady(limits(0, 400, { billingStatus: 'past_due' }), 'large'), false);
  assert.equal(accountReady(limits(0, 400, { nextStartDollars: 0.03 }), 'large'), false, 'a paid start is never chosen');
  assert.equal(accountReady(limits(400), 'large'), false, 'day window full');
  assert.equal(accountReady(limits(0), 'xlarge'), false, 'size not on the plan');
  const bare = { canStart: true, machineTypes: [{ type: 'large', available: true }] };
  assert.equal(accountReady(bare, 'large'), true);
});

test('the start goes to the account with the larger share of its day window free', async () => {
  const a = await fixture({ secondary: limits(0), work: limits(528, 600) });
  assert.equal(await a.budget.selectAccount('one', 'large'), true);
  assert.equal((await a.storage.get('create:one')).account, 'secondary');
  const b = await fixture({ secondary: limits(380), work: limits(100, 600) });
  assert.equal(await b.budget.selectAccount('one', 'large'), true);
  assert.equal((await b.storage.get('create:one')).account, 'primary');
  assert.equal(await b.secondaryLedger.claim(await b.budget.claimKey('one')), null, 'no secondary claim or waiter is left');
  assert.deepEqual((await b.storage.get('secondary'))?.waiting ?? [], []);
});

test('starts the ledger admitted but the provider has not counted yet lower the share', async () => {
  const storage = new Storage(), ledger = new AccountLedger(storage, { ledgerKey: 'secondary' }, now);
  await storage.put('secondary', { claims: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`k${i}`, { project: 'project-b', status: 'pending', at: now() }])), waiting: [] });
  assert.equal(await dayShareFree(limits(0), ledger), 0.75);
  assert.equal(await dayShareFree({ starts: {} }, ledger), null);
});

test('an unfunded secondary account is skipped quietly and the start stays on primary', async () => {
  const empty = limits(0, 400, { creditBalanceSeconds: 0, creditBalanceHours: 0, packBalanceSeconds: 0, subscriptionRemainingSeconds: 0 });
  const { storage, budget, secondaryLedger } = await fixture({ secondary: empty, work: limits(590, 600) });
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'primary');
  assert.equal(await secondaryLedger.claim(await budget.claimKey('one')), null);
});

test('a full or unreadable primary window sends the start to secondary', async () => {
  for (const work of [limits(600, 600), new Error('limits unavailable'), limits(0, 600, { canStart: false })]) {
    const { storage, budget } = await fixture({ secondary: limits(390), work });
    assert.equal(await budget.selectAccount('one', 'large'), true);
    assert.equal((await storage.get('create:one')).account, 'secondary');
  }
});

test('both accounts full: no start, no error', async () => {
  const { storage, budget } = await fixture({ secondary: limits(400), work: limits(600, 600) });
  assert.equal(await budget.selectAccount('one', 'large'), true, 'primary admission then refuses with day_cap');
  assert.equal((await storage.get('create:one')).account, 'primary');
  assert.equal((await budget.admit('one', limits(600, 600), { pool: true })).ok, false);
});

test('a project that boots from a primary-only snapshot stays on primary while primary can start', async () => {
  const snapshotAccounts = project => project === 'project-a' ? { primary: true, secondary: false } : null;
  const a = await fixture({ project: 'project-a', snapshotAccounts, secondary: limits(0), work: limits(590, 600) });
  assert.equal(await a.budget.selectAccount('one', 'large'), true);
  assert.equal((await a.storage.get('create:one')).account, 'primary');
  const b = await fixture({ project: 'project-a', snapshotAccounts, secondary: limits(0), work: limits(600, 600) });
  assert.equal(await b.budget.selectAccount('one', 'large'), true);
  assert.equal((await b.storage.get('create:one')).account, 'secondary', 'primary full: the box boots plain on secondary');
  const c = await fixture({ project: 'project-a', snapshotAccounts: () => ({ primary: true, secondary: true }), secondary: limits(0), work: limits(500, 600) });
  assert.equal(await c.budget.selectAccount('one', 'large'), true);
  assert.equal((await c.storage.get('create:one')).account, 'secondary', 'snapshot on both: share rule');
});

test('a secondary refusal parks the secondary account only, for every project', async () => {
  const { storage, budget, poolOptions, secondaryLedger, workLedger } = await fixture({ secondary: limits(0) });
  await budget.blockAccount('secondary', 'plan');
  const block = await storage.get(accountBlockKey('secondary'));
  assert.equal(block.until, now() + 900_000);
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'primary');
  assert.equal(await preferredAccount({ storage, poolOptions, secondaryLedger, workLedger, size: 'large', now: now() + 900_001 }), 'secondary', 'the block expires');
  await budget.blockAccount('primary', 'plan');
  assert.equal(await storage.get(accountBlockKey('primary')), undefined, 'primary keeps its own project-level handling');
});

test('external leases use the same rule; base leases stay on primary', async () => {
  const storage = new Storage(), policy = { starts: { minute: 24, hour: 120, day: 400 }, externalClients: { lease: { startsPerDay: null } } };
  const secondary = new AccountLedger(storage, { ...policy, ledgerKey: 'secondary' }, now), work = new AccountLedger(storage, { ...policy, ledgerKey: 'work' }, now);
  const options = workUsed => ({ secondaryEnabled: true, workEnabled: true, secondaryLimits: async () => limits(200), workLimits: async () => limits(workUsed, 600) });
  const lease = { project: 'project-a', client: 'lease', claimKey: 'lease-a', size: 'large', createdAt: 500 };
  assert.equal(await externalCutoverLedger(secondary, work, options(100), now).selectForLease(lease), 'primary');
  assert.equal(await externalCutoverLedger(secondary, work, options(500), now).selectForLease({ ...lease, claimKey: 'lease-b' }), 'secondary');
  assert.equal(await externalCutoverLedger(secondary, work, options(599), now).selectForLease({ ...lease, claimKey: 'lease-c', baseId: 'a'.repeat(64) }), 'primary');
  const ledger = externalCutoverLedger(secondary, work, options(500), now);
  await ledger.blockAccount('secondary', 'lease_402');
  assert.equal(await ledger.selectForLease({ ...lease, claimKey: 'lease-d' }), 'primary');
});

test('secondary disabled keeps every start on primary and reads no secondary limits', async () => {
  const { storage, budget, reads } = await fixture({ secondaryEnabled: false, secondary: limits(0), work: limits(590, 600) });
  assert.equal(await budget.selectAccount('one', 'large'), true);
  assert.equal((await storage.get('create:one')).account, 'primary');
  assert.equal(reads.secondary, 0);
});

test('recentLimits reuses one read for 5 s', async () => {
  let t = 0, calls = 0;
  const read = recentLimits(async () => ({ n: ++calls }), () => t);
  assert.equal((await read()).n, 1);
  t = 4999; assert.equal((await read()).n, 1);
  t = 5000; assert.equal((await read()).n, 2);
});

test('the secondary ledger refuses a paid start', async () => {
  const storage = new Storage(), ledger = new AccountLedger(storage, { ledgerKey: 'secondary', forbidPaidStarts: true, starts: { minute: 24, hour: 120, day: 400 } }, now);
  await ledger.enqueue('project-b', 'paid');
  const { snapshotLimits } = await import('../src/router/ledger.mjs');
  assert.equal((await ledger.admit('project-b', 'paid', snapshotLimits(limits(0, 400, { nextStartDollars: 0.03 }), now()))).reason, 'paid_start_refused');
});

const { BoxFleet } = await import('../src/router/box-fleet.mjs');
const { createHash } = await import('node:crypto');
const { ApiError } = await import('../src/domain.mjs');
const fleetPool = '["example-owner/project-a","boat-large"]';
function fleetSetup(create, env = {}) {
  const storage = new Storage(), claims = new Map(), blocks = [], alerts = [];
  const budget = {
    claimKey: async key => createHash('sha256').update(key).digest('hex'),
    enqueue: async () => {}, claim: async key => claims.get(key),
    admit: async key => { claims.set(key, { status: 'pending' }); return { ok: true }; },
    begin: async key => { claims.get(key).status = 'calling'; return true; },
    settle: async (key, status) => { if (status === 'not_created') claims.delete(key); else claims.get(key).status = status; return true; },
    blockAccount: async (account, reason, delay) => { blocks.push({ account, reason, delay }); },
  };
  const fleet = new BoxFleet(storage, { create, findCreated: async () => null }, () => 100, { budget, project: { id: 'project-a', snapshotBoot: true }, getEnv: () => ({ BOAT_WALLET: 'example-account', PROJECT_SNAPSHOT_NAME: 'project-ci-20261109-1234abcd', PROJECT_SNAPSHOT_MANIFEST_SHA256: 'a'.repeat(64), ...env }), alert: event => alerts.push(event) });
  return { fleet, storage, claims, blocks, alerts };
}
async function secondaryCreate(h) {
  const [record] = await h.fleet.prepare(fleetPool, 'large', 1, 0);
  await h.storage.put(`create:${record.createKey}`, { ...record, account: 'secondary' });
  return record;
}

test('a secondary Project A box uses the secondary snapshot copy when one is set', async () => {
  let call;
  const h = fleetSetup(async request => { call = request; return { sandbox: { id: 'bx_23456789' } }; }, { PROJECT_SNAPSHOT_NAME_SECONDARY: 'project-ci-20261111-abcdef12', PROJECT_SNAPSHOT_MANIFEST_SHA256_SECONDARY: 'b'.repeat(64) });
  const record = await secondaryCreate(h);
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), true);
  assert.equal(call.routerSnapshot.name, 'project-ci-20261111-abcdef12');
  assert.equal((await h.storage.get('box:bx_23456789')).bootPath, 'snapshot');
});

test('a 402 from secondary parks secondary only: no project block, no backoff, no create-failure alert', async () => {
  const h = fleetSetup(async () => { throw new ApiError('boat', 402); });
  const record = await secondaryCreate(h);
  assert.equal(await h.fleet.admit(record.createKey, {}, 3600), false);
  assert.deepEqual(h.blocks.map(b => [b.account, b.reason]), [['secondary', 'plan']]);
  assert.equal(await h.storage.get('blocked'), undefined);
  assert.equal(await h.storage.get('startBackoffUntil'), undefined);
  assert.equal(await h.storage.get(`create:${record.createKey}`), undefined, 'the create is discarded and planned again');
  assert.deepEqual(h.alerts, []);
});

test('a 429 from secondary parks secondary for the retry time; a primary 402 keeps the project block', async () => {
  const h = fleetSetup(async () => { throw new ApiError('boat', 429, 'rate_limited', 120); });
  const record = await secondaryCreate(h);
  await h.fleet.admit(record.createKey, {}, 3600);
  assert.deepEqual(h.blocks.map(b => [b.reason, b.delay]), [['limited', 120000]]);
  assert.equal(await h.storage.get('startBackoffUntil'), undefined);
  const k = fleetSetup(async () => { throw new ApiError('boat', 402); });
  const [work] = await k.fleet.prepare(fleetPool, 'large', 1, 0);
  await k.fleet.admit(work.createKey, {}, 3600);
  assert.deepEqual(k.blocks, []);
  assert.ok(await k.storage.get('blocked'));
});

const { WarmLeaseFence } = await import('../src/router/external-leases.mjs');
async function returningLease(health, healthEnforce = true) {
  const storage = new Storage(), id = '00000000-0000-4000-8000-0000000000aa';
  const api = { lightResetResult: async () => ({ ok: true, ...(health ? { summary: { health } } : {}) }) };
  const fence = new WarmLeaseFence(storage, api, now);
  fence.healthEnforce = healthEnforce;
  await storage.put(`external-lease:lease:${id}`, { project: 'project-a', client: 'lease', id, machineId: 'bx_slowbox1', state: 'returning', processId: 7, generation: 2, isolation: 'external-v2' });
  await storage.put('project:project-a:box:bx_slowbox1', { machineId: 'bx_slowbox1', account: 'secondary', state: 'lease-returning', leaseId: id, leaseClient: 'lease', generation: 2, jobs: 1 });
  const done = await fence.completeReturn('project-a', 'lease', id);
  return { done, box: await storage.get('project:project-a:box:bx_slowbox1') };
}
const healthOf = slow => ({ cpuMs: 10, fsyncMs: slow ? 27 : 2, writeMs: 50, memPct: 80, foreign: false, measured: true, failed: slow, slow, cpu: 'AMD Ryzen 7 9700X' });

test('a lease box with a measured slow disk is retired at its return, for either account', async () => {
  const slow = await returningLease(healthOf(true));
  assert.equal(slow.done, false);
  assert.equal(slow.box.state, 'destroying');
  assert.equal(slow.box.retirementReason, 'health_check');
  assert.equal(slow.box.slowHost, true);
  const healthy = await returningLease(healthOf(false));
  assert.equal(healthy.done, true);
  assert.equal(healthy.box.state, 'lease-warm');
  const observe = await returningLease(healthOf(true), false);
  assert.equal(observe.box.state, 'lease-warm', 'observe mode keeps the box');
  const unmeasured = await returningLease({ ...healthOf(true), measured: false });
  assert.equal(unmeasured.box.state, 'lease-warm', 'a probe that cannot measure never retires a box');
});

const { ExternalLeaseStarts } = await import('../src/router/external-leases.mjs');
const { leaseBase } = await import('../src/router/lease-base.mjs');
test('a lease base lease may start on secondary only with a pinned secondary copy of the same name', async () => {
  const selection = await leaseBase({ LEASE_BASE_SNAPSHOT_NAME: 'lease-ci-20261110-77701628', LEASE_BASE_SNAPSHOT_ID: 'primary-id', LEASE_BASE_MANIFEST_SHA256: 'a'.repeat(64), LEASE_BASE_PROFILE_SHA256: 'b'.repeat(64) });
  const lease = { project: 'project-a', client: 'lease', claimKey: 'base-1', size: 'large', createdAt: 500, ...selection };
  const storage = new Storage(), policy = { starts: { minute: 24, hour: 120, day: 400 }, externalClients: { lease: { startsPerDay: null } } };
  const secondary = new AccountLedger(storage, { ...policy, ledgerKey: 'secondary' }, now), work = new AccountLedger(storage, { ...policy, ledgerKey: 'work' }, now);
  let bases = {};
  const options = { secondaryEnabled: true, workEnabled: true, secondaryLimits: async () => limits(0), workLimits: async () => limits(590, 600),
    secondaryBase: l => { const b = bases[l?.routerSnapshot?.kind]; return b && b.name === l.routerSnapshot?.name ? b : null; } };
  assert.equal(await externalCutoverLedger(secondary, work, options, now).selectForLease(lease), 'primary', 'no secondary copy');
  bases = { 'lease-v1': { name: 'lease-ci-20261110-77701628', snapshotId: 'secondary-id' } };
  assert.equal(await externalCutoverLedger(secondary, work, options, now).selectForLease({ ...lease, claimKey: 'base-2' }), 'secondary');
  bases = { 'lease-v1': { name: 'lease-ci-20261110-00000000', snapshotId: 'secondary-id' } };
  assert.equal(await externalCutoverLedger(secondary, work, options, now).selectForLease({ ...lease, claimKey: 'base-3' }), 'primary', 'another name is not a copy');

  const seen = [];
  const accounts = { primary: { request: async () => ({ snapshot: { status: 'ready', snapshotId: 'primary-id' } }) }, secondary: { request: async () => ({ snapshot: { status: 'ready', snapshotId: 'secondary-id' } }) } };
  const starts = new ExternalLeaseStarts(storage, work, { forIdentity: async ({ account }) => { seen.push(account); return accounts[account]; } }, now, 'primary');
  starts.secondaryBases = { 'lease-v1': { name: 'lease-ci-20261110-77701628', snapshotId: 'secondary-id' } };
  assert.equal(await starts.leaseIdentity(lease, 'secondary'), true);
  assert.equal(await starts.leaseIdentity(lease, 'primary'), true);
  starts.secondaryBases = { 'lease-v1': { name: 'lease-ci-20261110-77701628', snapshotId: 'stale-id' } };
  assert.equal(await starts.leaseIdentity(lease, 'secondary'), false, 'the secondary copy must have the pinned id');
  starts.secondaryBases = null;
  assert.equal(await starts.leaseIdentity(lease, 'secondary'), false);
  assert.deepEqual(seen, ['secondary', 'primary', 'secondary']);
});
