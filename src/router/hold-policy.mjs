// Cost-aware idle hold policy for a reusable Boat box.
//
// Boat bills VM time per second while a box runs and charges a start only when
// the rolling start windows are exceeded (see docs/local-admission.md). A start
// therefore buys roughly one hour of a default (medium) box: $0.03 for the
// first over-limit bracket against $0.036 per default VM-hour. That hour is the
// "already paid window": while a box is younger than it, keeping the box idle
// costs nothing that a start would not cost, so it stays warm for the next job.
//
// When the window ends the box is paid by the hour from then on. The decision is
// then economic:
//   - starts plentiful: retire the idle box; a fresh start is cheaper than
//     another idle box-hour and the start budget can cover the arrival rate.
//   - starts scarce: keep it for at most one more paid window, and only while
//     work is queued or the recent arrival rate predicts a job inside that
//     window. Otherwise retire it.
//
// The function is pure: box age, idle time, queued work, the recent arrival
// rate and the remaining start budget go in; keep/retire and a hold in seconds
// come out. The caller turns the hold into a deadline.

export const HOLD_POLICY_DEFAULTS = Object.freeze({
  enabled: true,
  paidWindowSeconds: 3600,
  // Headroom over the recent arrival rate that "plentiful" requires. 0.5 means
  // the remaining starts must cover 1.5x the jobs the last lookback saw.
  plentifulMargin: 0.5,
  arrivalLookbackSeconds: 3600,
  minExpectedJobs: 1,
  // Paid windows an idle box may be kept for while starts are scarce.
  scarceWindows: 1,
});

const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

export function holdPolicyConfig(account, project) {
  const config = {
    ...HOLD_POLICY_DEFAULTS,
    ...(account?.reuse?.holdPolicy ?? {}),
    ...(project?.reuse?.holdPolicy ?? {}),
  };
  if (typeof config.enabled !== 'boolean') throw new TypeError('invalid hold policy enabled');
  if (!positiveInteger(config.paidWindowSeconds)) throw new TypeError('invalid hold policy paid window');
  if (!Number.isFinite(config.plentifulMargin) || config.plentifulMargin < 0 || config.plentifulMargin > 10) throw new TypeError('invalid hold policy margin');
  if (!positiveInteger(config.arrivalLookbackSeconds) || config.arrivalLookbackSeconds < 60) throw new TypeError('invalid hold policy lookback');
  if (!Number.isFinite(config.minExpectedJobs) || config.minExpectedJobs <= 0) throw new TypeError('invalid hold policy minimum jobs');
  if (!positiveInteger(config.scarceWindows)) throw new TypeError('invalid hold policy scarce windows');
  return config;
}

// Jobs observed in the lookback, converted to jobs per hour. A job is counted
// once, by its queue time; records without one fall back to when it was seen.
export function recentArrivalPerHour(jobs, now, lookbackSeconds) {
  if (!Array.isArray(jobs) || !Number.isFinite(now) || !positiveInteger(lookbackSeconds)) return null;
  const since = now - lookbackSeconds * 1000;
  let count = 0;
  for (const job of jobs) {
    if (job?.missing === true) continue;
    const at = Number.isFinite(job?.queuedAt) ? job.queuedAt : job?.observedAt;
    if (Number.isFinite(at) && at >= since && at <= now) count++;
  }
  return count / (lookbackSeconds / 3600);
}

// The remaining start budget covers the recent arrival rate with headroom in
// both the rolling day and hour windows. Unknown data is never "plentiful".
export function startsPlentiful({ dayRemaining, hourRemaining, arrivalPerHour, margin = HOLD_POLICY_DEFAULTS.plentifulMargin }) {
  if (!Number.isFinite(dayRemaining) || dayRemaining < 0) return false;
  if (!Number.isFinite(hourRemaining) || hourRemaining < 0) return false;
  if (!Number.isFinite(arrivalPerHour) || arrivalPerHour < 0) return false;
  if (!Number.isFinite(margin) || margin < 0) return false;
  const headroom = 1 + margin;
  return dayRemaining >= Math.max(1, arrivalPerHour * 24 * headroom) &&
    hourRemaining >= Math.max(1, arrivalPerHour * headroom);
}

// The one decision. `holdSeconds` is how much longer the box may stay idle,
// counted from now; 0 means retire on this tick.
//
// Two rates matter. `startRatePerHour` is how many starts the account actually
// spent in the rolling hour: that is what the remaining start budget has to
// cover, and box reuse keeps it far below the job rate. `arrivalPerHour` is
// jobs queued in the lookback: that is what predicts a job needing this box.
// The scarcity test uses the start rate; the prediction uses the job rate.
export function holdDecision({ boxAgeSeconds, idleSeconds = 0, queued = 0, arrivalPerHour = null, startRatePerHour = null, starts = {}, config = {} }) {
  const cfg = { ...HOLD_POLICY_DEFAULTS, ...config };
  if (!cfg.enabled) return { keep: true, retire: false, reason: 'policy_disabled', holdSeconds: null, boxAgeSeconds, idleSeconds };
  const age = Number.isFinite(boxAgeSeconds) ? Math.max(0, boxAgeSeconds) : null;
  const idle = Number.isFinite(idleSeconds) ? Math.max(0, idleSeconds) : 0;
  const budget = {
    dayRemaining: Number.isFinite(starts?.dayRemaining) ? starts.dayRemaining : null,
    hourRemaining: Number.isFinite(starts?.hourRemaining) ? starts.hourRemaining : null,
  };
  const startRate = Number.isFinite(startRatePerHour) && startRatePerHour >= 0 ? startRatePerHour : null;
  const plentiful = startsPlentiful({ ...budget, arrivalPerHour: startRate, margin: cfg.plentifulMargin });
  const expected = Number.isFinite(arrivalPerHour) ? arrivalPerHour * cfg.paidWindowSeconds / 3600 : null;
  const detail = { boxAgeSeconds: age, idleSeconds: idle, queued, arrivalPerHour, startRatePerHour: startRate, ...budget, plentiful, expectedJobs: expected };

  if (age != null && age < cfg.paidWindowSeconds) {
    return { keep: true, retire: false, reason: 'paid_window', holdSeconds: Math.ceil(cfg.paidWindowSeconds - age), ...detail };
  }
  if (plentiful) return { keep: false, retire: true, reason: 'starts_plentiful', holdSeconds: 0, ...detail };
  const scarceHold = cfg.paidWindowSeconds * cfg.scarceWindows;
  if (queued > 0) return { keep: true, retire: false, reason: 'queued', holdSeconds: scarceHold, ...detail };
  if (expected != null && expected >= cfg.minExpectedJobs) return { keep: true, retire: false, reason: 'arrival_predicted', holdSeconds: scarceHold, ...detail };
  return { keep: false, retire: true, reason: 'scarce_no_demand', holdSeconds: 0, ...detail };
}
