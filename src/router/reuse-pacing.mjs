import { snapshotLimits } from './ledger.mjs';
import { dynamicPacing } from './dynamic-pacing.mjs';

const samples = new WeakMap();

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
    return sample && Number.isFinite(sample.sampledAt) && sample.sampledAt <= at && at - sample.sampledAt <= 30_000 && Number.isFinite(sample.effectiveStartsPerHour) && sample.effectiveStartsPerHour >= 0
      ? { sampledAt: sample.sampledAt, startsPerHour: sample.effectiveStartsPerHour } : null;
  } catch { return null; }
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
  if (nominalSeconds <= baseSeconds || !enabled || box.drainOnly || !box.baselineHash) return baseSeconds;
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
