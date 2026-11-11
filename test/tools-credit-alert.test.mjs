import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreditRunway, burnRate, balanceOf, levelOf, topUpDollars, historyFromLog, createStartsWindowAlert, freedNext3h } from '../tools/credit-alert.mjs';
const H = 3600000, t0 = Date.parse('2026-11-11T00:00:00Z');
const at = ms => new Date(t0 + ms).toISOString();
function setup() {
  const state = {}, sent = [];
  const check = createCreditRunway({ state, send: async x => sent.push(x), save: async () => {}, utcOffsetHours: 9 });
  return { state, sent, sample: (ms, hours, extra = {}) => check({ account: 'primary', at: at(ms), creditBalanceHours: hours, includedVmHoursRemaining: 0, ...extra }) };
}
test('balance counts included plan hours; invalid samples give none', () => {
  assert.equal(balanceOf({ creditBalanceHours: 5, includedVmHoursRemaining: 3 }), 8);
  assert.equal(balanceOf({ creditBalanceHours: 5, includedVmHoursRemaining: null }), 5);
  assert.equal(balanceOf({ error: 'http_500', creditBalanceHours: 5 }), null);
  assert.equal(balanceOf({ creditBalanceHours: -1 }), null);
});
test('burn rate sums the drops in the last 6 hours and ignores top-ups', () => {
  const rows = [{ t: t0, h: 100 }, { t: t0 + H, h: 90 }, { t: t0 + 2 * H, h: 500 }, { t: t0 + 3 * H, h: 490 }];
  assert.equal(burnRate(rows, t0 + 3 * H), 20 / 3);
  assert.equal(burnRate([{ t: t0, h: 5 }, { t: t0 + 60000, h: 4 }], t0 + 60000), null, 'less than 30 minutes of data');
  assert.equal(burnRate([{ t: t0 - 7 * H, h: 100 }, { t: t0, h: 50 }], t0), null, 'old rows are outside the window');
});
test('levels follow the time to zero; clear only above 48 hours', () => {
  assert.equal(levelOf(0, 10), 'zero');
  assert.equal(levelOf(100, 10), 'under24');
  assert.equal(levelOf(230, 10), 'under24');
  assert.equal(levelOf(59, 10), 'under6');
  assert.equal(levelOf(300, 10), 'hold');
  assert.equal(levelOf(481, 10), 'clear');
  assert.equal(levelOf(5, 0), 'clear');
  assert.equal(levelOf(5, null), 'hold');
});
test('top-up covers 48 hours of burn in whole dollars, at least 15', () => {
  assert.equal(topUpDollars(10, 14, 0.036), 24);
  assert.equal(topUpDollars(10, 0.5, 0.036), 15);
});
test('one message per level, with balance, burn rate, time to zero and the top-up command', async () => {
  const { sent, sample } = setup();
  // 14 h of credit per hour
  for (let i = 0; i <= 4; i++) await sample(i * H, 400 - 14 * i);
  assert.equal(sent.length, 0, '344 h at 14 h/h is 24.6 h');
  await sample(5 * H, 330);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Boat primary credit under 24 h to zero: balance 330 h \(about \$11\.88\), burn 14 h per hour over the last 6 h, zero in 23\.6 h \(about \d\d:\d\d UTC\+9\)\. Top up: boat wallet pay 15$/);
  await sample(6 * H, 316); assert.equal(sent.length, 1, 'same level: no repeat');
  for (let i = 7; i <= 23; i++) await sample(i * H, 400 - 14 * i);
  assert.equal(sent.length, 3); assert.match(sent[1], /^still: Boat primary credit under 24 h/, 'reminder 12 h after the first message');
  assert.match(sent[2], /^Boat primary credit under 6 h to zero: balance 78 h/);
  for (let i = 24; i <= 28; i++) await sample(i * H, 400 - 14 * i);
  assert.equal(sent.length, 3);
  await sample(29 * H, 0); assert.equal(sent.length, 4); assert.match(sent[3], /^Boat primary credit is at zero \(balance 0 h, burn \d+ h per hour/);
  await sample(29 * H + 60000, 0); assert.equal(sent.length, 4);
});
test('reminder after 12 hours; recovery above 48 hours; top-up does not count as burn', async () => {
  const { sent, sample, state } = setup();
  for (let i = 0; i <= 12; i++) await sample(i * H, 36 - 1.5 * i);
  assert.equal(sent.length, 1, '1.5 h of credit per hour: under 24 h from the second sample');
  await sample(13 * H, 36 - 1.5 * 13);
  assert.equal(sent.length, 2); assert.match(sent[1], /^still: /);
  await sample(14 * H, 3000);
  assert.equal(sent.length, 3); assert.match(sent[2], /recovered: balance 3000 h/);
  assert.equal(state.primary.level, undefined);
  await sample(15 * H, 2998.5); assert.equal(sent.length, 3);
});
test('failed delivery is retried on the next sample; duplicates and bad samples are ignored', async () => {
  const state = {}, sent = []; let fail = true;
  const check = createCreditRunway({ state, utcOffsetHours: 9, save: async () => {}, send: async x => { if (fail) throw Error('send'); sent.push(x); } });
  const s = (ms, h, extra = {}) => ({ account: 'primary', at: at(ms), creditBalanceHours: h, activeSandboxes: 2, ...extra });
  await assert.rejects(check(s(0, 0)));
  await assert.rejects(check(s(60000, 0)));
  fail = false; await check(s(120000, 0)); assert.equal(sent.length, 1);
  await check(s(120000, 0)); await check({ account: 'primary', at: at(180000), error: 'http_500' }); assert.equal(sent.length, 1);
});
test('history from the log seeds the burn window', async () => {
  const lines = [0, 1, 2].map(i => JSON.stringify({ at: at(i * H), type: 'boat_credit', account: 'primary', creditBalanceHours: 100 - i * 20, includedVmHoursRemaining: 0 }));
  lines.push('{"at":"x","accountCredit":{"type":"boat_credit"}}');
  const rows = historyFromLog(lines, 'primary', t0 + 2 * H);
  assert.equal(rows.length, 3);
  const state = {}, sent = [];
  const check = createCreditRunway({ state, send: async x => sent.push(x), save: async () => {}, utcOffsetHours: 9 });
  await check({ account: 'primary', at: at(2 * H), creditBalanceHours: 60 }, { history: rows.slice(0, 2) });
  assert.equal(sent.length, 1, '60 h at 20 h/h is 3 h: under 6 h');
  assert.match(sent[0], /under 6 h/);
});

