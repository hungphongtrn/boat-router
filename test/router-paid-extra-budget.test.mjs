// A paid extra start is billed per start. `starts.paidExtraMaxDollarsPerMonth`
// caps the rolling 30-day spend: a start that would take the sum past the cap
// waits as `paid_extra_budget` until the oldest record ages out. A free start
// is never counted and never refused, and an account without the budget keeps
// today's behaviour.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AccountLedger, snapshotLimits } from '../src/router/ledger.mjs';
import { PAID_EXTRA_MAX_DOLLARS, PAID_EXTRA_WINDOW_MS } from '../src/router/paid-extra.mjs';

const start = 1_000_000_000;
const base = { starts: { minute: 12, hour: 60, day: 260 }, margin: 0.1, dayReserve: 0, poolPacing: { enabled: true, mode: 'dynamic', burst: 40, reserveStarts: 0 } };
// Boat's reading when the free day allowance is gone: 217 used of 200, no
// remaining day starts, a non-zero next-start price, credit still positive.
const limits = (at, { used = 217, price = 0.03, omitPrice = false } = {}) => ({
  observedAt: at, canStart: true, ...(omitPrice ? {} : { nextStartDollars: price }), billingStatus: 'active', creditBalanceHours: 802,
  machineTypes: [{ type: 'default', available: true }],
  startLimits: { perMinute: 12, perHour: 60, perDay: 200 },
  starts: {
    minute: { limit: 12, used: 0, remaining: 12 },
    hour: { limit: 60, used: 0, remaining: 60 },
    day: { limit: 200, used, remaining: Math.max(0, 200 - used) },
  },
});

function fixture({ cap = 2, allowPaidExtra = true } = {}) {
  let time = start;
  const storage = new Storage();
  const policy = { ...base, starts: { ...base.starts, allowPaidExtra, ...(cap == null ? {} : { paidExtraMaxDollarsPerMonth: cap }) } };
  const ledger = new AccountLedger(storage, policy, () => time);
  const admit = async (key, options) => {
    await ledger.enqueue('project', key, time - 1, undefined, { pool: true });
    return ledger.admit('project', key, snapshotLimits(limits(time, options), time), { pool: true });
  };
  return { ledger, storage, policy, admit, now: () => time, setTime: value => { time = value; } };
}

test('a paid extra under the cap admits and records its price', async () => {
  const f = fixture();
  assert.equal((await f.admit('a')).ok, true);
  assert.deepEqual(await f.ledger.paidExtraStatus(), { capUsd: 2, spentUsd: 0.03, starts: 1, nextRollOffAt: start + PAID_EXTRA_WINDOW_MS });
});

test('a start that would take the 30-day sum past the cap waits as paid_extra_budget', async () => {
  const f = fixture({ cap: 0.05 });
  assert.equal((await f.admit('a')).ok, true);
  f.setTime(start + 1000);
  const refused = await f.admit('b');
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'paid_extra_budget');
  assert.equal(refused.nextAt, start + PAID_EXTRA_WINDOW_MS, 'the oldest record rolls off a month after its start');
  assert.deepEqual(await f.ledger.paidExtraStatus(), { capUsd: 0.05, spentUsd: 0.03, starts: 1, nextRollOffAt: start + PAID_EXTRA_WINDOW_MS });
  assert.equal((await f.ledger.claim('b')), null, 'a refused start holds no claim');
});

test('a record ages out after 30 days', async () => {
  const f = fixture({ cap: 0.05 });
  assert.equal((await f.admit('a')).ok, true);
  assert.equal((await f.admit('b')).reason, 'paid_extra_budget');
  f.setTime(start + PAID_EXTRA_WINDOW_MS + 1);
  assert.equal((await f.admit('b')).ok, true, 'the oldest record no longer counts');
  assert.deepEqual(await f.ledger.paidExtraStatus(), { capUsd: 0.05, spentUsd: 0.03, starts: 1, nextRollOffAt: start + PAID_EXTRA_WINDOW_MS + 1 + PAID_EXTRA_WINDOW_MS });
});

test('an unknown price counts as the worst case', async () => {
  assert.equal(PAID_EXTRA_MAX_DOLLARS, 0.07);
  const f = fixture({ cap: 0.07 });
  assert.equal((await f.admit('a', { omitPrice: true })).ok, true, 'an omitted price costs the ceiling');
  assert.deepEqual(await f.ledger.paidExtraStatus(), { capUsd: 0.07, spentUsd: 0.07, starts: 1, nextRollOffAt: start + PAID_EXTRA_WINDOW_MS });
  assert.equal((await f.admit('b', { omitPrice: true })).reason, 'paid_extra_budget');
});

test('a free start is never counted or refused', async () => {
  const f = fixture({ cap: 0.01 });
  assert.equal((await f.admit('a', { price: 0.01 })).ok, true, 'the budget is spent');
  assert.equal((await f.admit('free', { used: 0, price: 0 })).ok, true, 'a free start ignores the budget');
  assert.deepEqual(await f.ledger.paidExtraStatus(), { capUsd: 0.01, spentUsd: 0.01, starts: 1, nextRollOffAt: start + PAID_EXTRA_WINDOW_MS });
});

test('an account without the budget keeps today behaviour and records nothing', async () => {
  const f = fixture({ cap: null });
  assert.equal((await f.admit('a')).ok, true);
  assert.equal((await f.admit('b')).ok, true);
  assert.deepEqual(await f.ledger.paidExtraStatus(), { capUsd: null, spentUsd: 0, starts: 0, nextRollOffAt: null });
  assert.equal((await f.storage.get(f.ledger.key)).paidExtraSpend, undefined);
});

test('a budget without the opt-in changes nothing', async () => {
  const run = async starts => {
    let time = start;
    const storage = new Storage();
    const ledger = new AccountLedger(storage, { ...base, starts: { ...base.starts, ...starts } }, () => time);
    await ledger.enqueue('project', 'key', time - 1, undefined, { pool: true });
    const result = await ledger.admit('project', 'key', snapshotLimits(limits(time), time), { pool: true });
    return JSON.stringify({ result, state: await storage.get(ledger.key) });
  };
  assert.equal(await run({}), await run({ paidExtraMaxDollarsPerMonth: 2 }));
  assert.equal(JSON.parse(await run({ paidExtraMaxDollarsPerMonth: 2 })).result.reason, 'day_cap');
});
