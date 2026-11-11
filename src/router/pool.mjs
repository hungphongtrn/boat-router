import { validMachineSize } from './sizes.mjs';
import { boxSupply } from './box-state.mjs';

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

export function localOfferActive(unit, now, cfg = {}) {
  if (!unit.host || unit.busy || !['claiming', 'pending', 'started'].includes(unit.state) || !Number.isFinite(unit.at)) return false;
  const hold = Math.max(0, Math.min(180, Number(cfg.registeredHoldSeconds) || 0)) * 1000;
  if (unit.state === 'started' && hold && Number.isFinite(unit.startedAt)) return now < Math.min(unit.startedAt + hold, unit.at + 30_000 + hold);
  return now < unit.at + 30_000;
}

export function supplyCounts(units, now, cfg = {}) {
  const seconds = (key, fallback) => (cfg[key] ?? fallback) * 1000;
  const within = (at, ms) => Number.isFinite(at) && now < at + ms;
  const counts = {};
  for (const unit of units) {
    const state = unit.state;
    let count = false;
    if (unit.kind === 'held-boat') count = true;
    else if (unit.kind === 'foreign') count = unit.snapshotComplete === true && unit.online === true && !unit.busy;
    else if (unit.kind === 'local') {
      count = localOfferActive(unit, now, cfg);
    } else if (unit.kind === 'create') {
      if (state === 'pending') count = true;
      else if (state === 'calling' || state === 'unknown') count = within(unit.callingAt ?? unit.at, seconds('createSoftSeconds', 120));
    } else count = boxSupply(unit, now, cfg);
    if (count) {
      const key = unit.kind === 'foreign' ? 'foreign' : unit.kind === 'local' ? `local:${state}` : unit.kind === 'create' ? `create:${state}` : state;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

// `compare` orders the jobs (lane rank, then queuedAt); the default is the old FIFO.
export function uncovered(jobs, supply, compare = (a, b) => a.queuedAt - b.queuedAt || (typeof a.id === 'number' && typeof b.id === 'number' ? a.id - b.id : String(a.id).localeCompare(String(b.id)))) {
  return [...jobs].sort(compare).slice(supply);
}

// Inputs are observations grouped by pool; no job owns a supply unit.
export function plan({ pools, jobs, units, now }) {
  const result = {};
  for (const pool of pools) {
    const demand = jobs.filter(job => job.pool === pool.key && job.status === 'queued');
    const aged = demand;
    const counts = supplyCounts(units.filter(unit => unit.pool === pool.key), now, pool);
    const supply = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const reason = pool.reason ?? null;
    result[pool.key] = { D: demand.length, Dboat: aged.length, S: supply, supply: counts,
      localOffer: demand.length > supply, create: reason ? 0 : Math.max(0, aged.length - supply),
      surplus: Math.max(0, supply - demand.length), oldestUncoveredAt: uncovered(demand, supply)[0]?.queuedAt ?? null, reason };
  }
  return result;
}
