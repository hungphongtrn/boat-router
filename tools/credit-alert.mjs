// Boat credit runway and day-start window alerts for a watcher that samples each Boat account.
// The caller supplies `send` (deliver one text) and `save` (persist state). Credit runway uses the samples: credit hours plus included plan hours,
// the burn rate of the last 6 hours, and the time to zero. Levels: under 24 h, under 6 h, zero. Recovery over 48 h.
const HOUR = 3600000;
export const WINDOW_MS = 6 * HOUR;
export const MIN_SPAN_MS = 30 * 60000;
export const REMINDER_MS = 12 * HOUR;
export const DEFAULT_VM_HOUR_DOLLARS = 0.036;
const RANK = { under24: 1, under6: 2, zero: 3 };

export function balanceOf(sample) {
  if (!sample || sample.error || !Number.isFinite(sample.creditBalanceHours) || sample.creditBalanceHours < 0) return null;
  return sample.creditBalanceHours + (Number.isFinite(sample.includedVmHoursRemaining) && sample.includedVmHoursRemaining > 0 ? sample.includedVmHoursRemaining : 0);
}

// Hours of credit used per hour over the window. Increases (top-ups, plan renewals) are not burn.
export function burnRate(history, now) {
  const rows = history.filter(row => now - row.t <= WINDOW_MS && row.t <= now);
  if (rows.length < 2 || rows.at(-1).t - rows[0].t < MIN_SPAN_MS) return null;
  let used = 0;
  for (let i = 1; i < rows.length; i++) used += Math.max(0, rows[i - 1].h - rows[i].h);
  return used / ((rows.at(-1).t - rows[0].t) / HOUR);
}

const clock = (ms, offsetHours = 0) => `${new Date(ms + offsetHours * HOUR).toISOString().slice(11, 16)} UTC${offsetHours ? (offsetHours > 0 ? '+' : '') + offsetHours : ''}`;
const round = (n, d = 1) => Number(n.toFixed(d));

export function levelOf(balance, rate) {
  if (balance <= 0) return 'zero';
  if (rate === null || rate <= 0) return rate === 0 ? 'clear' : 'hold';
  const hours = balance / rate;
  return hours < 6 ? 'under6' : hours < 24 ? 'under24' : hours > 48 ? 'clear' : 'hold';
}

export function topUpDollars(balance, rate, price) {
  return Math.max(15, Math.ceil(Math.max(0, 48 * (rate ?? 0) - balance) * price));
}

export function creditText(name, level, balance, rate, now, price, prefix = '', offsetHours = 0) {
  const hours = rate > 0 ? balance / rate : null;
  const base = `Boat ${name} credit`;
  const burn = rate === null ? 'burn rate not known yet' : `burn ${round(rate)} h per hour over the last 6 h`;
  const pay = `Top up: boat wallet pay ${topUpDollars(balance, rate, price)}`;
  if (level === 'zero') return `${prefix}${base} is at zero (balance 0 h, ${burn}). ${pay}`;
  if (level === 'clear') return `${base} recovered: balance ${round(balance)} h (about $${round(balance * price, 2)}), ${burn}, ${hours === null ? 'no burn' : `zero in ${round(hours)} h`}, over 48 h.`;
  return `${prefix}${base} ${level === 'under6' ? 'under 6 h' : 'under 24 h'} to zero: balance ${round(balance)} h (about $${round(balance * price, 2)}), ${burn}, zero in ${round(hours)} h (about ${clock(now + hours * HOUR, offsetHours)}). ${pay}`;
}

// `history` (optional, from the log) seeds the burn window when the state has none.
export function createCreditRunway({ state = {}, send, save, utcOffsetHours = 0 }) {
  return async (sample, { history: seed } = {}) => {
    const balance = balanceOf(sample), t = Date.parse(sample?.at);
    if (balance === null || !Number.isFinite(t) || !sample.account) return;
    const name = sample.account;
    const entry = state[name] ?? {};
    entry.history ??= [];
    if (seed && !entry.history.length) entry.history = seed.filter(row => Number.isFinite(row.t) && Number.isFinite(row.h)).sort((a, b) => a.t - b.t);
    if (entry.history.length && entry.history.at(-1).t >= t) { state[name] = entry; return; }
    entry.history.push({ t, h: balance });
    entry.history = entry.history.filter(row => t - row.t <= WINDOW_MS + HOUR);
    state[name] = entry;
    const rate = burnRate(entry.history, t);
    // A zero balance on an idle account (no sandbox, no start, no burn) is not an alert (a spare account may sit at zero).
    const idleZero = balance <= 0 && !(rate > 0) && !(sample.activeSandboxes > 0) && !(sample.dailyStartsUsed > 0);
    const level = idleZero ? 'hold' : levelOf(balance, rate);
    const price = Number.isFinite(sample.vmHourDollars) && sample.vmHourDollars > 0 ? sample.vmHourDollars : DEFAULT_VM_HOUR_DOLLARS;
    let text = null;
    if (RANK[level]) {
      if (RANK[level] > (RANK[entry.level] ?? 0)) text = creditText(name, level, balance, rate, t, price, '', utcOffsetHours);
      else if (entry.sentAt != null && t - entry.sentAt >= REMINDER_MS) text = creditText(name, level, balance, rate, t, price, 'still: ', utcOffsetHours);
    } else if (level === 'clear' && entry.level) text = creditText(name, 'clear', balance, rate, t, price, '', utcOffsetHours);
    if (text) {
      await send(text);
      if (level === 'clear') { delete entry.level; delete entry.sentAt; }
      else { if (RANK[level] > (RANK[entry.level] ?? 0)) entry.level = level; entry.sentAt = t; }
    }
    await save(state);
  };
}