const sampleAt = (iso, used, limit = 600, account = 'primary') => ({ account, at: iso, dailyStartsUsed: used, dailyStartsLimit: limit });
const forecast = (first, third) => ({ forecastStatus: 'ok', hourlyForecast: Array.from({ length: 25 }, (_, i) => ({ hourOffset: i, estimatedHardRemainingDay: i === 0 ? first : i === 3 ? third : first })) });
function startsSetup() {
  const state = {}, sent = [];
  return { state, sent, check: createStartsWindowAlert({ state, send: async x => sent.push(x), save: async () => {}, utcOffsetHours: 9 }) };
}
test('freed starts come from the 3 hour pacing forecast, and only when it is valid', () => {
  assert.equal(freedNext3h(forecast(10, 55)), 45);
  assert.equal(freedNext3h({ forecastStatus: 'invalid', hourlyForecast: null }), null);
  assert.equal(freedNext3h(null), null);
});
test('one message at under 60 free and one at 0 free for each day; no repeat while it lasts', async () => {
  const { sent, check } = startsSetup();
  await check(sampleAt('2026-11-11T01:00:00Z', 530), forecast(70, 70));
  assert.equal(sent.length, 0);
  await check(sampleAt('2026-11-11T01:05:00Z', 545), forecast(55, 100));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /^Boat primary day starts under 60 free: 55 of 600 free\. 45 start\(s\) free in the next 3 h\./);
  await check(sampleAt('2026-11-11T01:10:00Z', 550), forecast(50, 100)); assert.equal(sent.length, 1);
  await check(sampleAt('2026-11-11T01:15:00Z', 600), forecast(0, 0));
  assert.equal(sent.length, 2); assert.match(sent[1], /are used up: 0 of 600 free\. 0 start\(s\) free in the next 3 h/);
  await check(sampleAt('2026-11-11T01:20:00Z', 600), forecast(0, 0)); assert.equal(sent.length, 2);
});
test('missing forecast is said, a new local day sends again, recovery needs 120 free', async () => {
  const { sent, check } = startsSetup();
  await check(sampleAt('2026-11-11T01:00:00Z', 580), null);
  assert.match(sent[0], /no 3 h forecast/);
  await check(sampleAt('2026-11-11T02:00:00Z', 500), null); assert.equal(sent.length, 1, '100 free is not enough to recover');
  await check(sampleAt('2026-11-11T03:00:00Z', 400), null); assert.equal(sent.length, 2); assert.match(sent[1], /recovered: 200 of 600 free/);
  await check(sampleAt('2026-11-11T04:00:00Z', 580), null); assert.equal(sent.length, 2, 'same local day and level: no second message');
  await check(sampleAt('2026-11-11T16:00:00Z', 580), null); assert.equal(sent.length, 3, 'new local day (01:00 UTC+9)');
});
test('other accounts, errors, duplicates; failed delivery is retried', async () => {
  const state = {}, sent = []; let fail = true;
  const check = createStartsWindowAlert({ state, utcOffsetHours: 9, save: async () => {}, send: async x => { if (fail) throw Error('x'); sent.push(x); } });
  await check(sampleAt('2026-11-11T01:00:00Z', 600, 600, 'other-account'));
  await check({ account: 'primary', at: 'a', error: 'http_500' });
  await assert.rejects(check(sampleAt('2026-11-11T01:05:00Z', 600)));
  fail = false; await check(sampleAt('2026-11-11T01:10:00Z', 600)); assert.equal(sent.length, 1);
  await check(sampleAt('2026-11-11T01:10:00Z', 600)); assert.equal(sent.length, 1);
});

