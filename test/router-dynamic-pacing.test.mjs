import test from 'node:test';
import assert from 'node:assert/strict';
import { dynamicPacing } from '../src/router/dynamic-pacing.mjs';
import { AccountLedger, snapshotLimits } from '../src/router/ledger.mjs';
import { Storage } from './helpers.mjs';

const now = 100_000_000;
const policy = { starts: { minute: 24, hour: 120, day: 400 }, windowMargins: { minute: 0, hour: 0, day: .05 }, poolPacing: { enabled: true, mode: 'dynamic', burst: 40, reserveStarts: 0 } };
const snapshot = (minute = 0, hour = 0, day = 0) => ({ at: now, canStart: true, windows: { minute: { limit: 24, used: minute }, hour: { limit: 120, used: hour }, day: { limit: 400, used: day } } });
const calc = (snap, claims = [], previous = null, at = now) => dynamicPacing({ snapshot: snap, policy, claims, previous, now: at });

test('remaining budget sets continuous rate and proportional burst with conservative expiry', () => {
  const full = calc(snapshot()).status;
  assert.equal(full.remaining.day, 380); assert.equal(full.burstCredit, 40);
  assert.ok(Math.abs(full.effectiveStartsPerHour - 380 / 24) < 1e-10); assert.equal(full.nextRollOff, null);
  assert.equal(full.basis, 'provider_aggregate_24h_fallback');
  const expanded = snapshot(); expanded.windows.day.limit = 800;
  assert.equal(calc(expanded).status.remaining.day, 380);
  const smaller = snapshot(); smaller.windows.day.limit = 200;
  assert.equal(calc(smaller).status.remaining.day, 190);
  const middle = calc(snapshot(0, 0, 190)).status;
  assert.equal(middle.remaining.day, 190); assert.equal(middle.burstCredit, 20);
  const rates = [265, 266, 267].map(n => calc(snapshot(0, 0, n)).status.effectiveStartsPerHour);
  assert.ok(rates[0] > rates[1] && rates[1] > rates[2]);
  assert.equal(calc(snapshot(0, 0, 379)).status.burstCredit, 1);
  assert.equal(calc(snapshot(0, 0, 380)).status.burstCredit, 0);
});

test('pending and unobserved claims consume each effective window', () => {
  const claims = [{ status: 'pending', at: now - 500 }, { status: 'created', at: now - 500, settledAt: now }];
  const value = calc(snapshot(2, 10, 200), claims).status.remaining;
  assert.deepEqual(value, { minute: 20, hour: 108, day: 178 });
});

test('refill uses lower of prior and current rate, and invalid state fails closed', () => {
  const old = { at: now - 3_600_000, credit: 0, ratePerMs: 2 / 3_600_000 };
  assert.ok(Math.abs(calc(snapshot(0, 0, 190), [], old).status.burstCredit - 2) < 1e-10);
  assert.equal(calc(snapshot(), [], { ...old, at: now + 1 }), null);
  assert.equal(calc({ ...snapshot(), at: now - 30_001 }), null);
});

test('dynamic burst is atomic and shared across projects and pool modes', async () => {
  const store = new Storage(); const ledger = new AccountLedger(store, { ...policy, poolPacing: { ...policy.poolPacing, burst: 1 } }, () => now);
  await ledger.enqueue('project-a', 'one', now - 1, undefined, { pool: true });
  await ledger.enqueue('project-b', 'two', now, undefined, { pool: false });
  const results = await Promise.all([ledger.admit('project-a', 'one', snapshot(), { pool: true }), ledger.admit('project-b', 'two', snapshot(), { pool: false })]);
  assert.equal(results.filter(r => r.ok).length, 2);
  await ledger.enqueue('project-a', 'three', now - 1); await ledger.enqueue('project-b', 'four', now);
  assert.equal((await ledger.admit('project-a', 'three', snapshot())).ok, true);
  assert.equal((await ledger.admit('project-b', 'four', snapshot())).reason, 'pacing');
});

