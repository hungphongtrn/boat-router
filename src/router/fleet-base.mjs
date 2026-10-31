import { safeLogger } from '../redact.mjs';
import { ApiError, logEvent } from '../domain.mjs';

const terminal = job => ['done', 'attention'].includes(job.phase);

export class FleetBase {
  constructor(storage, env, api, now, logger, options = {}) {
    logger = safeLogger(logger);
    Object.assign(this, { storage, env, api, now, logger, sharedBudget: options.sharedBudget, allowedRepos: options.allowedRepos });
    this.listeners = new Set();
  }
  dueKey(job) { return `due:${String(job.nextAt).padStart(16, '0')}:${job.id}`; }
  async save(tx, next, previous) {
    if (previous && !terminal(previous)) await tx.delete(this.dueKey(previous));
    await tx.put(`job:${next.id}`, next);
    if (!terminal(next)) await tx.put(this.dueKey(next), next.id);
    return next;
  }
  async patch(id, values) {
    return this.storage.transaction(async (tx) => {
      const job = await tx.get(`job:${id}`);
      if (!job) return null;
      const next = { ...job, ...values, updatedAt: this.now() };
      for (const key of ['intentDone', 'intentStarted', 'assignedDone']) next[key] = Boolean(job[key] || values[key]);
      return this.save(tx, next, job);
    });
  }
  policy(name, fallback) {
    const value = Number(this.env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1) throw new ApiError('config', 400);
    return value;
  }
  maxActive() { return this.policy('MAX_ACTIVE', 4); }
  day() { return new Date(this.now()).toISOString().slice(0, 10); }
  async release(job) { await this.storage.delete(`slot:${job.id}`); }
  async emit(event, job, detail, tx) {
    const record = logEvent(this.logger, event, job, detail);
    const save = async store => {
      const entry = { at: this.now(), ...record };
      if (job) {
        const key = `audit:${job.id}`;
        const previous = await store.get(key) ?? [];
        await store.put(key, [...previous, entry].slice(-500));
      }
      if (event.startsWith('alert_')) {
        const alerts = await store.get('alerts') ?? [];
        await store.put('alerts', [...alerts, entry].slice(-200));
      }
      if (event === 'size_downgrade') {
        await store.put('downgrade-count', (await store.get('downgrade-count') ?? 0) + 1);
        await store.put('downgrades', [...(await store.get('downgrades') ?? []), entry].slice(-200));
      }
    };
    if (tx) await save(tx);
    else await this.storage.transaction(save);
    for (const listener of this.listeners) listener({ at: this.now(), ...record });
  }
  async wake(delay = 1000) {
    const alarm = await this.storage.getAlarm();
    const next = this.now() + delay;
    if (alarm === null || alarm > next) await this.storage.setAlarm(next);
  }
}
