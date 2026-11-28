// A client reads one canonical reason and, when it asks for support, the exact
// internal string that produced it. The list is closed: a new internal reason
// never reaches a client as an unknown token.
export const PENDING_REASONS = Object.freeze([
  'pool_full',
  'budget_exhausted',
  'starting',
  'pool_disabled',
  'snapshot_unavailable',
  'start_capacity',
]);

const CANONICAL = Object.freeze({
  lease_cap: 'pool_full',
  concurrency: 'pool_full',
  spend_budget: 'budget_exhausted',
  pool_disabled: 'pool_disabled',
  client_disabled: 'pool_disabled',
  ci_snapshot_unavailable: 'snapshot_unavailable',
  snapshot_unavailable: 'snapshot_unavailable',
  start_capacity: 'start_capacity',
});

// Everything else is a lease still on its way: a reservation, a start the
// client should retry, or a warm box being prepared.
export function canonicalPendingReason(detail) {
  if (typeof detail !== 'string' || !detail) return 'starting';
  return CANONICAL[detail] ?? 'starting';
}
