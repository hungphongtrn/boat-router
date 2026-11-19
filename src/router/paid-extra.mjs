// Boat accepts starts past the account's free day allowance and bills each one.
// `starts.allowPaidExtra: true` on an account opts into spending those starts:
// the configured day cap becomes the ceiling, with the usual margin, and a
// non-zero next-start price is accepted up to PAID_EXTRA_MAX_DOLLARS. Every
// other guard stays: the provider's minute and hour windows, `canStart`,
// checkout, billing status and zero funds.
export const PAID_EXTRA_MAX_DOLLARS = 0.07;
// A monthly budget is a rolling 30-day sum, so a record ages out one month after
// the start it paid for.
export const PAID_EXTRA_WINDOW_MS = 30 * 86_400_000;

export function paidExtraEnabled(policy) {
  return policy?.starts?.allowPaidExtra === true;
}

// The account's monthly budget for billed extra starts. An omitted or invalid
// value means no budget, which is today's behaviour.
export function paidExtraBudget(policy) {
  const cap = policy?.starts?.paidExtraMaxDollarsPerMonth;
  return Number.isFinite(cap) && cap >= 0 ? cap : null;
}

// A start is a paid extra when the provider's day window is full (remaining <
// 1) or when Boat names a non-zero next-start price.
export function paidExtraStart(day, nextStartDollars) {
  const full = Number.isFinite(day?.used) && Number.isFinite(day?.limit) && day.used >= day.limit;
  return full || (Number.isFinite(nextStartDollars) && nextStartDollars > 0);
}

// Boat sometimes omits the price. Charge the ceiling then, the worst case.
export function paidExtraPrice(nextStartDollars) {
  return Number.isFinite(nextStartDollars) ? nextStartDollars : PAID_EXTRA_MAX_DOLLARS;
}

// The records that still count against the rolling 30-day budget.
export function paidExtraSpend(records, now) {
  return (Array.isArray(records) ? records : []).filter(record => record && Number.isFinite(record.at) && Number.isFinite(record.dollars) && record.at > now - PAID_EXTRA_WINDOW_MS);
}

// What an operator reads: the rolling spend and the budget it is measured
// against. The oldest record's expiry is when a refused start may try again.
export function paidExtraSummary(records, policy, now) {
  const live = paidExtraSpend(records, now);
  const spent = live.reduce((total, record) => total + record.dollars, 0);
  return { capUsd: paidExtraBudget(policy), spentUsd: Number(spent.toFixed(6)), starts: live.length, nextRollOffAt: live.length ? Math.min(...live.map(record => record.at)) + PAID_EXTRA_WINDOW_MS : null };
}

// The provider's reported day limit still wins unless paid extras are on, in
// which case the configured cap is the ceiling. An omitted configured cap keeps
// the provider limit either way.
export function dayLimit(providerLimit, configured, allowPaidExtra) {
  return allowPaidExtra && configured != null ? configured : Math.min(configured ?? Infinity, providerLimit);
}

// An omitted price gives no opinion (Boat sometimes leaves it out); a known
// price above the ceiling is a start the account should not buy.
export function paidStartAllowed(dollars) {
  return dollars === undefined || (Number.isFinite(dollars) && dollars <= PAID_EXTRA_MAX_DOLLARS);
}
