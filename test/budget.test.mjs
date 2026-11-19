import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Budget } from '../src/budget.mjs';
import { Storage } from './helpers.mjs';

function fixture(env = {}) {
  const clock = { now: 100_000_000 };
  const storage = new Storage();
  const config = { START_PACING: 'true', MAX_ACTIVE: '100', MAX_STARTS_PER_DAY: '200', ...env };
  const limits = { canStart: true, maxActiveSandboxes: 100, activeSandboxes: 0,
    startLimits: { perMinute: 12, perHour: 60, perDay: 200 }, starts: {
      minute: { limit: 12, used: 0, remaining: 12 }, hour: { limit: 60, used: 0, remaining: 60 }, day: { limit: 200, used: 0, remaining: 200 },
    } };
  const budget = new Budget(storage, config, () => clock.now);
  const admit = key => budget.admit(key, { ...limits, observedAt: clock.now });
  return { clock, storage, config, limits, budget, admit };
}

test('live caps retain a ten percent margin and leave half-window burst tokens', async () => {
  const f = fixture();
  assert.equal((await f.admit('first')).ok, true);
  const state = await f.budget.status();
  assert.deepEqual(Object.values(state.windows).map(w => w.safe_cap), [10, 54, 180]);
  assert.equal(state.tokens.hour.capacity, 27);
  assert.equal(state.tokens.day.capacity, 90);
});

test('simultaneous admissions cannot exceed the rolling minute margin', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 30 }, (_, n) => f.admit(`key-${n}`)));
  assert.equal(results.filter(r => r.ok).length, 10);
  assert.equal(results.at(-1).reason, 'minute_headroom');
  f.clock.now += 60_000;
  assert.equal((await f.admit('next-minute')).ok, true);
});

test('hour and day token buckets pace bursts without consuming refused tokens', async () => {
  const f = fixture({ START_HOUR_BURST: '1', START_DAY_BURST: '2' });
  await f.admit('first');
  assert.equal((await f.admit('hour-block')).reason, 'hour_pacing');
  f.clock.now += 3600_000 / 54 + 1;
  assert.equal((await f.admit('second')).ok, true);
  f.clock.now += 3600_000 / 54 + 1;
  assert.equal((await f.admit('day-block')).reason, 'day_pacing');
  f.clock.now += 86400_000 / 180;
  assert.equal((await f.admit('later')).ok, true);
});

test('rolling hour and day guards include provider starts and cross calendar boundaries', async () => {
  for (const [window, used] of [['hour', 54], ['day', 180]]) {
    const f = fixture();
    f.limits.starts[window].used = used;
    f.limits.starts[window].remaining -= used;
    assert.equal((await f.admit('held')).reason, `${window}_headroom`);
    f.clock.now += 60_000;
    assert.equal((await f.admit('still-held')).ok, false);
  }
});

test('snapshot reservations are atomic across restart and idempotent keys spend once', async () => {
  const f = fixture();
  await f.admit('uncertain');
  const before = (await f.storage.get('start-budget')).tokens;
  const restarted = new Budget(f.storage, f.config, () => f.clock.now);
  f.limits.canStart = false;
  assert.equal((await restarted.admit('uncertain', f.limits)).recovered, true);
  assert.deepEqual((await f.storage.get('start-budget')).tokens, before);
  assert.equal((await restarted.admit('other', f.limits)).ok, false);
});

test('external starts and concurrent snapshots cannot spend the same provider headroom', async () => {
  const f = fixture();
  f.limits.starts.day.used = 178; f.limits.starts.day.remaining = 22;
  const observed = { ...f.limits, observedAt: f.clock.now };
  const values = await Promise.all(['one', 'two', 'three'].map(key => f.budget.admit(key, observed)));
  assert.equal(values.filter(v => v.ok).length, 2);
  assert.equal(values.at(-1).reason, 'day_headroom');
});

test('pacing fails closed for missing and stale live windows without charging a start', async () => {
  const f = fixture();
  const missing = structuredClone(f.limits); delete missing.starts.day;
  assert.equal((await f.budget.admit('missing', missing)).reason, 'limits_unavailable');
  assert.equal((await f.budget.admit('stale', { ...f.limits, observedAt: f.clock.now - 30_001 })).reason, 'limits_unavailable');
  assert.equal((await f.storage.list({ prefix: 'start-claim:' })).size, 0);
});

test('unknown pending slots and provider machines leave no concurrency oversubscription', async () => {
  const f = fixture({ MAX_ACTIVE: '2' });
  for (const id of ['a', 'b', 'provisional']) await f.storage.put(`slot:${id}`, id);
  assert.equal((await f.admit('held')).reason, 'concurrency');
  await f.storage.delete('slot:provisional');
  f.limits.activeSandboxes = 2;
  assert.equal((await f.admit('provider-held')).reason, 'concurrency');
});

test('reuse without pacing retains native calendar guards and provider admission', async () => {
  const f = fixture({ START_PACING: 'false', MAX_STARTS_PER_DAY: '1' });
  assert.equal((await f.admit('one')).ok, true);
  assert.equal((await f.admit('two')).reason, 'day_guard');
});

test('a plan cap of one permits no start when the cap must never be reached', async () => {
  const f = fixture();
  f.limits.startLimits.perDay = 1;
  f.limits.starts.day = { limit: 1, used: 0, remaining: 1 };
  assert.equal((await f.admit('held')).reason, 'day_headroom');
});

test('four days of bursts never reach an hourly or daily plan cap across restarts', async () => {
  const f = fixture();
  const starts = [];
  for (let minute = 0; minute < 4 * 24 * 60; minute += 2) {
    f.clock.now = 100_000_000 + minute * 60_000;
    if (minute % 60 === 0) f.budget = new Budget(f.storage, f.config, () => f.clock.now);
    for (let n = 0; n < 5; n++) {
      const result = await f.budget.admit(`${minute}-${n}`, { ...f.limits, observedAt: f.clock.now });
      if (result.ok) starts.push(f.clock.now);
    }
    for (const [span, cap] of [[60_000, 10], [3600_000, 54], [86400_000, 180]]) {
      assert.ok(starts.filter(at => at > f.clock.now - span).length <= cap);
    }
  }
  assert.ok(starts.length > 500);
});

test('a lower live plan cap reduces headroom before another start is attempted', async () => {
  const f = fixture();
  await f.admit('old-plan');
  f.limits.startLimits.perDay = 10;
  f.limits.starts.day = { limit: 10, used: 9, remaining: 1 };
  assert.equal((await f.admit('new-plan')).reason, 'day_headroom');
  assert.equal((await f.budget.status()).windows.day.safe_cap, 9);
});
