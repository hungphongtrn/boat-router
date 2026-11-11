import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';

const config = { enabled: true, afterWaitMinutes: 15, maxPaidStartsPerDay: 2, minSecondsBetweenPaid: 0, pricePerStartUsd: 0.05 };
function fixture(paidOverflow = config) {
  let time = 10_000_000;
  const storage = new Storage(), ledger = new AccountLedger(storage, { paidOverflow }, () => time);
  const snapshot = () => ({ at: time, canStart: true, windows: { minute: { limit: 100, used: 0 }, hour: { limit: 100, used: 0 }, day: { limit: 10, used: 10 } } });
  return { ledger, storage, snapshot, setTime: n => { time = n; }, now: () => time, tick: () => { ledger.paidTick = { used: false }; } };
}

test('paid overflow waits, preserves fairness, admits once per tick and rolls its cap', async () => {
  const f = fixture(), { ledger } = f; f.tick();
  await ledger.enqueue('first', 'a', f.now() - 899_999, undefined, { pool: true });
  await ledger.enqueue('second', 'b', f.now() - 899_998, undefined, { pool: true });
  assert.equal((await ledger.admit('first', 'a', f.snapshot(), { pool: true })).reason, 'day_cap');
  f.setTime(f.now() + 2);
  assert.equal((await ledger.admit('second', 'b', f.snapshot(), { pool: true })).reason, 'fairness');
  assert.equal((await ledger.admit('first', 'a', f.snapshot(), { pool: true })).paid, true);
  assert.equal((await ledger.claim('a')).paid, true);
  assert.equal((await ledger.admit('second', 'b', f.snapshot(), { pool: true })).reason, 'day_cap');
  await ledger.begin('first', 'a'); await ledger.resolve('a', 'created');
  f.tick(); assert.equal((await ledger.admit('second', 'b', f.snapshot(), { pool: true })).paid, true);
  await ledger.begin('second', 'b'); await ledger.resolve('b', 'created');
  await ledger.enqueue('first', 'c', f.now() - 900_000, undefined, { pool: true });
  f.tick(); assert.equal((await ledger.admit('first', 'c', f.snapshot(), { pool: true })).reason, 'day_cap');
  assert.deepEqual(await ledger.paidStatus(), { count: 2, estimatedUsd: 0.1 });
  f.setTime(f.now() + 86_400_000); f.tick();
  assert.equal((await ledger.admit('first', 'c', f.snapshot(), { pool: true })).paid, true);
  assert.deepEqual(await ledger.paidStatus(), { count: 1, estimatedUsd: 0.05 });
});

test('disabled matches absent config including state and response bytes', async () => {
  async function run(cfg) {
    const f = fixture(cfg);
    if (cfg === null) f.ledger.policy.paidOverflow = undefined; f.tick();
    await f.ledger.enqueue('first', 'a', 1, undefined, { pool: true });
    const result = await f.ledger.admit('first', 'a', f.snapshot(), { pool: true });
    return JSON.stringify({ result, state: await f.storage.get(f.ledger.key) });
  }
  assert.equal(await run(null), await run({ ...config, enabled: false }));
});

test('paid overflow retains hard short windows and billing guards', async () => {
  const f = fixture(); f.tick(); await f.ledger.enqueue('first', 'a', 1, undefined, { pool: true });
  for (const name of ['minute', 'hour']) {
    const s = f.snapshot(); s.windows[name].used = 100;
    assert.equal((await f.ledger.admit('first', 'a', s, { pool: true })).reason, `${name}_cap`);
  }
  const s = f.snapshot(); s.canStart = false;
  assert.equal((await f.ledger.admit('first', 'a', s, { pool: true })).reason, 'limits_unavailable');
});

test('pacing refusal uses free overflow, and uncertain paid starts remain charged', async () => {
  const f = fixture({ ...config, maxPaidStartsPerDay: 1 });
  f.ledger.policy.poolPacing = { enabled: true, fromPct: 0, burst: 1 };
  await f.storage.put(f.ledger.key, { claims: {}, waiting: [], poolPacing: { tokens: 0, at: f.now() } });
  const snapshot = f.snapshot(); snapshot.windows.day.used = 5;
  await f.ledger.enqueue('first', 'a', 1, undefined, { pool: true });
  f.tick(); assert.equal((await f.ledger.admit('first', 'a', snapshot, { pool: true })).paid, undefined);
  assert.deepEqual(await f.ledger.paidStatus(), { count: 0, estimatedUsd: 0 });
  await f.ledger.begin('first', 'a'); await f.ledger.resolve('a', 'created');
  await f.ledger.enqueue('first', 'paid', 1, undefined, { pool: true });
  f.tick(); assert.equal((await f.ledger.admit('first', 'paid', f.snapshot(), { pool: true })).paid, true);
  await f.ledger.begin('first', 'paid'); await f.ledger.resolve('paid', 'unknown');
  f.setTime(f.now() + 86_400_000);
  await f.ledger.enqueue('first', 'b', 1, undefined, { pool: true });
  f.tick(); assert.equal((await f.ledger.admit('first', 'b', f.snapshot(), { pool: true })).reason, 'day_cap');
  await f.ledger.resolve('paid', 'not_created');
  assert.equal((await f.ledger.admit('first', 'b', f.snapshot(), { pool: true })).paid, true);
});


