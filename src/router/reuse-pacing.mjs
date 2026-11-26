import { snapshotLimits } from './ledger.mjs';
import { dynamicPacing } from './dynamic-pacing.mjs';
import { paidExtraBudget, paidExtraEnabled, paidExtraSpend } from './paid-extra.mjs';

const samples = new WeakMap();

// A kept box is not free. Past the plan's included VM hours a box-hour costs
// about what one paid start costs, so while the day window is empty a hold
// longer than this buys nothing over paying for a start (2026-11-20).
export const PAID_IDLE_HOLD_SECONDS = 1200;

// The hold a warm box gets while the free day window is empty and the account's
// paid-extra budget still has room. `null` keeps the ordinary hold: the window
// has free starts, or nothing can replace the box anyway.
export function paidIdleHold({ pacing, baseSeconds, configured }) {
  if (pacing?.dayRoomEmpty !== true || pacing?.paidExtraRoom !== true) return null;
  const seconds = Number.isSafeInteger(configured) && configured >= 0 ? configured : PAID_IDLE_HOLD_SECONDS;
  return Math.max(baseSeconds, seconds);
}

// Use a current account-level rate without changing the ledger's token balance.
// Unknown data preserves the configured hold and never grants extra starts.
export async function reusePacing({ account, api, budget, now }) {
  if (account.poolPacing?.enabled !== true || account.poolPacing?.mode !== 'dynamic' || !budget?.ledger?.storage || !budget.ledger.key) return null;
  try {
    const state = await budget.ledger.storage.get(budget.ledger.key) ?? {};
    let sample = state.pacingStatus;
    let at = now();
    if (!Number.isFinite(sample?.sampledAt) || sample.sampledAt > at || at - sample.sampledAt > 30_000 || !Number.isFinite(sample.effectiveStartsPerHour) || sample.effectiveStartsPerHour < 0) {
      let entry = samples.get(api);
      if (!entry?.pending && (!Number.isFinite(entry?.sample?.sampledAt) || at - entry.sample.sampledAt > 30_000 || entry.sample.sampledAt > at)) {
        entry = {};
        entry.pending = (async () => {
          const startedAt = now();
          const limits = await api.limits();
          const readAt = now();
          const snapshot = snapshotLimits(limits, startedAt);
          return dynamicPacing({ snapshot, policy: account, claims: Object.values(state.claims ?? {}), previous: state.dynamicPacing, now: readAt })?.status ?? null;
        })();
        samples.set(api, entry);
      }
      if (entry.pending) {
        try { entry.sample = await entry.pending; } finally { entry.pending = null; }
      }
      at = now();
      sample = entry.sample;
    }
    if (!(sample && Number.isFinite(sample.sampledAt) && sample.sampledAt <= at && at - sample.sampledAt <= 30_000 && Number.isFinite(sample.effectiveStartsPerHour) && sample.effectiveStartsPerHour >= 0)) return null;
    // The hold policy needs the remaining start budget, not only the rate. The
    // hard window is what admission actually enforces in slot-budget mode.
    const startsLeft = sample.hardRemaining ?? sample.remaining ?? {};
    const remaining = name => Number.isFinite(startsLeft?.[name]) && startsLeft[name] >= 0 ? startsLeft[name] : null;
    return { sampledAt: sample.sampledAt, startsPerHour: sample.effectiveStartsPerHour, dayRemaining: remaining('day'), hourRemaining: remaining('hour'), dayRoomEmpty: dayRoomEmpty(sample), paidExtraRoom: paidExtraRoom({ account, state, at }) };
  } catch { return null; }
}

// The free day window is empty but the configured ceiling still allows a billed
// start: the floor rate is what is left, and every start is a paid extra.
function dayRoomEmpty(sample) {
  return Number.isFinite(sample?.remaining?.day) && sample.remaining.day < 1 && Number.isFinite(sample?.hardRemaining?.day) && sample.hardRemaining.day >= 1;
}

// The rolling paid-extra budget, read from the same ledger state as the claims.
function paidExtraRoom({ account, state, at }) {
  if (!paidExtraEnabled(account)) return false;
  const budget = paidExtraBudget(account);
  if (budget == null) return false;
  const spent = paidExtraSpend(state?.paidExtraSpend, at).reduce((total, record) => total + record.dollars, 0);
  return spent < budget;
}

export function nominalReuseHold(baseSeconds, startsPerHour) {
  if (!Number.isFinite(startsPerHour) || startsPerHour < 0) return baseSeconds;
  const scarceHold = Math.max(baseSeconds, 3600);
  if (startsPerHour <= 5) return scarceHold;
  if (startsPerHour >= 15) return baseSeconds;
  return Math.round(baseSeconds + (scarceHold - baseSeconds) * (15 - startsPerHour) / 10);
}

export function reuseHold({ box, baseSeconds, nominalSeconds, now, account, project, env, enabled }) {
  if (!box.reusable) return 120;
  // A policy decision may be 0 (retire now), so the nominal hold is not floored
  // at the legacy base hold. The legacy callers still pass a value >= base.
  if (!enabled || box.drainOnly || !box.baselineHash) return baseSeconds;
  const ttl = Number(box.machineTtlSeconds ?? project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200);
  const durations = Object.values(project.jobs ?? {}).map(job => job.timeoutMinutes ?? 0);
  const maxAge = Math.min(account.reuse?.maxAgeSeconds ?? 86400, project.reuse?.maxAgeSeconds ?? 86400);
  const maxJobs = Math.min(account.reuse?.maxJobs ?? 60, project.reuse?.maxJobs ?? 60);
  const onlineAt = box.onlineAt ?? box.since;
  if (!Number.isFinite(box.createdAt) || !Number.isFinite(onlineAt) || !Number.isFinite(ttl) || !Number.isFinite(maxAge) || !Number.isFinite(maxJobs) || !durations.every(Number.isFinite) || (box.jobs ?? 0) + 1 >= maxJobs) return baseSeconds;
  const headroom = Math.max(300, 1200 + Math.max(0, ...durations) * 60);
  const safeUntil = box.createdAt + Math.min(maxAge, ttl - headroom) * 1000;
  const safeHold = Math.max(0, Math.floor((safeUntil - onlineAt) / 1000));
  return Math.min(nominalSeconds, safeHold);
}
