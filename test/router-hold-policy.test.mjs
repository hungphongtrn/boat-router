import test from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_POLICY_DEFAULTS, holdDecision, holdPolicyConfig, recentArrivalPerHour, startsPlentiful } from '../src/router/hold-policy.mjs';

const starts = { dayRemaining: 150, hourRemaining: 40 };

test('a box inside its already-paid window is kept even when it has been idle a while', () => {
  const decision = holdDecision({ boxAgeSeconds: 600, idleSeconds: 300, starts, arrivalPerHour: 0 });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, 'paid_window');
  assert.equal(decision.holdSeconds, 3000);
  assert.equal(decision.plentiful, true);
});

test('a box at the end of its paid window retires when starts are plentiful', () => {
  const decision = holdDecision({ boxAgeSeconds: 3600, idleSeconds: 120, starts, arrivalPerHour: 2 });
  assert.equal(decision.keep, false);
  assert.equal(decision.reason, 'starts_plentiful');
  assert.equal(decision.holdSeconds, 0);
  assert.equal(decision.plentiful, true);
});

test('with scarce starts an idle box is kept one paid window while work is queued', () => {
  const scarce = { dayRemaining: 10, hourRemaining: 40 };
  const decision = holdDecision({ boxAgeSeconds: 7200, idleSeconds: 120, queued: 2, starts: scarce, arrivalPerHour: 2 });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, 'queued');
  assert.equal(decision.holdSeconds, HOLD_POLICY_DEFAULTS.paidWindowSeconds);
  assert.equal(decision.plentiful, false);
});

test('with scarce starts an idle box is kept when the arrival rate predicts a job inside the window', () => {
  const scarce = { dayRemaining: 10, hourRemaining: 40 };
  const decision = holdDecision({ boxAgeSeconds: 7200, idleSeconds: 120, queued: 0, starts: scarce, arrivalPerHour: 1 });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, 'arrival_predicted');
  assert.equal(decision.expectedJobs, 1);
});

test('with scarce starts and no queued or predicted work the box retires', () => {
  // 2 starts left in the rolling day against 0.2 jobs/h (4.8 a day) is scarce.
  const scarce = { dayRemaining: 2, hourRemaining: 40 };
  const decision = holdDecision({ boxAgeSeconds: 7200, idleSeconds: 120, queued: 0, starts: scarce, arrivalPerHour: 0.2 });
  assert.equal(decision.keep, false);
  assert.equal(decision.reason, 'scarce_no_demand');
});

test('unknown start budget is never plentiful and unknown arrival does not predict work', () => {
  const decision = holdDecision({ boxAgeSeconds: 7200, idleSeconds: 120, starts: {}, arrivalPerHour: null });
  assert.equal(decision.plentiful, false);
  assert.equal(decision.keep, false);
  assert.equal(decision.reason, 'scarce_no_demand');
});

test('the plentiful margin is the headroom over the recent arrival rate', () => {
  assert.equal(startsPlentiful({ dayRemaining: 150, hourRemaining: 10, arrivalPerHour: 4, margin: 0.5 }), true);
  assert.equal(startsPlentiful({ dayRemaining: 150, hourRemaining: 10, arrivalPerHour: 4, margin: 1 }), false);
  assert.equal(startsPlentiful({ dayRemaining: 96, hourRemaining: 10, arrivalPerHour: 4, margin: 0 }), true);
  assert.equal(startsPlentiful({ dayRemaining: 95, hourRemaining: 10, arrivalPerHour: 4, margin: 0 }), false);
});

test('a full hour window is not plentiful even with a large day budget', () => {
  assert.equal(startsPlentiful({ dayRemaining: 198, hourRemaining: 2, arrivalPerHour: 4, margin: 0 }), false);
});

test('the recent arrival rate counts each job once inside the lookback and ignores missing records', () => {
  const now = 10_000_000;
  const jobs = [
    { id: 1, queuedAt: now - 60_000 },
    { id: 2, queuedAt: now - 120_000 },
    { id: 3, observedAt: now - 180_000 },
    { id: 4, queuedAt: now - 7_200_000 },
    { id: 5, queuedAt: now - 60_000, missing: true },
  ];
  assert.equal(recentArrivalPerHour(jobs, now, 3600), 3);
  assert.equal(recentArrivalPerHour(jobs, now, 1800), 6);
  assert.equal(recentArrivalPerHour([], now, 3600), 0);
  assert.equal(recentArrivalPerHour(null, now, 3600), null);
});

test('a disabled policy keeps the legacy hold', () => {
  const decision = holdDecision({ boxAgeSeconds: 7200, idleSeconds: 120, starts, arrivalPerHour: 0, config: { enabled: false } });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, 'policy_disabled');
  assert.equal(decision.holdSeconds, null);
});

test('project settings override account settings and invalid values are refused', () => {
  const merged = holdPolicyConfig({ reuse: { holdPolicy: { plentifulMargin: 0.5, paidWindowSeconds: 1800 } } }, { reuse: { holdPolicy: { paidWindowSeconds: 2400 } } });
  assert.equal(merged.paidWindowSeconds, 2400);
  assert.equal(merged.plentifulMargin, 0.5);
  assert.throws(() => holdPolicyConfig({}, { reuse: { holdPolicy: { paidWindowSeconds: 0 } } }), TypeError);
  assert.throws(() => holdPolicyConfig({}, { reuse: { holdPolicy: { arrivalLookbackSeconds: 30 } } }), TypeError);
  assert.throws(() => holdPolicyConfig({}, { reuse: { holdPolicy: { scarceWindows: 0 } } }), TypeError);
});
