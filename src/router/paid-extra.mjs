// Boat accepts starts past the account's free day allowance and bills each one.
// `starts.allowPaidExtra: true` on an account opts into spending those starts:
// the configured day cap becomes the ceiling, with the usual margin, and a
// non-zero next-start price is accepted up to PAID_EXTRA_MAX_DOLLARS. Every
// other guard stays: the provider's minute and hour windows, `canStart`,
// checkout, billing status and zero funds.
export const PAID_EXTRA_MAX_DOLLARS = 0.07;

export function paidExtraEnabled(policy) {
  return policy?.starts?.allowPaidExtra === true;
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
