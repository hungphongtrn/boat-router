import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BREAKER_WINDOW_MS, BREAKER_PROBE_DELAY_MS, currentBreaker, breakerCanProbe, recordBreakerOutcome, reserveBreakerProbe, releaseBreakerProbe } from '../src/router/verification-breaker.mjs';

async function outcome(storage, box, ok, at, now = at) {
  return storage.transaction(tx => recordBreakerOutcome(tx, { box, ok, at, now, threshold: 3 }));
}
const box = (id, size = 'large') => ({ machineId: id, createKey: id, size, generation: 0 });

test('failures must occur within the window and after the most recent success', async () => {
  const storage = new Storage(), start = 2_000_000;
  await outcome(storage, box('a'), false, start);
  await outcome(storage, box('b'), false, start + 1);
  await outcome(storage, box('c'), false, start + BREAKER_WINDOW_MS + 1);
  assert.equal((await storage.get('verification:breaker')).counts.large, 2);
  await outcome(storage, box('success'), true, start + BREAKER_WINDOW_MS + 2);
  await outcome(storage, box('late-old-job'), true, start, start + BREAKER_WINDOW_MS + 3);
  await outcome(storage, box('d'), false, start + BREAKER_WINDOW_MS + 4);
  await outcome(storage, box('stale-success'), true, start + BREAKER_WINDOW_MS + 2, start + BREAKER_WINDOW_MS + 5);
  assert.equal((await storage.get('verification:breaker')).counts.large, 1);
  await outcome(storage, box('e'), false, start + BREAKER_WINDOW_MS + 6);
  const trip = await outcome(storage, box('f'), false, start + BREAKER_WINDOW_MS + 7);
  assert.equal(trip.opened, true);
  assert.equal(trip.breaker.tripped, true);
});

test('success for one size does not erase another size failures', async () => {
  const storage = new Storage(), t = 2_000_000;
  await outcome(storage, box('a'), false, t);
  await outcome(storage, box('b', 'default'), true, t + 1);
  await outcome(storage, box('c'), false, t + 2);
  assert.equal((await outcome(storage, box('d'), false, t + 3)).opened, true);
});

test('half-open permits one ledger key and successful probe clears the latch', async () => {
  const storage = new Storage(), t = 2_000_000;
  for (let i = 0; i < 3; i++) await outcome(storage, box('old' + i), false, t + i);
  const open = await storage.get('verification:breaker'), due = open.trippedAt + BREAKER_PROBE_DELAY_MS;
  assert.equal(breakerCanProbe(open, due - 1), false);
  assert.equal(await reserveBreakerProbe(storage, 'early', due - 1), false);
  const reservations = await Promise.all([reserveBreakerProbe(storage, 'probe-a', due), reserveBreakerProbe(storage, 'probe-b', due)]);
  assert.equal(reservations.filter(Boolean).length, 1);
  const current = await storage.get('verification:breaker');
  await outcome(storage, box('unrelated'), true, due + 1);
  assert.equal((await storage.get('verification:breaker')).tripped, true);
  const recovered = await outcome(storage, box(current.probe.createKey), true, due + 2);
  assert.equal(recovered.cleared, true);
  assert.equal(recovered.breaker.tripped, false);
});

test('a failed probe restarts the hold; a definite refusal can release its reservation', async () => {
  const storage = new Storage(), t = 2_000_000;
  for (let i = 0; i < 3; i++) await outcome(storage, box('old' + i), false, t + i);
  const due = (await storage.get('verification:breaker')).trippedAt + BREAKER_PROBE_DELAY_MS;
  assert.equal(await reserveBreakerProbe(storage, 'probe-a', due), true);
  assert.equal(await releaseBreakerProbe(storage, 'different'), false);
  assert.equal(await releaseBreakerProbe(storage, 'probe-a'), true);
  assert.equal(await reserveBreakerProbe(storage, 'probe-b', due), true);
  const failed = await outcome(storage, box('probe-b'), false, due + 5);
  assert.equal(failed.failedProbe, true);
  assert.equal(await reserveBreakerProbe(storage, 'probe-c', due + 5), false);
  assert.equal(await reserveBreakerProbe(storage, 'probe-c', due + 5 + BREAKER_PROBE_DELAY_MS), true);
});

test('legacy tripped record waits a full delay and remains tripped after unrelated success', async () => {
  const storage = new Storage(), t = 2_000_000;
  await storage.put('verification:breaker', { counts: { large: 3 }, tripped: true });
  const migrated = await currentBreaker(storage, t);
  assert.equal(migrated.trippedAt, t);
  await outcome(storage, box('unrelated'), true, t + 1);
  assert.equal((await storage.get('verification:breaker')).tripped, true);
  assert.equal(await reserveBreakerProbe(storage, 'probe', t + BREAKER_PROBE_DELAY_MS - 1), false);
  assert.equal(await reserveBreakerProbe(storage, 'probe', t + BREAKER_PROBE_DELAY_MS), true);
});

test('manual reset epoch and probe recovery discard old failure windows', async () => {
  const storage = new Storage(), t = 2_000_000;
  await outcome(storage, box('a'), false, t);
  await outcome(storage, box('b'), false, t + 1);
  await storage.put('verification:breaker', { counts: {}, tripped: false, epoch: 'manual-reset' });
  assert.equal((await outcome(storage, box('c'), false, t + 2)).breaker.counts.large, 1);
  await outcome(storage, box('d'), false, t + 3);
  const trip = await outcome(storage, box('e'), false, t + 4);
  const due = trip.breaker.trippedAt + BREAKER_PROBE_DELAY_MS;
  await reserveBreakerProbe(storage, 'probe', due);
  await outcome(storage, box('probe', 'default'), true, due + 1);
  const next = await outcome(storage, box('f'), false, due + 2);
  assert.equal(next.opened, false);
  assert.equal(next.breaker.counts.large, 1);
});

test('a size failure trips only that size and a successful size probe recovers it', async () => {
  const { recordSizedBreakerOutcome, breakerForSize, reserveSizedProbe } = await import('../src/router/verification-breaker.mjs');
  const storage = new Storage(), t = 2_000_000;
  for (let i = 0; i < 3; i++) await storage.transaction(tx => recordSizedBreakerOutcome(tx, { box: box('large-' + i), ok: false, at: t + i, now: t + i }));
  let root = await storage.get('verification:breaker');
  assert.equal(breakerForSize(root, 'large').tripped, true);
  assert.equal(breakerForSize(root, 'default').tripped, false);
  assert.equal(await reserveSizedProbe(storage, 'default', 'unaffected', t + 3), true);
  assert.equal(await reserveSizedProbe(storage, 'large', 'early', t + 3), false);
  const due = t + 2 + BREAKER_PROBE_DELAY_MS;
  assert.equal(await reserveSizedProbe(storage, 'large', 'probe', due), true);
  assert.equal(await reserveSizedProbe(storage, 'large', 'second', due), false);
  await storage.transaction(tx => recordSizedBreakerOutcome(tx, { box: box('probe'), ok: true, at: due + 1, now: due + 1 }));
  root = await storage.get('verification:breaker');
  assert.equal(breakerForSize(root, 'large').tripped, false);
});

test('legacy size latch preserves failure scope and unknown latches remain conservative', async () => {
  const { breakerForSize } = await import('../src/router/verification-breaker.mjs');
  const root = { tripped: true, trippedAt: 1, counts: { large: 3 } };
  assert.equal(breakerForSize(root, 'large').tripped, true);
  assert.equal(breakerForSize(root, 'default').tripped, false);
  assert.equal(breakerForSize({ tripped: true, counts: {} }, 'default').tripped, true);
});
