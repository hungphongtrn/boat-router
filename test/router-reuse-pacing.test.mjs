import test from 'node:test';
import assert from 'node:assert/strict';
import { reusePacing, reuseHold, nominalReuseHold, paidIdleHold, PAID_IDLE_HOLD_SECONDS } from '../src/router/reuse-pacing.mjs';

const now = 10_000_000;
const account = { poolPacing: { enabled: true, mode: 'dynamic', burst: 40 }, reuse: { maxJobs: 60, maxAgeSeconds: 86400 }, starts: { minute: 24, hour: 120, day: 400 }, windowMargins: { minute: 0, hour: 0, day: 0.05 }, dayReserve: 0 };
const project = { machineTtlSeconds: 86400, jobs: { build: { timeoutMinutes: 60 } }, reuse: { maxJobs: 60, maxAgeSeconds: 86400 } };
const box = { reusable: true, baselineHash: 'ok', createdAt: now - 60_000, onlineAt: now - 30_000, jobs: 1 };
const hold = extra => reuseHold({ box, baseSeconds: 900, nominalSeconds: 3600, now, account, project, env: {}, enabled: true, ...extra });

test('low pacing holds compatible reusable idle boxes for one hour and abundant pacing restores the baseline', () => {
  assert.equal(hold({}), 3600);
  assert.equal(hold({ nominalSeconds: 900 }), 900);
  // The cost-aware policy may decide to retire now; the base hold is not a floor.
  assert.equal(hold({ nominalSeconds: 0 }), 0);
  assert.equal(hold({ box: { ...box, reusable: false } }), 120);
  assert.equal(hold({ enabled: false }), 900);
  assert.equal(hold({ box: { ...box, baselineHash: null } }), 900);
  assert.equal(hold({ box: { ...box, jobs: 59 } }), 900);
});

test('nominal hold decreases smoothly from one hour at 5 per hour to baseline at 15', () => {
  assert.equal(nominalReuseHold(900, 0), 3600);
  assert.equal(nominalReuseHold(900, 5), 3600);
  assert.equal(nominalReuseHold(900, 10), 2250);
  assert.equal(nominalReuseHold(900, 15), 900);
  assert.equal(nominalReuseHold(900, 20), 900);
  assert.equal(nominalReuseHold(900, null), 900);
  assert.equal(nominalReuseHold(4000, 5), 4000);
});

test('long hold is capped by TTL headroom, maximum age and the current idle start', () => {
  const limited = { ...project, machineTtlSeconds: 7200 };
  // A 60 minute job plus 20 minutes headroom leaves 40 minutes of box lifetime.
  assert.equal(hold({ project: limited }), 2370);
  assert.equal(hold({ box: { ...box, machineTtlSeconds: 7200 } }), 2370);
  assert.equal(hold({ box: { ...box, createdAt: now - 3_000_000 }, project: limited }), 0);
  assert.equal(hold({ project: { ...project, reuse: { maxJobs: 60, maxAgeSeconds: 1800 } } }), 1770);
});

test('fresh shared ledger pacing status is used without an extra provider request', async () => {
  let reads = 0;
  const state = { pacingStatus: { sampledAt: now - 1000, effectiveStartsPerHour: 4.99 } };
  const budget = { ledger: { key: 'ledger', storage: { get: async () => state } } };
  const got = await reusePacing({ account, budget, api: { limits: async () => { reads++; throw Error(); } }, now: () => now });
  assert.deepEqual(got, { sampledAt: now - 1000, startsPerHour: 4.99, dayRemaining: null, hourRemaining: null, hourUsed: null, dayUsed: null, dayRoomEmpty: false, paidExtraRoom: false });
  assert.equal(reads, 0);
});

test('stale pacing is recomputed with fresh provider data and fails closed when unavailable', async () => {
  const state = { claims: {}, pacingStatus: { sampledAt: now - 31_000, effectiveStartsPerHour: 2 } };
  const budget = { ledger: { key: 'ledger', storage: { get: async () => state } } };
  const api = { limits: async () => ({ observedAt: now, canStart: true, starts: { minute: { limit: 24, used: 0 }, hour: { limit: 120, used: 0 }, day: { limit: 400, used: 360 } } }) };
  const got = await reusePacing({ account, budget, api, now: () => now });
  assert.ok(got && Number.isFinite(got.startsPerHour));
  assert.equal(got.sampledAt, now);
  assert.equal(state.pacingStatus.effectiveStartsPerHour, 2);
  assert.equal(await reusePacing({ account, budget, api: { limits: async () => { throw Error(); } }, now: () => now }), null);
});

