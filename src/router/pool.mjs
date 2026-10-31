import { validMachineSize } from './sizes.mjs';

export function poolKey(repo, label) { return JSON.stringify([repo, label]); }
export function configuredPoolSize(config, label) {
  const prefix = config.sizeLabelPrefix;
  return config.sizes?.[label]?.machine ?? (typeof prefix === 'string' && prefix.length > 0 && label.startsWith(prefix) ? label.slice(prefix.length) : undefined);
}
export function poolSize(config, label) {
  const size = configuredPoolSize(config, label);
  if (!validMachineSize(size)) throw new TypeError('Unknown Boat size');
  return size;
}

export function supplyCounts(units, now, cfg = {}) {
  const seconds = (key, fallback) => (cfg[key] ?? fallback) * 1000;
  const within = (at, ms) => Number.isFinite(at) && now < at + ms;
  const counts = {};
  for (const unit of units) {
    const state = unit.state;
    let count = false;
    if (unit.kind === 'foreign') count = unit.snapshotComplete === true && unit.online === true && !unit.busy;
    else if (unit.kind === 'local') {
      if (state === 'claiming' || state === 'pending') count = within(unit.at, seconds('offerSeconds', 30));
      else if (state === 'started') count = !unit.busy && (unit.online === true || (!unit.everOnline && within(unit.startedAt, seconds('onlineGraceSeconds', 120))));
    } else if (unit.kind === 'create') {
      if (state === 'pending') count = true;
      else if (state === 'calling' || state === 'unknown') count = within(unit.callingAt ?? unit.at, seconds('createSoftSeconds', 120));
    } else {
      if (state === 'booting') count = within(unit.since, seconds('bootSoftSeconds', 300));
      else if (state === 'baseline') count = within(unit.since, seconds('bootSoftSeconds', 300));
      else if (state === 'ready') count = true;
      else if (state === 'registering') count = within(unit.since, seconds('registerSeconds', 120));
      else if (state === 'resetting') count = within(unit.since, seconds('resetSoftSeconds', 120));
      else if (state === 'idle') count = !unit.busy && (unit.online === true || (!unit.everOnline && within(unit.startedAt ?? unit.since, seconds('onlineGraceSeconds', 120))));
    }
    if (count) {
      const key = unit.kind === 'foreign' ? 'foreign' : unit.kind === 'local' ? `local:${state}` : unit.kind === 'create' ? `create:${state}` : state;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

export function uncovered(jobs, supply) {
  return [...jobs].sort((a, b) => a.queuedAt - b.queuedAt || a.id - b.id).slice(supply);
}

// Inputs are observations grouped by pool; no job owns a supply unit.
export function plan({ pools, jobs, units, now }) {
  const result = {};
  for (const pool of pools) {
    const demand = jobs.filter(job => job.pool === pool.key && job.status === 'queued');
    const aged = demand.filter(job => !pool.localFirst || job.queuedAt + (pool.offerSeconds ?? 30) * 1000 <= now);
    const counts = supplyCounts(units.filter(unit => unit.pool === pool.key), now, pool);
    const supply = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const reason = pool.reason ?? null;
    result[pool.key] = { D: demand.length, Dboat: aged.length, S: supply, supply: counts,
      localOffer: demand.length > supply, create: reason ? 0 : Math.max(0, aged.length - supply),
      surplus: Math.max(0, supply - demand.length), oldestUncoveredAt: uncovered(demand, supply)[0]?.queuedAt ?? null, reason };
  }
  return result;
}
