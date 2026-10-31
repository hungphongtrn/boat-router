import { defaultWallet } from '../../config/policy.mjs';
import { JitPool, RESET_CHECKS } from './jit-pool.mjs';

class MemoryStorage {
  constructor() { this.values = new Map(); }
  async get(key) { return structuredClone(this.values.get(key)); }
  async put(key, value) { this.values.set(key, structuredClone(value)); }
  async transaction(fn) { return fn(this); }
}

// This replay models only observed job execution intervals. It does not model
// queue arrivals, provider limits, failed starts, reset time, or incomplete jobs.
export async function replayPool(jobs, { idleHoldMs = 1_800_000, maxJobs = 60, maxAgeSeconds = 86_400 } = {}) {
  const storage = new MemoryStorage();
  let time = 0, nextId = 0;
  const account = { reuse: { enabled: true } };
  const projectConfig = { reuse: { mode: 'on', maxJobs, maxAgeSeconds } };
  const pool = new JitPool(storage, {
    register: async (job, generation) => `${job.id}:${generation}`,
    start: async () => {}, removeRunner: async () => {},
    resetAndVerify: async () => Object.fromEntries(RESET_CHECKS.map(key => [key, true])),
  }, () => time);
  const events = [], assigned = new Map(), machines = new Map(), counts = {};
  for (const job of jobs) {
    if (!job.id || !job.project || !Number.isFinite(job.start) || !Number.isFinite(job.end) || job.end < job.start) throw new TypeError('invalid replay job');
    if (assigned.has(job.id)) throw new TypeError('duplicate replay job');
    assigned.set(job.id, null);
    counts[job.project] ??= { completed: 0, starts: 0 };
    // For zero-duration intervals, assignment must precede its own completion.
    events.push({ at: job.start, type: 'start', job });
    events.push({ at: job.end, type: 'end', job });
  }
  const phase = event => event.type === 'start' ? 1 : event.job.start === event.job.end ? 2 : 0;
  events.sort((a, b) => a.at - b.at || phase(a) - phase(b) || String(a.job.id).localeCompare(String(b.job.id)));
  for (const event of events) {
    time = event.at;
    const { job } = event;
    if (event.type === 'end') {
      const machineId = assigned.get(job.id);
      if (!machineId) throw new Error('completion without assignment');
      const result = await pool.finish({ id: String(job.id), machineId }, account, projectConfig);
      if (!result.ok && result.reason !== 'reuse_limit') throw new Error(`completion failed: ${result.reason}`);
      counts[job.project].completed++;
      continue;
    }
    const compatibility = { account: defaultWallet, project: job.project, size: job.size ?? 'large', image: job.image ?? 'trace-image', trust: job.project };
    let machineId;
    for (const [id, key] of machines) {
      if (key !== JSON.stringify(compatibility)) continue;
      const machine = await storage.get(`machine:${id}`);
      if (machine.state !== 'ready' || time - machine.idleSince > idleHoldMs || time - machine.createdAt >= maxAgeSeconds * 1000) continue;
      machineId = id; break;
    }
    if (!machineId) {
      machineId = `sim-${++nextId}`;
      machines.set(machineId, JSON.stringify(compatibility));
      await storage.put(`machine:${machineId}`, { state: 'ready', compatibility, jobs: 0, createdAt: time });
      counts[job.project].starts++;
    }
    const result = await pool.assign({ id: String(job.id), machineId, compatibility }, account, projectConfig);
    if (!result.ok) throw new Error(`assignment failed: ${result.reason}`);
    assigned.set(job.id, machineId);
  }
  return counts;
}
