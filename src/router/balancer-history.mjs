const HOUR_MS = 3600000;
const MAX_SAMPLES = 32;
const MAX_KEYS = 64;
const MAX_AGE_MS = 7 * 86400000;

export function historyKey(job) {
  if (typeof job?.jobName !== 'string' || !job.jobName || typeof job.workflowName !== 'string' || !job.workflowName) return null;
  // Matrix values change on each run. Keep the workflow and base job name.
  return JSON.stringify([job.workflowName, job.jobName.replace(/ \(.*/, '')]);
}

export function arrivalRate(entry, now) {
  if (!entry || !Number.isFinite(entry.at) || !Number.isFinite(entry.rate) || entry.rate < 0 || now < entry.at || now - entry.at > 86400000) return null;
  return entry.rate * Math.exp(-(now - entry.at) / HOUR_MS);
}

export function runtimeQuantiles(entry, now) {
  if (!entry || !Number.isFinite(entry.at) || now < entry.at || now - entry.at > MAX_AGE_MS || !Array.isArray(entry.samples) || !entry.samples.length || entry.samples.some(n => !Number.isFinite(n) || n <= 0)) return null;
  const samples = [...entry.samples].sort((a, b) => a - b);
  const pick = q => samples[Math.ceil(q * samples.length) - 1];
  return { medianSeconds: pick(0.5), p75Seconds: pick(0.75), samples: samples.length };
}

export class BalancerHistory {
  constructor(storage, now = Date.now) { Object.assign(this, { storage, now }); }
  async arrival(id) {
    const now = this.now();
    await this.storage.transaction(async tx => {
      const job = await tx.get(`job:${id}`);
      if (!job || job.balancerArrivalObserved || job.status !== 'queued' || typeof job.size !== 'string' || !job.size) return;
      const state = await tx.get('balancer:history') ?? { arrivals: {}, runtimes: {} };
      const previous = state.arrivals[job.size];
      if (!previous || now >= previous.at) state.arrivals[job.size] = { at: now, rate: Math.min(1000, (arrivalRate(previous, now) ?? 0) + 1) };
      await tx.put('balancer:history', state);
      await tx.put(`job:${id}`, { ...job, balancerArrivalObserved: true });
    });
  }
  async runtime(id) {
    const now = this.now();
    await this.storage.transaction(async tx => {
      const job = await tx.get(`job:${id}`), key = historyKey(job);
      const generation = job?.generation;
      if (!job || !key || !Number.isSafeInteger(generation) || generation < 1 || job.balancerRuntimeGeneration === generation || !Number.isFinite(job.runnerStartedAt) || now <= job.runnerStartedAt) return;
      const state = await tx.get('balancer:history') ?? { arrivals: {}, runtimes: {} };
      const entry = state.runtimes[key];
      const samples = Array.isArray(entry?.samples) && now >= entry.at && now - entry.at <= MAX_AGE_MS ? entry.samples : [];
      state.runtimes[key] = { at: now, samples: [...samples, (now - job.runnerStartedAt) / 1000].slice(-MAX_SAMPLES) };
      const keys = Object.keys(state.runtimes).sort((a, b) => state.runtimes[b].at - state.runtimes[a].at || a.localeCompare(b));
      for (const stale of keys.slice(MAX_KEYS)) delete state.runtimes[stale];
      await tx.put('balancer:history', state);
      await tx.put(`job:${id}`, { ...job, balancerRuntimeGeneration: generation });
    });
  }
  async read() { return await this.storage.get('balancer:history') ?? { arrivals: {}, runtimes: {} }; }
}
