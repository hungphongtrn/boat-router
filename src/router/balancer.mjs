const spans = { minute: 60, hour: 3600, day: 86400 };
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
const finite = n => typeof n === 'number' && Number.isFinite(n);

export function decisionInputs(limits) {
  const number = value => finite(value) ? value : null;
  return {
    observedAt: number(limits?.observedAt),
    starts: Object.fromEntries(Object.keys(spans).map(name => [name, { limit: number(limits?.starts?.[name]?.limit), used: number(limits?.starts?.[name]?.used), remaining: number(limits?.starts?.[name]?.remaining) }])),
    vmHoursRemaining: number(limits?.planIncluded?.vmHoursRemaining),
    periodEnd: number(Date.parse(limits?.planIncluded?.periodEnd)),
    last24hUsageSeconds: number(limits?.last24hUsageSeconds),
  };
}

// Prices use equivalent VM-hours as their common unit. A missing input disables
// the adaptive policy; it must never weaken the account admission ledger.
export function scarcity(limits, now, maxAgeSeconds = 30, reserveHours = 0) {
  const at = limits?.observedAt, remaining = limits?.planIncluded?.vmHoursRemaining;
  const end = Date.parse(limits?.planIncluded?.periodEnd);
  const burn = limits?.last24hUsageSeconds;
  if (!finite(now) || !finite(maxAgeSeconds) || maxAgeSeconds < 0 || !finite(reserveHours) || reserveHours < 0 || !finite(at) || at > now || now - at > maxAgeSeconds * 1000 ||
      !finite(remaining) || remaining < 0 || !finite(end) || end <= now || !finite(burn) || burn < 0) return null;
  let start = 0;
  for (const name of Object.keys(spans)) {
    const window = limits?.starts?.[name];
    if (!Number.isSafeInteger(window?.limit) || window.limit < 1 || !Number.isSafeInteger(window.used) || window.used < 0 || (window.remaining !== undefined && (!Number.isSafeInteger(window.remaining) || window.remaining < 0 || window.remaining > window.limit))) return null;
    const used = Math.max(window.used, window.remaining === undefined ? 0 : window.limit - window.remaining);
    const fraction = clamp((used + 1) / window.limit, 0, 1);
    start = Math.max(start, fraction ** 4 / Math.max(0.05, 1 - fraction));
  }
  const pace = Math.max(0, remaining - reserveHours) / ((end - now) / 3600000);
  const recentBurn = burn / 86400;
  const ratio = pace > 0 ? recentBurn / pace : 20;
  return { start: clamp(start, 0, 20), hour: clamp(ratio, 0.05, 20), remaining, pace, recentBurn, ratio: clamp(ratio, 0, 20) };
}

export function holdDecision({ prices, arrivalsPerHour, maxHoldSeconds, multiplier = 1 }) {
  if (!prices || !finite(arrivalsPerHour) || arrivalsPerHour <= 0 || !finite(maxHoldSeconds) || maxHoldSeconds <= 0 || !finite(multiplier) || multiplier <= 0) return { seconds: 0, value: 0 };
  // Integrating the probability that the box is still idle avoids charging
  // idle time after an arrival has consumed it.
  const rate = arrivalsPerHour / 3600;
  const value = t => (1 - Math.exp(-rate * t)) * (prices.start - multiplier * prices.hour / (rate * 3600));
  const best = value(maxHoldSeconds);
  return best > 0 ? { seconds: maxHoldSeconds, value: best } : { seconds: 0, value: 0 };
}

export function waitDecision({ prices, waitSeconds, waitedSeconds, maxWaitSeconds, delayCostPerHour, extraHours = 0 }) {
  if (!prices || ![waitSeconds, waitedSeconds, maxWaitSeconds, delayCostPerHour, extraHours].every(finite) || waitSeconds < 0 || waitedSeconds < 0 || maxWaitSeconds <= 0 || delayCostPerHour < 0 || extraHours < 0) return false;
  return waitedSeconds + waitSeconds <= maxWaitSeconds && waitSeconds / 3600 * delayCostPerHour < prices.start + extraHours * prices.hour;
}