test('recovered paid reservations cannot start beside another paid start in the same tick', async () => {
  const f = fixture(), { ledger } = f;
  await ledger.enqueue('first', 'a', 1, undefined, { pool: true });
  f.tick(); assert.equal((await ledger.admit('first', 'a', f.snapshot(), { pool: true })).paid, true);
  f.tick();
  assert.equal(await ledger.begin('first', 'a'), true);
  await ledger.enqueue('second', 'b', 2, undefined, { pool: true });
  assert.equal((await ledger.admit('second', 'b', f.snapshot(), { pool: true })).reason, 'day_cap');
  f.tick();
  assert.equal((await ledger.admit('second', 'b', f.snapshot(), { pool: true })).paid, true);
});

test('a recovered paid reservation waits when another paid start already used the tick', async () => {
  const f = fixture(), { ledger } = f;
  await ledger.enqueue('first', 'a', 1, undefined, { pool: true });
  f.tick(); assert.equal((await ledger.admit('first', 'a', f.snapshot(), { pool: true })).paid, true);
  await ledger.enqueue('second', 'b', 2, undefined, { pool: true });
  f.tick(); assert.equal((await ledger.admit('second', 'b', f.snapshot(), { pool: true })).paid, true);
  assert.equal(await ledger.begin('first', 'a'), false);
  assert.equal(await ledger.begin('second', 'b'), true);
  f.tick(); assert.equal(await ledger.begin('first', 'a'), true);
});

test('router ticks start at most one paid reservation across projects', async () => {
  const { Router } = await import('../src/router/core.mjs');
  const storage = new Storage(), now = () => 10_000_000, started = [];
  const snapshot = { at: now(), canStart: true, windows: { minute: { limit: 100, used: 0 }, hour: { limit: 100, used: 0 }, day: { limit: 10, used: 10 } } };
  const suites = ['first', 'second'].map((id, index) => ({
    config: { id, repo: `owner/${id}`, account: 'secondary', reuse: { mode: 'off' }, labels: [], jobs: {}, landing: { engine: 'runner' } },
    hooks: {},
    admissionEntries: async ({ ledger }) => await ledger.claim(id) ? [] : [{ key: id, at: index, rank: id }],
    admitStart: async (key, { ledger }) => {
      const result = await ledger.admit(id, key, snapshot, { pool: true });
      if (result.ok && await ledger.begin(id, key)) { started.push(id); await ledger.resolve(key, 'created'); }
    },
    tick: async () => {},
  }));
  const router = new Router(storage, { id: 'secondary', paidOverflow: config }, suites, { now });
  await router.ledger.enqueue('first', 'first', 1, undefined, { pool: true });
  await router.ledger.enqueue('second', 'second', 2, undefined, { pool: true });
  await router.tick(); assert.deepEqual(started, ['first']);
  await router.tick(); assert.deepEqual(started, ['first', 'second']);
});


test('paid starts keep the default 60 second interval across ticks and ledger restarts', async () => {
  const f = fixture({ ...config, minSecondsBetweenPaid: undefined });
  await f.ledger.enqueue('first', 'a', 1, undefined, { pool: true });
  f.tick(); assert.equal((await f.ledger.admit('first', 'a', f.snapshot(), { pool: true })).paid, true);
  assert.equal(await f.ledger.begin('first', 'a'), true);
  await f.ledger.resolve('a', 'created');
  await f.ledger.enqueue('first', 'b', 2, undefined, { pool: true });
  const restarted = new AccountLedger(f.storage, f.ledger.policy, f.now);
  restarted.paidTick = { used: false };
  f.setTime(f.now() + 59_999);
  assert.equal((await restarted.admit('first', 'b', f.snapshot(), { pool: true })).reason, 'day_cap');
  f.setTime(f.now() + 1);
  assert.equal((await restarted.admit('first', 'b', f.snapshot(), { pool: true })).paid, true);
  assert.equal(await restarted.begin('first', 'b'), true);
});

test('unobserved free reservations do not count as confirmed daily exhaustion', async () => {
  const f = fixture();
  const snapshot = f.snapshot(); snapshot.windows.day.used = 9;
  await f.storage.put(f.ledger.key, { claims: { other: { project: 'first', at: f.now(), status: 'calling' } }, waiting: [] });
  await f.ledger.enqueue('first', 'a', 1, undefined, { pool: true });
  f.tick();
  assert.equal((await f.ledger.admit('first', 'a', snapshot, { pool: true })).reason, 'day_cap');
  assert.deepEqual(await f.ledger.paidStatus(), { count: 0, estimatedUsd: 0 });
});
