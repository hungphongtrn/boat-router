import test from 'node:test';
import assert from 'node:assert/strict';
import { reusePacing, reuseHold, nominalReuseHold } from '../src/router/reuse-pacing.mjs';

const now = 10_000_000;
const account = { poolPacing: { enabled: true, mode: 'dynamic', burst: 40 }, reuse: { maxJobs: 60, maxAgeSeconds: 86400 }, starts: { minute: 24, hour: 120, day: 400 }, windowMargins: { minute: 0, hour: 0, day: 0.05 }, dayReserve: 0 };
const project = { machineTtlSeconds: 86400, jobs: { build: { timeoutMinutes: 60 } }, reuse: { maxJobs: 60, maxAgeSeconds: 86400 } };
const box = { reusable: true, baselineHash: 'ok', createdAt: now - 60_000, onlineAt: now - 30_000, jobs: 1 };
const hold = extra => reuseHold({ box, baseSeconds: 900, nominalSeconds: 3600, now, account, project, env: {}, enabled: true, ...extra });

test('low pacing holds compatible reusable idle boxes for one hour and abundant pacing restores the baseline', () => {
  assert.equal(hold({}), 3600);
  assert.equal(hold({ nominalSeconds: 900 }), 900);
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
  assert.deepEqual(got, { sampledAt: now - 1000, startsPerHour: 4.99 });
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
