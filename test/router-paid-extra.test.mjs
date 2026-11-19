// Paid extra starts: Boat accepts starts past the free day allowance and bills
// each one. The account opts in with `starts.allowPaidExtra`; the configured day
// cap becomes the ceiling and a billed next start up to 7 cents is allowed.
// Everything else still refuses: the provider's minute and hour windows,
// `canStart`, checkout, billing status and zero funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AccountLedger, snapshotLimits } from '../src/router/ledger.mjs';
import { dynamicPacing } from '../src/router/dynamic-pacing.mjs';
import { accountReady } from '../src/router/account-cutover.mjs';
import { PAID_EXTRA_MAX_DOLLARS, dayLimit, paidStartAllowed } from '../src/router/paid-extra.mjs';

const now = 100_000_000;
const base = { starts: { minute: 12, hour: 60, day: 260 }, margin: 0.1, dayReserve: 0, poolPacing: { enabled: true, mode: 'dynamic', burst: 4, reserveStarts: 0 } };
const extra = { ...base, starts: { ...base.starts, allowPaidExtra: true } };
// Boat's reading when the free day allowance is gone: 217 used of 200, no
// remaining day starts, a non-zero next-start price, credit still positive.
const limits = ({ used = 217, minuteUsed = 0, hourUsed = 0, extra: more = {} } = {}) => ({
  observedAt: now, canStart: true, nextStartDollars: 0.03, billingStatus: 'active', creditBalanceHours: 802,
  machineTypes: [{ type: 'default', available: true }],
  startLimits: { perMinute: 12, perHour: 60, perDay: 200 },
  starts: {
    minute: { limit: 12, used: minuteUsed, remaining: 12 - minuteUsed },
    hour: { limit: 60, used: hourUsed, remaining: 60 - hourUsed },
    day: { limit: 200, used, remaining: Math.max(0, 200 - used) },
  },
  ...more,
});
const snap = (options) => snapshotLimits(limits(options), now);
const policy = (allowPaidExtra) => ({ ...base, starts: { ...base.starts, ...(allowPaidExtra === undefined ? {} : { allowPaidExtra }) } });

async function admit(allowPaidExtra, options) {
  const storage = new Storage(), ledger = new AccountLedger(storage, policy(allowPaidExtra), () => now);
  await ledger.enqueue('project', 'key', now - 1, undefined, { pool: true });
  return { result: await ledger.admit('project', 'key', snap(options), { pool: true }), storage, ledger };
}

test('the configured day cap becomes the ceiling only when the account opts in', () => {
  const off = dynamicPacing({ snapshot: snap(), policy: policy(), claims: [], previous: null, now }).status;
  assert.equal(off.hardRemaining.day, 0);
  assert.equal(off.remaining.day, 0);
  assert.equal(off.effectiveStartsPerHour, 0);
  assert.equal(off.hardLimitBlocked, true);
  const on = dynamicPacing({ snapshot: snap(), policy: policy(true), claims: [], previous: null, now }).status;
  assert.equal(on.hardRemaining.day, 43, 'the configured 260 is the hard ceiling past the provider 200');
  assert.equal(on.remaining.day, 17, 'the configured 260 keeps the ten percent margin at 234');
  assert.equal(on.effectiveStartsPerHour, 2, 'extras keep the floor rate');
  assert.equal(on.hardLimitBlocked, false);
});

test('the day ceiling follows the configured cap, and the provider cap still wins without the opt-in', () => {
  assert.equal(dayLimit(200, 260, true), 260);
  assert.equal(dayLimit(200, 260, false), 200);
  assert.equal(dayLimit(200, 150, true), 150, 'a configured cap below the provider limit still wins');
  assert.equal(dayLimit(200, undefined, true), 200);
});

