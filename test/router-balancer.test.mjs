import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scarcity, holdDecision, waitDecision } from '../src/router/balancer.mjs';

const now = Date.parse('2026-10-29T12:00:00Z');
const input = () => ({ observedAt: now, starts: { minute: { limit: 36, used: 3 }, hour: { limit: 180, used: 20 }, day: { limit: 600, used: 540 } }, planIncluded: { vmHoursRemaining: 100, periodEnd: '2026-11-08T12:00:00Z' }, last24hUsageSeconds: 360000 });

test('start and hour scarcity rise as usage approaches the limits', () => {
  const low = input(); low.starts.day.used = 60; low.last24hUsageSeconds = 3600;
  const high = scarcity(input(), now), cheap = scarcity(low, now);
  assert.ok(high.start > cheap.start);
  assert.ok(high.hour > cheap.hour);
  assert.ok(high.start <= 20 && high.hour <= 20);
});

test('stale, incomplete, and future inputs disable adaptation', () => {
  for (const mutate of [x => x.observedAt = now - 31000, x => x.observedAt = now + 1, x => delete x.starts.day, x => delete x.planIncluded.periodEnd, x => delete x.last24hUsageSeconds]) {
    const x = input(); mutate(x); assert.equal(scarcity(x, now), null);
  }
});

test('hold weighs expected arrivals against billed idle time', () => {
  assert.equal(holdDecision({ prices: { start: 2, hour: 1 }, arrivalsPerHour: 2, maxHoldSeconds: 1800 }).seconds, 1800);
  assert.equal(holdDecision({ prices: { start: 0.01, hour: 2 }, arrivalsPerHour: 1, maxHoldSeconds: 1800 }).seconds, 0);
  assert.equal(holdDecision({ prices: null, arrivalsPerHour: 2, maxHoldSeconds: 1800 }).seconds, 0);
});

test('wait observes both delay cost and the deadline', () => {
  const x = { prices: { start: 1, hour: 1 }, waitSeconds: 300, waitedSeconds: 0, maxWaitSeconds: 600, delayCostPerHour: 2 };
  assert.equal(waitDecision(x), true);
  assert.equal(waitDecision({ ...x, delayCostPerHour: 20 }), false);
  assert.equal(waitDecision({ ...x, waitedSeconds: 301 }), false);
  assert.equal(waitDecision({ ...x, prices: null }), false);
});

test('reserving included hours increases the idle-hour price', () => {
  const x = input();
  assert.ok(scarcity(x, now, 30, 50).hour > scarcity(x, now, 30, 0).hour);
  assert.equal(scarcity(x, now, 30, -1), null);
});

test('each rolling start window can independently make starts scarce', () => {
  for (const name of ['minute', 'hour', 'day']) {
    const low = input();
    for (const window of Object.values(low.starts)) window.used = 0;
    const high = structuredClone(low); high.starts[name].used = high.starts[name].limit - 1;
    assert.ok(scarcity(high, now).start > 10);
    assert.ok(scarcity(low, now).start < 1);
  }
});

test('provider remaining counts cannot hide a nearly full start window', () => {
  const x = input();
  for (const window of Object.values(x.starts)) window.used = 0;
  x.starts.minute.remaining = 0;
  assert.ok(scarcity(x, now).start > 10);
  x.starts.minute.remaining = x.starts.minute.limit + 1;
  assert.equal(scarcity(x, now), null);
});
