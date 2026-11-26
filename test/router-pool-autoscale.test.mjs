import test from 'node:test';
import assert from 'node:assert/strict';
import { hoursCeiling, poolTarget } from '../src/router/pool-autoscale.mjs';

const NOW = Date.parse('2026-11-27T00:00:00.000Z');
const days = count => new Date(NOW + count * 86_400_000).toISOString();

test('poolTarget clamps demand between the live floor and ceiling', () => {
  assert.deepEqual(poolTarget({ queued: 0, running: 0, minLive: 1, maxLive: 5 }), { target: 1 });
  assert.deepEqual(poolTarget({ queued: 2, running: 1, minLive: 1, maxLive: 5 }), { target: 3 });
  assert.deepEqual(poolTarget({ queued: 9, running: 0, minLive: 1, maxLive: 5 }), { target: 5 });
  assert.deepEqual(poolTarget({ queued: 0, running: 3, minLive: 2, maxLive: 5 }), { target: 3 });
  assert.deepEqual(poolTarget({ running: 1, minLive: 4, maxLive: 5 }), { target: 4 });
});

test('hoursCeiling floors the ceiling when the last 24h burn exceeds the hours left per day (enforce)', () => {
  const budget = hoursCeiling({ limits: { planIncluded: { vmHoursRemaining: 0, periodEnd: days(10) }, packBalanceHours: 199.55, last24hUsageSeconds: 294907 }, now: NOW, minLive: 1, maxLive: 5, enforce: true });
  assert.equal(budget.ceiling, 1);
  assert.equal(budget.reason, 'hours_budget');
  assert.ok(Math.abs(budget.hoursPerDayLeft - 19.955) < 1e-9);
  assert.ok(Math.abs(budget.last24hHours - 294907 / 3600) < 1e-9);
  assert.equal(budget.vmHoursRemaining, 0);
  assert.equal(budget.packBalanceHours, 199.55);
  assert.equal(budget.daysToPeriodEnd, 10);
});

test('hoursCeiling reports an exceeded budget without flooring the ceiling unless enforcing', () => {
  const limits = { planIncluded: { vmHoursRemaining: 0, periodEnd: days(10) }, packBalanceHours: 199.55, last24hUsageSeconds: 294907 };
  const budget = hoursCeiling({ limits, now: NOW, minLive: 1, maxLive: 5 });
  assert.equal(budget.ceiling, 5);
  assert.equal(budget.reason, 'hours_budget');
  assert.ok(Math.abs(budget.hoursPerDayLeft - 19.955) < 1e-9);
  assert.ok(Math.abs(budget.last24hHours - 294907 / 3600) < 1e-9);
  assert.equal(budget.daysToPeriodEnd, 10);
});

test('hoursCeiling keeps the ceiling at the max when usage is below the remaining allowance', () => {
  const budget = hoursCeiling({ limits: { planIncluded: { vmHoursRemaining: 500, periodEnd: days(10) }, packBalanceHours: 0, last24hUsageSeconds: 10 * 3600 }, now: NOW, minLive: 1, maxLive: 5 });
  assert.equal(budget.ceiling, 5);
  assert.equal(budget.reason, 'work');
  assert.equal(budget.hoursPerDayLeft, 50);
  assert.equal(budget.last24hHours, 10);
});

test('hoursCeiling treats missing limits as unavailable and keeps the max', () => {
  for (const budget of [hoursCeiling({ limits: null, now: NOW, minLive: 1, maxLive: 5 }), hoursCeiling({ now: NOW, minLive: 1, maxLive: 5 })]) {
    assert.equal(budget.ceiling, 5);
    assert.equal(budget.reason, 'hours_unavailable');
    assert.equal(budget.hoursPerDayLeft, null);
    assert.equal(budget.last24hHours, null);
    assert.equal(budget.daysToPeriodEnd, null);
  }
});

test('hoursCeiling treats a missing usage read as unavailable, not as zero burn', () => {
  const budget = hoursCeiling({ limits: { planIncluded: { vmHoursRemaining: 100, periodEnd: days(3) }, packBalanceHours: 10 }, now: NOW, minLive: 1, maxLive: 5 });
  assert.equal(budget.ceiling, 5);
  assert.equal(budget.reason, 'hours_unavailable');
  assert.equal(budget.hoursPerDayLeft, null);
  assert.equal(budget.last24hHours, null);
});

test('hoursCeiling falls back to packBalanceSeconds', () => {
  const budget = hoursCeiling({ limits: { planIncluded: { vmHoursRemaining: 0, periodEnd: days(4) }, packBalanceSeconds: 100 * 3600, last24hUsageSeconds: 3600 }, now: NOW, minLive: 1, maxLive: 5 });
  assert.equal(budget.packBalanceHours, 100);
  assert.equal(budget.hoursPerDayLeft, 25);
  assert.equal(budget.last24hHours, 1);
  assert.equal(budget.reason, 'work');
  assert.equal(budget.ceiling, 5);
});

test('hoursCeiling floors the period-end divisor at a quarter day', () => {
  const budget = hoursCeiling({ limits: { planIncluded: { vmHoursRemaining: 100, periodEnd: days(-1) }, packBalanceHours: 0, last24hUsageSeconds: 3600 }, now: NOW, minLive: 1, maxLive: 5 });
  assert.equal(budget.daysToPeriodEnd, 0.25);
  assert.equal(budget.hoursPerDayLeft, 400);
  assert.equal(budget.reason, 'work');
  assert.equal(budget.ceiling, 5);
});