test('a zero balance on an idle account is not an alert; a busy account at zero is', async () => {
  const state = {}, sent = [];
  const check = createCreditRunway({ state, send: async x => sent.push(x), save: async () => {}, utcOffsetHours: 9 });
  const s = (ms, extra) => ({ account: 'secondary', at: at(ms), creditBalanceHours: 0, includedVmHoursRemaining: 0, ...extra });
  await check(s(0, { activeSandboxes: 0, dailyStartsUsed: 0 })); await check(s(H, { activeSandboxes: 0, dailyStartsUsed: 0 }));
  assert.equal(sent.length, 0);
  await check(s(2 * H, { activeSandboxes: 1, dailyStartsUsed: 4 }));
  assert.equal(sent.length, 1); assert.match(sent[0], /^Boat secondary credit is at zero/);
});

test('secondary has its own day window state, text and no primary forecast', async () => {
  const { state, sent, check } = startsSetup();
  await check(sampleAt('2026-11-11T01:00:00Z', 545), forecast(55, 100));
  await check(sampleAt('2026-11-11T01:00:00Z', 350, 400, 'secondary'), forecast(55, 100));
  assert.equal(sent.length, 2);
  assert.match(sent[1], /^Boat secondary day starts under 60 free: 50 of 400 free\. The router pacing data gives no 3 h forecast\./);
  await check(sampleAt('2026-11-11T01:05:00Z', 352, 400, 'secondary'), null); assert.equal(sent.length, 2, 'no repeat for secondary');
  await check(sampleAt('2026-11-11T01:05:00Z', 600), forecast(0, 0)); assert.equal(sent.length, 3);
  assert.match(sent[2], /^Boat primary day starts are used up/);
  assert.equal(state.secondary.active, true); assert.equal(state.primary.active, true);
});
test('an idle secondary account sends no day window alert', async () => {
  const state = {}, sent = [];
  const check = createStartsWindowAlert({ state, send: async x => sent.push(x), save: async () => {}, utcOffsetHours: 9 });
  for (let i = 0; i < 12; i++) await check(sampleAt(`2026-11-11T0${Math.floor(i / 6) + 1}:${String((i % 6) * 10).padStart(2, '0')}:00Z`, 0, 400, 'secondary'));
  assert.equal(sent.length, 0);
  assert.deepEqual(Object.keys(state), ['secondary']);
});
