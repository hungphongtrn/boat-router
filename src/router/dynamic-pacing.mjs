import { dayLimit, paidExtraEnabled } from './paid-extra.mjs';

const SPANS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const count = value => Number.isSafeInteger(value) && value >= 0;

// Boat supplies aggregate counters, not individual expirations. Confirmed local
// settlements give conservative upper bounds; unmatched usage has no timestamp.
// Count every uncertain or in-flight claim separately and keep provider caps.
export function dynamicPacing({ snapshot, policy, claims, previous, now }) {
  if (!snapshot || !Number.isFinite(snapshot.at) || snapshot.at > now || now - snapshot.at > 30_000 || snapshot.canStart !== true || !Array.isArray(claims)) return null;
  const cfg = policy.poolPacing ?? {}, burst = cfg.burst ?? 40, reserve = cfg.reserveStarts ?? 0;
  if (!count(burst) || burst < 1 || !count(reserve)) throw new TypeError('invalid dynamic pacing');
  const hardDayReserve = cfg.hardDayReserve ?? 0, floorLimit = cfg.floorStartsPerHour ?? 2;
  if (!count(hardDayReserve) || !count(floorLimit)) throw new TypeError('invalid dynamic pacing floor or hard reserve');
  const ownedDayCap = policy.maxOwnedStartsPerDay;
  if (ownedDayCap !== undefined && !count(ownedDayCap)) throw new TypeError('invalid owned daily start cap');
  const margin = policy.margin ?? 0, dayReserve = policy.dayReserve ?? policy.defaultDayReserve ?? 0;
  if (!Number.isFinite(margin) || margin < 0 || margin >= 1 || !count(dayReserve)) throw new TypeError('invalid dynamic pacing margin');
  const allowPaidExtra = paidExtraEnabled(policy);
  const remaining = {}, hardRemaining = {}, capacities = {}, localRooms = {};
  for (const [name, span] of Object.entries(SPANS)) {
    const observed = snapshot.windows?.[name], configured = policy.starts?.[name], windowMargin = policy.windowMargins?.[name] ?? margin;
    if (!observed || !count(observed.limit) || observed.limit < 1 || !count(observed.used) || (configured != null && !count(configured)) || !Number.isFinite(windowMargin) || windowMargin < 0 || windowMargin >= 1) return null;
    // Paid extras raise the day ceiling to the configured cap; minute and hour
    // keep the provider's own limit, which the account cannot buy past.
    const ceiling = name === 'day' ? dayLimit(observed.limit, configured, allowPaidExtra) : Math.min(configured ?? Infinity, observed.limit);
    const cap = Math.max(0, Math.floor(ceiling * (1 - windowMargin)) - (name === 'day' ? dayReserve + reserve : 0));
    const local = claims.filter(c => c.status !== 'created' || (c.settledAt ?? c.at) > now - span);
    const candidates = local.filter(c => c.status === 'created' && Number.isFinite(c.settledAt) && c.settledAt < snapshot.at).length;
    const unobserved = local.filter(c => c.status !== 'created' || !Number.isFinite(c.settledAt) || c.settledAt >= snapshot.at).length + Math.max(0, candidates - observed.used);
    const localRoom = Math.min(configured == null ? Infinity : configured - local.length, name === 'day' && ownedDayCap !== undefined ? ownedDayCap - local.length : Infinity);
    remaining[name] = Math.max(0, Math.min(localRoom, cap - observed.used - unobserved));
    localRooms[name] = localRoom;
    hardRemaining[name] = Math.max(0, Math.min(localRoom, ceiling - (name === 'day' ? hardDayReserve : 0) - observed.used - unobserved));
    capacities[name] = cap;
  }
  const dayCapacity = Math.min(capacities.day, ownedDayCap ?? Infinity), safeDay = remaining.day;
  const capacity = Math.min(burst, safeDay);
  const initialCredit = safeDay > 0 && dayCapacity > 0 ? Math.min(capacity, Math.max(1, burst * safeDay / dayCapacity)) : 0;
  // A settlement precedes the provider sample and follows the actual create.
  // It bounds that start's expiry but cannot prove what the aggregate counted.
  // If local starts exceed provider usage, keep the newest possible matches.
  const localSettlements = claims.filter(c => c.status === 'created' && Number.isFinite(c.at) && Number.isFinite(c.settledAt) && c.at <= c.settledAt && c.settledAt < snapshot.at && c.settledAt > now - SPANS.day)
    .map(c => c.settledAt).sort((a, b) => b - a);
  const providerUsed = snapshot.windows.day.used;
  const tracked = localSettlements.slice(0, providerUsed).map(at => at + SPANS.day).sort((a, b) => a - b);
  const unmatched = Math.max(0, providerUsed - tracked.length);
  const fallbackAt = now + SPANS.day, minHorizon = SPANS.minute;
  const estimate = (at, remainingDay, pendingTracked, pendingUnmatched) => {
    const total = pendingTracked.length + pendingUnmatched;
    if (!total) return Math.min(120, capacities.hour, remainingDay * SPANS.hour / SPANS.day);
    const matchedRate = pendingTracked.length ? remainingDay * pendingTracked.length / total * SPANS.hour / Math.max(minHorizon, pendingTracked[0] - at) : 0;
    const unmatchedRate = pendingUnmatched ? remainingDay * pendingUnmatched / total * SPANS.hour / Math.max(minHorizon, fallbackAt - at) : 0;
    return Math.min(120, capacities.hour, matchedRate + unmatchedRate);
  };
  const ratePerMs = estimate(now, safeDay, tracked, unmatched) / SPANS.hour;
  const hardLimitBlocked = Object.values(hardRemaining).some(value => value < 1);
  const floorRate = Math.min(floorLimit, snapshot.windows.hour.limit, policy.starts?.hour ?? Infinity);
  const effectiveRate = (base, hardDay, hardMinute = hardRemaining.minute, hardHour = hardRemaining.hour) => hardMinute < 1 || hardHour < 1 || hardDay < 1 ? 0 : Math.max(base, floorRate);
  const hourlyForecast = Array.from({ length: 25 }, (_, hourOffset) => {
    const at = now + hourOffset * SPANS.hour;
    const pendingTracked = tracked.filter(expiry => expiry > at);
    const expiredTracked = tracked.length - pendingTracked.length;
    const pendingUnmatched = at < fallbackAt ? unmatched : 0;
    const expiredUnmatched = unmatched - pendingUnmatched;
    const estimatedRemainingDay = Math.max(0, Math.min(dayCapacity, localRooms.day + expiredTracked, safeDay + expiredTracked + expiredUnmatched));
    const estimatedHardRemainingDay = Math.min(ownedDayCap ?? Infinity, Math.max(0, dayLimit(snapshot.windows.day.limit, policy.starts?.day, allowPaidExtra) - hardDayReserve), hardRemaining.day + expiredTracked + expiredUnmatched);
    // At the next hourly sample provider minute/hour usage has rolled off
    // under the no-new-start assumption. Continue holding uncertain claims.
    const projectedWindowRoom = name => hourOffset === 0 ? hardRemaining[name] : Math.max(0, Math.min(localRooms[name], hardRemaining[name] + snapshot.windows[name].used));
    return { hourOffset, estimatedRemainingDay, estimatedHardRemainingDay,
      estimatedStartsPerHour: effectiveRate(estimate(at, estimatedRemainingDay, pendingTracked, pendingUnmatched), estimatedHardRemainingDay, projectedWindowRoom('minute'), projectedWindowRoom('hour')) };
  });
  let credit;
  if (previous != null && (!Number.isFinite(previous.at) || previous.at > now || !Number.isFinite(previous.credit) || previous.credit < 0 || !Number.isFinite(previous.ratePerMs) || previous.ratePerMs < 0)) return null;
  if (previous != null) {
    credit = Math.min(capacity, previous.credit + (now - previous.at) * Math.min(previous.ratePerMs, ratePerMs));
  } else {
    // An existing account starts with a reduced burst proportional to the
    // remaining guarded daily budget, capped by actual remaining starts.
    credit = initialCredit;
  }
  const oldFloor = previous?.floorStarts ?? [];
  if (!Array.isArray(oldFloor) || oldFloor.some(item => !item || typeof item.key !== 'string' || !Number.isFinite(item.at) || item.at > now)) return null;
  const floorStarts = oldFloor.filter(item => item.at > now - SPANS.hour);
  const state = { at: now, credit, ratePerMs, floorStarts };
  const idleHoldSecondsByProject = Object.fromEntries(Object.entries(policy.projects ?? {}).flatMap(([id, project]) => {
    const seconds = project.idleHoldSeconds ?? policy.reuse?.idleHoldSeconds;
    return count(seconds) ? [[id, seconds]] : [];
  }));
  const status = { sampledAt: snapshot.at, snapshotAgeMs: now - snapshot.at, baseStartsPerHour: ratePerMs * SPANS.hour,
    effectiveStartsPerHour: effectiveRate(ratePerMs * SPANS.hour, hardRemaining.day), hardLimitBlocked,
    burstCredit: credit, burstCapacity: capacity, burstLimit: burst, remaining, nextRollOff: null,
    basis: tracked.length ? 'tracked_settlement_estimate' : 'provider_aggregate_24h_fallback', fallbackHorizonHours: 24,
    trackedStarts: tracked.length, unmatchedStarts: unmatched, localCountExceedsProvider: localSettlements.length > providerUsed,
    matchingAssumption: 'count_overlap_not_verified_by_provider',
    nextTrackedRollOffUpperBound: tracked[0] ?? null, nextTrackedRollOffKind: 'tracked_settlement_upper_bound',
    forecastAssumptions: 'no_new_starts_unmatched_held_24h', forecastAt: now, hourlyForecast,
    floorLimitPerHour: floorLimit, floorUsedLastHour: floorStarts.length, floorRemainingLastHour: Math.max(0, floorLimit - floorStarts.length),
    softRemaining: { ...remaining }, hardRemaining, idleHoldSecondsByProject };
  if (cfg.unpaced === true) {
    status.remaining = { ...hardRemaining };
    status.burstCredit = Math.min(...Object.values(hardRemaining));
    status.effectiveStartsPerHour = hardLimitBlocked ? 0 : Math.min(snapshot.windows.hour.limit, policy.starts?.hour ?? Infinity);
    status.admissionMode = 'unpaced';
  }
  return { state, status };
}
