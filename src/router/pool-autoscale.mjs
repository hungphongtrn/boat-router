// Live-box pool autoscaling: size the pool to work and to the VM-hours budget.
//
// A fixed cap is either too small for a burst or too large for the hours left
// in the billing period. The pool therefore targets the work it can see,
// clamped between a floor and a ceiling, and the ceiling drops to the floor
// when the recent burn would exhaust the remaining allowance before renewal.
//
// This file is pure: job counts, provider limits and the two bounds go in;
// the target and the ceiling decision come out. All I/O (reading job records,
// the provider limits and logging) stays in install.mjs, which validates
// 1 <= minLive <= maxLive before calling here.

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const finiteOrNull = value => (Number.isFinite(value) ? value : null);

// Demand is the queued work plus the running work: both need a live box (or
// will hold one) right now. Inputs are already-validated integers.
export function poolTarget({ queued = 0, running = 0, minLive, maxLive } = {}) {
  return { target: clamp(queued + running, minLive, maxLive) };
}

// Decide the ceiling from the provider's hours budget. Unknown or incomplete
// limit data never shrinks the pool: it leaves the ceiling at maxLive, because
// a missing read must not retire warm boxes on speculation. The budget is
// always computed and reported; `enforce` alone decides whether an exceeded
// budget floors the ceiling to minLive — without it the decision is logged
// (and shown on /router/status) while the ceiling stays maxLive: spend the
// remaining hours fast, then fall back to local runners.
//
//   hoursPerDayLeft = (vmHoursRemaining + packBalanceHours) / daysToPeriodEnd
//   last24hHours    = last24hUsageSeconds / 3600
//
// The plan and the pack are both spendable hours, so they add. The period-end
// divisor is floored at a quarter day so a renewal in minutes does not divide
// a healthy balance into an impossible hourly allowance.
export function hoursCeiling({ limits = null, now, minLive, maxLive, enforce = false } = {}) {
  const vmHoursRemaining = finiteOrNull(limits?.planIncluded?.vmHoursRemaining);
  const packBalanceHours = finiteOrNull(limits?.packBalanceHours) ??
    (Number.isFinite(limits?.packBalanceSeconds) ? limits.packBalanceSeconds / 3600 : null);
  const last24hUsageSeconds = finiteOrNull(limits?.last24hUsageSeconds);
  const end = typeof limits?.planIncluded?.periodEnd === 'string' ? Date.parse(limits.planIncluded.periodEnd) : NaN;

  const unknown = {
    ceiling: maxLive,
    reason: 'hours_unavailable',
    hoursPerDayLeft: null,
    last24hHours: null,
    vmHoursRemaining: null,
    packBalanceHours: null,
    daysToPeriodEnd: null,
  };
  if (vmHoursRemaining === null || packBalanceHours === null || last24hUsageSeconds === null || !Number.isFinite(end) || !Number.isFinite(now)) return unknown;

  const daysToPeriodEnd = Math.max((end - now) / 86_400_000, 0.25);
  const hoursPerDayLeft = (vmHoursRemaining + packBalanceHours) / daysToPeriodEnd;
  const last24hHours = last24hUsageSeconds / 3600;
  const detail = { hoursPerDayLeft, last24hHours, vmHoursRemaining, packBalanceHours, daysToPeriodEnd };
  if (last24hHours > hoursPerDayLeft) return { ceiling: enforce ? minLive : maxLive, reason: 'hours_budget', ...detail };
  return { ceiling: maxLive, reason: 'work', ...detail };
}