test('hard provider windows and daily guard override burst credit', async () => {
  for (const [snap, reason] of [[snapshot(24), 'minute_cap'], [snapshot(0, 120), 'hour_cap'], [snapshot(0, 0, 400), 'day_cap']]) {
    const ledger = new AccountLedger(new Storage(), policy, () => now);
    await ledger.enqueue('project-a', 'one');
    assert.equal((await ledger.admit('project-a', 'one', snap)).reason, reason);
  }
});

test('authenticated pacing status projects live admission credit without consuming it', async () => {
  const { Fleet } = await import('../src/fleet.mjs');
  const { hash } = await import('../src/setup.mjs');
  const control = 'c'.repeat(40), storage = new Storage();
  const env = { PLUGIN_ROUTER: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a', SETUP_BOOTSTRAP: JSON.stringify({ controlHash: await hash(control) }) };
  const fleet = new Fleet({ storage }, env);
  fleet.controller.api.limits = async () => ({ canStart: true, starts: { minute: { limit: 24, used: 0 }, hour: { limit: 120, used: 0 }, day: { limit: 400, used: 190 } } });
  assert.equal((await fleet.fetch(new Request('https://fleet/router/pacing'))).status, 401);
  const request = () => new Request('https://fleet/router/pacing', { headers: { Authorization: `Bearer ${control}` } });
  const { default: worker } = await import('../src/worker.mjs');
  const workerEnv = { FLEET: { idFromName: () => 'id', get: () => fleet } };
  const response = await worker.fetch(request(), workerEnv), result = await response.json();
  assert.equal(response.status, 200); assert.equal(result.available, true);
  assert.equal(result.remaining.day, 210); assert.equal(result.burstCredit, 4); assert.equal(result.admissionMode, 'unpaced');
  assert.equal(await storage.get(fleet.router.ledger.key), undefined);
  fleet.controller.api.limits = async () => ({ canStart: false, starts: { minute: { limit: 24, used: 24 }, hour: { limit: 120, used: 0 }, day: { limit: 400, used: 190 } } });
  const blocked = await (await worker.fetch(request(), workerEnv)).json();
  assert.equal(blocked.available, true); assert.equal(blocked.reason, 'provider_refused');
  assert.equal(blocked.admissionAvailable, false);
  assert.deepEqual(blocked.remaining, { minute: 0, hour: 60, day: 210 }); assert.equal(blocked.burstCredit, 0);
  assert.equal(result.admissionAvailable, true);
  fleet.controller.api.limits = async () => { throw new Error('private provider error'); };
  const unavailable = await (await fleet.fetch(request())).json();
  assert.deepEqual(unavailable, { enabled: true, available: false, reason: 'provider_unavailable' });
});

test('a backlog larger than scaled burst starts boxes one at a time and resumes after refill', async () => {
  let time = now; const ledger = new AccountLedger(new Storage(), policy, () => time);
  const observed = () => ({ ...snapshot(0, 0, 348), at: time });
  for (let i = 0; i < 8; i++) await ledger.enqueue('project-a', `box${i}`, time + i);
  let started = 0;
  for (let i = 0; i < 8; i++) if ((await ledger.admit('project-a', `box${i}`, observed())).ok) started++;
  assert.ok(started >= 1 && started < 8);
  time += 3_600_000;
  for (let i = 0; i < 8; i++) {
    const result = await ledger.admit('project-a', `box${i}`, observed());
    if (result.ok && !result.recovered) started++;
  }
  assert.ok(started >= 2);
});


test('atomic suite batches larger than initial scaled credit eventually refill and start', async () => {
  let time = now; const small = { ...policy, poolPacing: { ...policy.poolPacing, burst: 4 } };
  const ledger = new AccountLedger(new Storage(), small, () => time);
  const observed = () => ({ ...snapshot(0, 0, 360), at: time });
  await ledger.enqueueBatch('project-a', ['a', 'b']);
  const state = await ledger.storage.get(ledger.key);
  state.dynamicPacing = { at: time, credit: 1, ratePerMs: 20 / 86_400_000, floorStarts: [{ key: 'f1', at: time }, { key: 'f2', at: time }] };
  await ledger.storage.put(ledger.key, state);
  assert.equal((await ledger.admitBatch('project-a', ['a', 'b'], observed())).reason, 'pacing');
  time += 5 * 3_600_000;
  assert.equal((await ledger.admitBatch('project-a', ['a', 'b'], observed())).ok, true);
});

test('rounding residue does not defer a fully earned batch or make credit negative', async () => {
  const storage = new Storage(), ledger = new AccountLedger(storage, policy, () => now);
  await ledger.enqueueBatch('project-a', ['a', 'b']);
  const state = await storage.get(ledger.key);
  state.dynamicPacing = { at: now, credit: 1.9999999999999998, ratePerMs: 1 / 3_600_000 };
  await storage.put(ledger.key, state);
  assert.equal((await ledger.admitBatch('project-a', ['a', 'b'], snapshot())).ok, true);
  assert.equal((await storage.get(ledger.key)).dynamicPacing.credit, 0);
});


test('local settlement bounds and unmatched usage contribute separate conservative horizons', () => {
  const hour = 3_600_000, day = 24 * hour;
  const claims = [
    { status: 'created', at: now - day + 2 * hour - 1, settledAt: now - day + 2 * hour },
    { status: 'created', at: now - day + 3 * hour - 1, settledAt: now - day + 3 * hour },
    { status: 'unknown', at: now - day * 2 },
  ];
  const value = calc(snapshot(0, 0, 10), claims).status;
  assert.equal(value.trackedStarts, 2); assert.equal(value.unmatchedStarts, 8);
  assert.equal(value.nextRollOff, null);
  assert.equal(value.nextTrackedRollOffUpperBound, now + 2 * hour);
  assert.equal(value.remaining.day, 369);
  assert.ok(Math.abs(value.effectiveStartsPerHour - 369 * (0.2 / 2 + 0.8 / 24)) < 1e-9);
  assert.equal(value.matchingAssumption, 'count_overlap_not_verified_by_provider');
  assert.equal(value.hourlyForecast.length, 25);
  assert.equal(value.hourlyForecast[2].estimatedRemainingDay, 370);
  assert.equal(value.hourlyForecast[24].estimatedRemainingDay, 379);
});

test('provider count mismatch selects newest local bounds and holds uncertain claims', () => {
  const hour = 3_600_000, day = 24 * hour;
  const created = h => ({ status: 'created', at: now - day + h * hour - 1, settledAt: now - day + h * hour });
  const claims = [created(1), created(5), created(9), { status: 'pending', at: now - day * 2 }, { status: 'created', at: now - hour, settledAt: now }];
  const value = calc(snapshot(0, 0, 1), claims).status;
  assert.equal(value.trackedStarts, 1); assert.equal(value.unmatchedStarts, 0);
  assert.equal(value.localCountExceedsProvider, true);
  assert.equal(value.nextTrackedRollOffUpperBound, now + 9 * hour);
  assert.equal(value.remaining.day, 375);
  assert.ok(value.hourlyForecast.every(row => row.estimatedStartsPerHour <= 120));
});

test('roll-off forecast clamps near expiry and unresolved starts never become tracked', () => {
  const day = 86_400_000;
  const claims = [{ status: 'created', at: now - day, settledAt: now - day + 1 }, { status: 'unknown', at: now - 200_000_000 }];
  const value = calc(snapshot(0, 0, 1), claims).status;
  assert.equal(value.trackedStarts, 1); assert.equal(value.unmatchedStarts, 0);
  assert.equal(value.effectiveStartsPerHour, 120);
  assert.equal(value.hourlyForecast[24].estimatedRemainingDay, 379);
});


test('floor permits at most two atomic starts per hour above the soft guard, never above hard limits', async () => {
  let time = now; const storage = new Storage(), ledger = new AccountLedger(storage, policy, () => time);
  const snap = (minute = 0, hour = 0, day = 380) => ({ ...snapshot(minute, hour, day), at: time });
  for (const key of ['a', 'b', 'c']) await ledger.enqueue('project-a', key);
  const first = await Promise.all([ledger.admit('project-a', 'a', snap()), ledger.admit('project-a', 'b', snap())]);
  assert.equal(first.filter(v => v.ok).length, 2);
  assert.equal((await ledger.admit('project-a', 'c', snap())).reason, 'day_cap');
  time += 3_600_001;
  assert.equal((await ledger.admit('project-a', 'c', snap(24))).reason, 'minute_cap');
  assert.equal((await ledger.admit('project-a', 'c', snap(0, 120))).reason, 'hour_cap');
  assert.equal((await ledger.admit('project-a', 'c', snap(0, 0, 400))).reason, 'day_cap');
  assert.equal((await ledger.admit('project-a', 'c', snap())).ok, true);
});

test('a cancelled or conclusively failed floor claim releases its reservation', async () => {
  const storage = new Storage(), ledger = new AccountLedger(storage, policy, () => now);
  const snap = snapshot(0, 0, 380);
  await ledger.enqueue('project-a', 'a'); await ledger.enqueue('project-a', 'b');
  assert.equal((await ledger.admit('project-a', 'a', snap)).ok, true);
  assert.equal((await ledger.admit('project-a', 'a', snap)).recovered, true);
  assert.equal(await ledger.cancelPending('project-a', 'a'), true);
  assert.equal((await ledger.admit('project-a', 'b', snap)).ok, true);
  await ledger.begin('project-a', 'b'); await ledger.resolve('b', 'not_created');
  const state = await storage.get(ledger.key);
  assert.equal(state.dynamicPacing.floorStarts.length, 0);
});

test('floor status exposes separately guarded and hard headroom', () => {
  const value = calc(snapshot(0, 0, 390)).status;
  assert.equal(value.softRemaining.day, 0); assert.equal(value.hardRemaining.day, 10);
  assert.equal(value.floorLimitPerHour, 2); assert.equal(value.floorRemainingLastHour, 2);
  assert.equal(value.baseStartsPerHour, 0); assert.equal(value.effectiveStartsPerHour, 2);
  assert.equal(value.hardLimitBlocked, false); assert.equal(value.hourlyForecast[0].estimatedStartsPerHour, 2);
  const full = calc(snapshot(0, 0, 400)).status;
  assert.equal(full.hardLimitBlocked, true); assert.equal(full.effectiveStartsPerHour, 0);
  assert.equal(full.hourlyForecast[0].estimatedStartsPerHour, 0);
});

test('last daily slot is reserved exactly once even for concurrent floor requests', async () => {
  const ledger = new AccountLedger(new Storage(), policy, () => now), snap = snapshot(0, 0, 399);
  await ledger.enqueue('project-a', 'a', now - 1); await ledger.enqueue('project-b', 'b', now);
  const values = await Promise.all([ledger.admit('project-a', 'a', snap), ledger.admit('project-b', 'b', snap)]);
  assert.equal(values.filter(value => value.ok).length, 1);
  assert.equal(values.find(value => !value.ok).reason, 'day_cap');
});

test('the configured hard reserve cannot be consumed by floor starts', async () => {
  const work = { ...policy, starts: { minute: 36, hour: 180, day: 600 }, windowMargins: { minute: 0, hour: 0, day: 0 }, dayReserve: 150,
    poolPacing: { enabled: true, mode: 'dynamic', burst: 100, hardDayReserve: 150, floorStartsPerHour: 10 } };
  const snap = { at: now, canStart: true, windows: { minute: { limit: 36, used: 0 }, hour: { limit: 180, used: 0 }, day: { limit: 600, used: 449 } } };
  const store = new Storage(), ledger = new AccountLedger(store, work, () => now);
  await ledger.enqueue('project-a', 'a'); await ledger.enqueue('project-b', 'b');
  const results = await Promise.all([ledger.admit('project-a', 'a', snap), ledger.admit('project-b', 'b', snap)]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).reason, 'day_cap');
  const exhausted = dynamicPacing({ snapshot: { ...snap, windows: { ...snap.windows, day: { limit: 600, used: 450 } } }, policy: work, claims: [], now }).status;
  assert.equal(exhausted.hardRemaining.day, 0);
  assert.equal(exhausted.effectiveStartsPerHour, 0);
  assert.equal(exhausted.floorLimitPerHour, 10);
  const scarce = dynamicPacing({ snapshot: { ...snap, windows: { ...snap.windows, day: { limit: 600, used: 440 } } }, policy: work, claims: [], now }).status;
  assert.equal(scarce.effectiveStartsPerHour, 10);
  assert.equal(scarce.hardRemaining.day, 10);
});

