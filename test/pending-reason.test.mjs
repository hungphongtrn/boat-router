import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalPendingReason, PENDING_REASONS } from '../src/router/pending-reason.mjs';

test('every internal pending reason maps to one canonical token', () => {
  const mapping = {
    lease_cap: 'pool_full',
    concurrency: 'pool_full',
    spend_budget: 'budget_exhausted',
    pool_disabled: 'pool_disabled',
    client_disabled: 'pool_disabled',
    ci_snapshot_unavailable: 'snapshot_unavailable',
    snapshot_unavailable: 'snapshot_unavailable',
    start_capacity: 'start_capacity',
    reservation_pending: 'starting',
    lease_expired: 'starting',
    lease_pool_preparing: 'starting',
    ci_demand_or_snapshot: 'starting',
    deferred_ci_warm_only: 'starting',
    client_cap: 'starting',
    fairness: 'starting',
  };
  for (const [detail, reason] of Object.entries(mapping)) {
    assert.equal(canonicalPendingReason(detail), reason, detail);
    assert.ok(PENDING_REASONS.includes(canonicalPendingReason(detail)), detail);
  }
});

test('a missing or unknown detail still yields a canonical reason', () => {
  for (const detail of [undefined, null, '', 0, {}, 'something_new']) {
    assert.equal(canonicalPendingReason(detail), 'starting');
  }
});