test('projects sharing an account reuse an in-flight pacing observation', async () => {
  let reads = 0;
  const budget = { ledger: { key: 'ledger', storage: { get: async () => ({ claims: {} }) } } };
  const api = { limits: async () => { reads++; await Promise.resolve(); return { observedAt: now, canStart: true, starts: { minute: { limit: 24, used: 0 }, hour: { limit: 120, used: 0 }, day: { limit: 400, used: 360 } } }; } };
  const [a, b] = await Promise.all([reusePacing({ account, budget, api, now: () => now }), reusePacing({ account, budget, api, now: () => now })]);
  assert.ok(a && b);
  assert.equal(reads, 1);
});

test('provider reads without an observation time use request start, not response end', async () => {
  let clock = now;
  const budget = { ledger: { key: 'ledger', storage: { get: async () => ({ claims: {} }) } } };
  const api = { limits: async () => { clock += 10_000; return { canStart: true, starts: { minute: { limit: 24, used: 0 }, hour: { limit: 120, used: 0 }, day: { limit: 400, used: 360 } } }; } };
  assert.equal((await reusePacing({ account, budget, api, now: () => clock })).sampledAt, now);
});

test('paid idle hold extends only while the free day window is empty and the paid budget has room', () => {
  const pacing = { dayRoomEmpty: true, paidExtraRoom: true };
  assert.equal(PAID_IDLE_HOLD_SECONDS, 1200);
  assert.equal(paidIdleHold({ pacing, baseSeconds: 420 }), 1200);
  assert.equal(paidIdleHold({ pacing, baseSeconds: 420, configured: 900 }), 900);
  assert.equal(paidIdleHold({ pacing, baseSeconds: 420, configured: 300 }), 420);
  assert.equal(paidIdleHold({ pacing, baseSeconds: 1800, configured: 600 }), 1800);
  assert.equal(paidIdleHold({ pacing: { dayRoomEmpty: false, paidExtraRoom: true }, baseSeconds: 420 }), null);
  assert.equal(paidIdleHold({ pacing: { dayRoomEmpty: true, paidExtraRoom: false }, baseSeconds: 420 }), null);
  assert.equal(paidIdleHold({ pacing: null, baseSeconds: 420 }), null);
});

test('a fresh pacing status carries the remaining day and hour start budget', async () => {
  const status = { sampledAt: now - 1000, effectiveStartsPerHour: 6, remaining: { day: 9, hour: 4 }, hardRemaining: { day: 7, hour: 3 }, hourUsed: 2, dayUsed: 41 };
  const got = await reusePacing({ account, budget: { ledger: { key: 'ledger', storage: { get: async () => ({ pacingStatus: status }) } } }, api: { limits: async () => { throw Error(); } }, now: () => now });
  assert.equal(got.dayRemaining, 7);
  assert.equal(got.hourRemaining, 3);
  assert.equal(got.hourUsed, 2);
  assert.equal(got.dayUsed, 41);
});

test('a fresh pacing status reports the empty day window and the paid budget room', async () => {
  const paid = { ...account, starts: { ...account.starts, allowPaidExtra: true, paidExtraMaxDollarsPerMonth: 2 } };
  const status = { sampledAt: now - 1000, effectiveStartsPerHour: 2, remaining: { day: 0 }, hardRemaining: { day: 14 } };
  const room = await reusePacing({ account: paid, budget: { ledger: { key: 'ledger', storage: { get: async () => ({ pacingStatus: status, paidExtraSpend: [{ at: now - 1000, dollars: 0.39 }] }) } } }, api: { limits: async () => { throw Error(); } }, now: () => now });
  assert.equal(room.dayRoomEmpty, true);
  assert.equal(room.paidExtraRoom, true);
  const spent = await reusePacing({ account: paid, budget: { ledger: { key: 'ledger', storage: { get: async () => ({ pacingStatus: status, paidExtraSpend: [{ at: now - 1000, dollars: 2 }] }) } } }, api: { limits: async () => { throw Error(); } }, now: () => now });
  assert.equal(spent.dayRoomEmpty, true);
  assert.equal(spent.paidExtraRoom, false);
  const free = await reusePacing({ account, budget: { ledger: { key: 'ledger', storage: { get: async () => ({ pacingStatus: { ...status, remaining: { day: 9 } }, paidExtraSpend: [] }) } } }, api: { limits: async () => { throw Error(); } }, now: () => now });
  assert.equal(free.dayRoomEmpty, false);
  assert.equal(free.paidExtraRoom, false);
});