test('the ledger admits a paid extra start only with the opt-in', async () => {
  assert.equal((await admit(undefined)).result.reason, 'day_cap');
  assert.equal((await admit(false)).result.reason, 'day_cap');
  assert.deepEqual(await admit(true).then(({ result }) => ({ ok: result.ok, recovered: result.recovered })), { ok: true, recovered: false });
});

test('the configured day cap is the hard stop for extras', async () => {
  assert.equal((await admit(true, { used: 259 })).result.ok, true, 'one start before the ceiling');
  assert.equal((await admit(true, { used: 260 })).result.reason, 'day_cap');
  assert.equal((await admit(true, { used: 300 })).result.reason, 'day_cap');
});

test('the next-start price is allowed up to the paid ceiling only', async () => {
  assert.equal(PAID_EXTRA_MAX_DOLLARS, 0.07);
  assert.equal(paidStartAllowed(undefined), true);
  assert.equal(paidStartAllowed(0.07), true);
  assert.equal(paidStartAllowed(0.0701), false);
  assert.equal((await admit(true, { extra: { nextStartDollars: 0.03 } })).result.ok, true);
  assert.equal((await admit(true, { extra: { nextStartDollars: 0.07 } })).result.ok, true);
  assert.equal((await admit(true, { extra: { nextStartDollars: 0.08 } })).result.reason, 'paid_start_ceiling');
  assert.equal((await admit(true, { extra: { nextStartDollars: 0 } })).result.ok, true);
  assert.equal((await admit(true, { extra: { nextStartDollars: undefined } })).result.ok, true, 'an omitted price gives no opinion');
});

test('minute, hour, provider and money guards still refuse a paid extra', async () => {
  assert.equal((await admit(true, { minuteUsed: 12 })).result.reason, 'minute_cap');
  assert.equal((await admit(true, { hourUsed: 60 })).result.reason, 'hour_cap');
  assert.equal((await admit(true, { extra: { canStart: false } })).result.reason, 'limits_unavailable');
  assert.equal((await admit(true, { extra: { checkoutRequired: true } })).result.reason, 'limits_unavailable');
  assert.equal((await admit(true, { extra: { billingStatus: 'past_due' } })).result.reason, 'limits_unavailable');
});

test('an account without the opt-in behaves exactly as before', async () => {
  const run = async (starts) => {
    const { result, storage, ledger } = await admit(starts);
    return JSON.stringify({ result, state: await storage.get(ledger.key) });
  };
  assert.equal(await run(undefined), await run(false));
});

test('accountReady chooses a full day window only for a paid extra account', () => {
  const ready = (used = 0, more = {}) => ({ ...limits({ used }), starts: { ...limits({ used }).starts, day: { limit: 200, used, remaining: Math.max(0, 200 - used) } }, ...more });
  assert.equal(accountReady(ready(217), 'default'), false, 'a full day window is skipped without the opt-in');
  assert.equal(accountReady(ready(217), 'default', true), true);
  assert.equal(accountReady(ready(0, { nextStartDollars: 0.03 }), 'default'), false, 'a paid start is never chosen without the opt-in');
  assert.equal(accountReady(ready(0, { nextStartDollars: 0.03 }), 'default', true), true);
  assert.equal(accountReady(ready(0, { nextStartDollars: 0.08 }), 'default', true), false, 'above the paid ceiling');
  assert.equal(accountReady(ready(0, { canStart: false }), 'default', true), false);
  assert.equal(accountReady(ready(0, { checkoutRequired: true }), 'default', true), false);
  assert.equal(accountReady(ready(0, { billingStatus: 'past_due' }), 'default', true), false);
  assert.equal(accountReady(ready(0, { creditBalanceHours: 0, creditBalanceSeconds: 0, packBalanceSeconds: 0, planIncluded: { vmHours: 10, vmHoursRemaining: 0 } }), 'default', true), false, 'zero funds');
  assert.equal(accountReady(ready(0, { unlimited: true, creditBalanceHours: 0 }), 'default', true), true);
});