test('the account owned-start cap is shared by projects', async () => {
  const store = new Storage(), ledger = new AccountLedger(store, { ...policy, maxOwnedStartsPerDay: 1 }, () => now);
  await ledger.enqueue('project-a', 'a'); await ledger.enqueue('project-b', 'b');
  const results = await Promise.all([ledger.admit('project-a', 'a', snapshot()), ledger.admit('project-b', 'b', snapshot())]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.equal(results.find(result => !result.ok).reason, 'owned_day_cap');
  const status = dynamicPacing({ snapshot: snapshot(0, 0, 1), policy: { ...policy, maxOwnedStartsPerDay: 1 }, claims: [{ status: 'created', at: now - 100, settledAt: now - 50 }], now }).status;
  assert.equal(status.hardRemaining.day, 0);
  assert.equal(status.effectiveStartsPerHour, 0);
  const fresh = dynamicPacing({ snapshot: snapshot(0, 0, 6), policy: { ...policy, maxOwnedStartsPerDay: 150, poolPacing: { ...policy.poolPacing, burst: 100 } }, claims: [], now }).status;
  assert.equal(fresh.burstCredit, 100);
});

test('paid or unknown next-start prices fail closed when paid starts are disabled', async () => {
  const ledger = new AccountLedger(new Storage(), { ...policy, forbidPaidStarts: true }, () => now);
  await ledger.enqueue('project-a', 'a');
  assert.equal((await ledger.admit('project-a', 'a', snapshot())).reason, 'paid_start_refused');
  assert.equal((await ledger.admit('project-a', 'a', { ...snapshot(), nextStartDollars: 0.05 })).reason, 'paid_start_refused');
  assert.equal((await ledger.admit('project-a', 'a', { ...snapshot(), nextStartDollars: 0 })).ok, true);
});


test('forecast clears full minute and hour windows after an hour with no new starts', () => {
  const status = calc(snapshot(24, 120, 390)).status;
  assert.equal(status.hardLimitBlocked, true);
  assert.equal(status.hourlyForecast[0].estimatedStartsPerHour, 0);
  assert.equal(status.hourlyForecast[0].estimatedHardRemainingDay, 10);
  assert.equal(status.hourlyForecast[1].estimatedStartsPerHour, 2);
  assert.equal(status.hourlyForecast[1].estimatedHardRemainingDay, 10);
});


test('unpaced admission ignores soft credit and margins but retains provider and reserved caps', async () => {
  const unpaced = { ...policy, poolPacing: { ...policy.poolPacing, unpaced: true, burst: 1 } };
  const ledger = new AccountLedger(new Storage(), unpaced, () => now);
  for (const key of ['a', 'b', 'c', 'd']) {
    await ledger.enqueue('project-a', key);
    assert.equal((await ledger.admit('project-a', key, snapshot(0, 0, 380))).ok, true);
  }
  const blocked = new AccountLedger(new Storage(), unpaced, () => now);
  await blocked.enqueue('project-a', 'x');
  assert.equal((await blocked.admit('project-a', 'x', snapshot(24))).reason, 'minute_cap');
  const reserved = new AccountLedger(new Storage(), { ...unpaced, poolPacing: { ...unpaced.poolPacing, hardDayReserve: 150 } }, () => now);
  await reserved.enqueue('project-a', 'x');
  assert.equal((await reserved.admit('project-a', 'x', snapshot(0, 0, 250))).reason, 'day_cap');
});

const paidPolicy = { ...policy, starts: { ...policy.starts, allowPaidExtra: true, paidExtraMaxDollarsPerMonth: 2 }, poolPacing: { ...policy.poolPacing, floorOverflowPerHour: 1 } };
const paidLimits = (used = 380) => ({ observedAt: now, canStart: true, nextStartDollars: 0.03, billingStatus: 'active', startLimits: { perMinute: 24, perHour: 120, perDay: 200 }, starts: { minute: { limit: 24, used: 0 }, hour: { limit: 120, used: 0 }, day: { limit: 200, used } } });
const paidSnap = used => ({ ...snapshotLimits(paidLimits(used), now), at: now });
const spentFloor = async (policy, used = 380) => {
  const storage = new Storage();
  await storage.put('account:ledger', { claims: {}, waiting: [], dynamicPacing: { at: now, credit: 0, ratePerMs: 0, floorStarts: [{ key: 'a', at: now }, { key: 'b', at: now }], floorOverflow: [] } });
  const ledger = new AccountLedger(storage, policy, () => now);
  await ledger.enqueue('project-a', 'c', now - 1);
  return { result: await ledger.admit('project-a', 'c', paidSnap(used), { pool: true }), storage };
};

test('a spent floor lets one billed start per hour through while the day window is empty', async () => {
  const ledger = new AccountLedger(new Storage(), paidPolicy, () => now), snap = paidSnap();
  for (const key of ['a', 'b', 'c', 'd']) await ledger.enqueue('project-a', key, now - 1);
  assert.equal((await ledger.admit('project-a', 'a', snap, { pool: true })).ok, true);
  assert.equal((await ledger.admit('project-a', 'b', snap, { pool: true })).ok, true);
  assert.equal((await ledger.admit('project-a', 'c', snap, { pool: true })).ok, true, 'the emergency start covers a queued job');
  assert.equal((await ledger.admit('project-a', 'd', snap, { pool: true })).reason, 'day_cap', 'only one emergency start per hour');
  const state = await ledger.storage.get(ledger.key);
  assert.equal(state.dynamicPacing.floorStarts.length, 2);
  assert.equal(state.dynamicPacing.floorOverflow.length, 1);
  assert.equal(state.paidExtraSpend.length, 3, 'every start past the free window is billed, the floor ones included');
});

test('the emergency floor start still obeys the paid budget, the opt-in, the override and the hard ceiling', async () => {
  assert.equal((await spentFloor(paidPolicy)).result.ok, true);
  assert.equal((await spentFloor({ ...paidPolicy, starts: { ...paidPolicy.starts, paidExtraMaxDollarsPerMonth: 0 } })).result.reason, 'paid_extra_budget');
  assert.equal((await spentFloor({ ...paidPolicy, starts: { ...paidPolicy.starts, allowPaidExtra: false } })).result.reason, 'day_cap');
  assert.equal((await spentFloor({ ...paidPolicy, poolPacing: { ...paidPolicy.poolPacing, floorOverflowPerHour: 0 } })).result.reason, 'day_cap');
  assert.equal((await spentFloor(paidPolicy, 400)).result.reason, 'day_cap', 'the hard ceiling never moves');
});

test('floor status reports the emergency starts and carries them forward', () => {
  const value = dynamicPacing({ snapshot: paidSnap(), policy: paidPolicy, claims: [], previous: null, now }).status;
  assert.equal(value.floorOverflowLimitPerHour, 1);
  assert.equal(value.floorOverflowUsedLastHour, 0);
  assert.equal(value.floorOverflowRemainingLastHour, 1);
  const previous = { at: now - 1000, credit: 0, ratePerMs: 0, floorStarts: [], floorOverflow: [{ key: 'a', at: now - 1000 }] };
  const carried = dynamicPacing({ snapshot: paidSnap(), policy: paidPolicy, claims: [], previous, now }).status;
  assert.equal(carried.floorOverflowUsedLastHour, 1);
  assert.equal(carried.floorOverflowRemainingLastHour, 0);
  assert.equal(dynamicPacing({ snapshot: paidSnap(), policy: paidPolicy, claims: [], previous: { ...previous, floorOverflow: [{ key: 'a', at: now + 1 }] }, now }), null);
});