// Credit rows { t, h } of one account from log lines.
export function historyFromLog(lines, account, now, spanMs = WINDOW_MS + HOUR) {
  const rows = [];
  for (const line of lines) {
    if (!/^\{"at":"[^"]+","type":"boat_credit"/.test(line) || !line.includes(`"account":"${account}"`)) continue;
    try { const sample = JSON.parse(line), h = balanceOf(sample), t = Date.parse(sample.at); if (h !== null && Number.isFinite(t) && now - t <= spanMs) rows.push({ t, h }); } catch {}
  }
  return rows;
}

// Day start window alert. Each Boat account's day window has dailyStartsLimit starts; free = limit - used.
// One message for each level (under 60 free, 0 free) for each account and local day. One recovery message when 120 or
// more are free. Each pooled account has its own state.
export const LOW_FREE = 60;
export const RECOVER_FREE = 120;
export const STARTS_ACCOUNTS = ['primary', 'secondary'];
const localDay = (ms, offsetHours) => new Date(ms + offsetHours * HOUR).toISOString().slice(0, 10);

// Starts that free in the next 3 hours, from the router pacing forecast (hourOffset 0 and 3, hard remaining of the day window).
export function freedNext3h(pacing) {
  if (pacing?.forecastStatus !== 'ok' || !Array.isArray(pacing.hourlyForecast)) return null;
  const [first, third] = [pacing.hourlyForecast[0], pacing.hourlyForecast[3]];
  if (!first || !third) return null;
  return Math.max(0, third.estimatedHardRemainingDay - first.estimatedHardRemainingDay);
}

export function startsText(level, free, limit, freed, prefix = '', account = 'primary') {
  const frees = freed === null ? 'The router pacing data gives no 3 h forecast.' : `${freed} start(s) free in the next 3 h.`;
  if (level === 'recovered') return `Boat ${account} day starts recovered: ${free} of ${limit} free.`;
  return `${prefix}Boat ${account} day starts ${level === 'zero' ? 'are used up' : `under ${LOW_FREE} free`}: ${free} of ${limit} free. ${frees}`;
}

function accountState(state, account) { return state[account] ??= {}; }

// `pacing` is the router's pacing forecast for the primary account; it is not used for another account.
export function createStartsWindowAlert({ state = {}, send, save, accounts = STARTS_ACCOUNTS, primary = accounts[0], utcOffsetHours = 0 }) {
  return async (sample, pacing) => {
    if (!sample || sample.error || !accounts.includes(sample.account) || !Number.isFinite(sample.dailyStartsUsed) || !(sample.dailyStartsLimit > 0)) return;
    const t = Date.parse(sample.at), account = sample.account, entry = accountState(state, account);
    if (!Number.isFinite(t) || entry.at === sample.at) return;
    const free = Math.max(0, sample.dailyStartsLimit - sample.dailyStartsUsed), day = localDay(t, utcOffsetHours);
    const sent = entry.day === day ? (entry.sent ?? []) : [];
    const level = free <= 0 ? 'zero' : free < LOW_FREE ? 'low' : null;
    const freed = account === primary ? freedNext3h(pacing) : null;
    let text = null;
    if (level && !sent.includes(level)) text = startsText(level, free, sample.dailyStartsLimit, freed, '', account);
    else if (!level && free >= RECOVER_FREE && entry.active) text = startsText('recovered', free, sample.dailyStartsLimit, null, '', account);
    if (text) {
      await send(text);
      entry.day = day;
      if (level) entry.sent = [...new Set([...sent, level, ...(level === 'zero' ? ['low'] : [])])], entry.active = true;
      else { entry.sent = sent; entry.active = false; }
    } else if (level) { entry.day = day; entry.sent = sent; entry.active = true; }
    else if (free >= RECOVER_FREE) entry.active = false;
    entry.at = sample.at;
    await save(state);
  };
}
