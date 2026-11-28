// A released lease normally deletes its box. A client that is still debugging may
// ask for a bounded hold instead: the box is kept for that many seconds, the
// provider TTL is shortened to the same bound, and the sweep deletes it at expiry.
export const MAX_KEEP_ON_FAIL_SECONDS = 900;

// Absent means 0, which deletes the box. Only an integer 0..900 is accepted; a
// float, a string, a negative number or anything above the ceiling is a bad body.
export function parseKeepOnFailSeconds(value) {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || value < 0 || value > MAX_KEEP_ON_FAIL_SECONDS) return null;
  return value;
}

export function heldUntil(now, seconds) {
  if (!Number.isFinite(now) || !Number.isInteger(seconds) || seconds < 1 || seconds > MAX_KEEP_ON_FAIL_SECONDS) throw new TypeError('invalid hold');
  return now + seconds * 1000;
}

export function holdActive(lease, now) {
  return lease?.state === 'held' && Number.isFinite(lease.heldUntil) && lease.heldUntil > now;
}
