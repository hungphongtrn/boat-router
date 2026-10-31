const WINDOWS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const validCount = n => Number.isSafeInteger(n) && n >= 0;
// Convert the provider response without inventing missing counters. The
// admission path rejects a missing or stale window rather than guessing.
export function snapshotLimits(limits, at) {
  const fields = { minute: 'perMinute', hour: 'perHour', day: 'perDay' };
  const windows = {};
  for (const [name, field] of Object.entries(fields)) {
    const reported = limits?.starts?.[name];
    const rawLimits = [reported?.limit, limits?.startLimits?.[field]].filter(n => n !== undefined && n !== null);
    if (rawLimits.some(n => !validCount(n) || n < 1)) continue;
    const candidates = rawLimits;
    if (!candidates.length || !validCount(reported?.used)) continue;
    const providerLimit = validCount(reported?.limit) && reported.limit > 0 ? reported.limit : limits?.startLimits?.[field];
    if (reported.remaining !== undefined && (!validCount(reported.remaining) || !validCount(providerLimit) || reported.remaining > providerLimit)) continue;
    const byRemaining = validCount(reported?.remaining) ? providerLimit - reported.remaining : 0;
    windows[name] = { limit: Math.min(...candidates), used: Math.max(reported.used, byRemaining) };
  }
  const active = limits?.activeSandboxes, maxActive = limits?.maxActiveSandboxes;
  const concurrency = validCount(active) && validCount(maxActive) && maxActive > 0 ? { active, limit: maxActive } : null;
  return { at: limits?.observedAt ?? at, canStart: limits?.canStart === true && limits?.checkoutRequired !== true && !['past_due', 'unpaid', 'canceled'].includes(limits?.billingStatus), windows, concurrency };
}
function projectCap(policy, project, now) {
  const config = policy.projects?.[project];
  const override = config?.startsPerDayOverride;
  if (override) {
    const until = Date.parse(override.until);
    if (!Number.isFinite(until) || !validCount(override.value) || override.value < 1) throw new TypeError('invalid project cap override');
    if (now < until) return override.value;
  }
  const ceiling = config?.startsPerDay;
  if (ceiling != null && (!validCount(ceiling) || ceiling < 1)) throw new TypeError('invalid project cap');
  return ceiling;
}

export class AccountLedger {
  constructor(storage, policy, now = Date.now) { Object.assign(this, { storage, policy, now }); this.key = policy.ledgerKey ?? 'account:ledger'; }
  async enqueue(project, key, at = this.now(), jobId, options) { return this.enqueueBatch(project, [key], at, jobId, options); }
  async enqueueBatch(project, keys, at = this.now(), jobId, { pool = false, label } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project) || !Array.isArray(keys) || keys.length < 1 || keys.length > 64 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) || !Number.isFinite(at)) throw new TypeError('invalid start request');
    const group = JSON.stringify([...keys].sort());
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key) ?? { claims: {}, waiting: [] };
      const claims = keys.map(key => state.claims[key]);
      if (claims.some(claim => claim && claim.project !== project)) throw new Error('claim belongs to another project');
      if (claims.every(Boolean)) return;
      if (claims.some(Boolean)) throw new Error('partial batch');
      const waiting = keys.map(key => state.waiting.find(item => item.key === key));
      if (waiting.some(item => item && (item.project !== project || (item.group ?? JSON.stringify([item.key])) !== group))) throw new Error('request belongs to another batch');
      if (waiting.some(Boolean) && !waiting.every(Boolean)) throw new Error('partial batch');
      if (!waiting.some(Boolean)) for (const key of keys) state.waiting.push({ project, key, at, group, ...(pool ? { pool: true, ...(typeof label === 'string' ? { label } : {}) } : {}), ...(keys.length === 1 && Number.isSafeInteger(jobId) && jobId > 0 ? { jobId } : {}) });
      else if (keys.length === 1 && Number.isSafeInteger(jobId) && jobId > 0) waiting[0].jobId = jobId;
      if (pool) for (const item of waiting) if (item) { item.pool = true; if (typeof label === 'string') item.label = label; }
      await tx.put(this.key, state);
    });
  }
  async clearLegacyWaiters(project) {
    return this.storage.transaction(async tx => {
      if (!['on', 'drain'].includes(await tx.get(`project:${project}:pool:mode`)) || !(await tx.get(`project:${project}:pool:migrated`))?.done) return;
      const state = await tx.get(this.key);
      if (!state) return;
      const waiting = state.waiting.filter(item => item.project !== project || item.pool === true);
      if (waiting.length !== state.waiting.length) await tx.put(this.key, { ...state, waiting });
    });
  }
  async withdraw(project, key) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key);
      if (!state) return false;
      const before = state.waiting.length;
      const item = state.waiting.find(item => item.key === key && item.project === project);
      if (!item) return false;
      const group = item.group ?? JSON.stringify([item.key]);
      state.waiting = state.waiting.filter(entry => entry.project !== project || (entry.group ?? JSON.stringify([entry.key])) !== group);
      if (state.waiting.length === before) return false;
      await tx.put(this.key, state);
      return true;
    });
  }
  // A cancelled request must not hold the head of the account queue. Only a
  // pending claim is refundable: a provider call may already have happened
  // for every other state, even if its response was lost.
  async abandon(project, key) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key);
      if (!state) return false;
      const item = state.waiting.find(entry => entry.project === project && entry.key === key);
      if (item) {
        const group = item.group ?? JSON.stringify([item.key]);
        state.waiting = state.waiting.filter(entry => entry.project !== project || (entry.group ?? JSON.stringify([entry.key])) !== group);
      }
      const claim = state.claims[key];
      const cancelled = claim?.project === project && claim.status === 'pending';
      if (cancelled) delete state.claims[key];
      if (item || cancelled) await tx.put(this.key, state);
      return Boolean(item || cancelled);
    });
  }
  async admit(project, key, snapshot, options) { return this.admitBatch(project, [key], snapshot, options); }
  async admitBatch(project, keys, snapshot, { pool = false } = {}) {
    if (!Array.isArray(keys) || keys.length < 1 || keys.length > 64 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key))) throw new TypeError('invalid start batch');
    const now = this.now();
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key) ?? { claims: {}, waiting: [] };
      const existing = keys.map(key => state.claims[key]);
      if (existing.some(claim => claim && claim.project !== project)) throw new Error('claim belongs to another project');
      if (existing.every(Boolean)) return { ok: true, recovered: true, ...(keys.length === 1 ? { status: existing[0].status } : { statuses: existing.map(claim => claim.status) }) };
      if (existing.some(Boolean)) return { ok: false, reason: 'partial_batch' };
      const group = JSON.stringify([...keys].sort());
      if (keys.some(key => !state.waiting.some(item => item.key === key && item.project === project && (item.group ?? JSON.stringify([item.key])) === group))) return { ok: false, reason: 'not_queued' };
      if (!snapshot || !Number.isFinite(snapshot.at) || snapshot.at > now || now - snapshot.at > 30_000 || snapshot.canStart !== true) return { ok: false, reason: 'limits_unavailable' };
      const margin = this.policy.margin ?? 0;
      if (!Number.isFinite(margin) || margin < 0 || margin >= 1) throw new TypeError('invalid margin');
      const dayReserve = this.policy.dayReserve ?? (this.policy.defaultDayReserve ?? 0);
      if (!validCount(dayReserve)) throw new TypeError('invalid day reserve');
      const claims = Object.values(state.claims);
      if (this.policy.requireConcurrency) {
        const concurrency = snapshot.concurrency;
        if (!concurrency || !validCount(concurrency.active) || !validCount(concurrency.limit) || concurrency.limit < 1) return { ok: false, reason: 'limits_unavailable' };
        // The provider snapshot includes existing boxes. Claims that may not
        // be reflected in that snapshot must also occupy account slots.
        const unobserved = claims.filter(c => c.status !== 'created' || (c.settledAt ?? c.at) >= snapshot.at).length;
        if (concurrency.active + unobserved + keys.length > concurrency.limit) return { ok: false, reason: 'concurrency' };
      }
      for (const [name, span] of Object.entries(WINDOWS)) {
        const provider = snapshot.windows?.[name];
        const configured = this.policy.starts?.[name];
        if (!provider || !validCount(provider.limit) || !validCount(provider.used) || (configured != null && !validCount(configured)) || provider.limit < 1) return { ok: false, reason: 'limits_unavailable' };
        const windowMargin = this.policy.windowMargins?.[name] ?? margin;
        if (!Number.isFinite(windowMargin) || windowMargin < 0 || windowMargin >= 1) throw new TypeError('invalid window margin');
        const cap = Math.max(0, Math.min(configured ?? Infinity, Math.floor(provider.limit * (1 - windowMargin))) - (name === 'day' ? dayReserve : 0));
        const local = claims.filter(c => (c.settledAt ?? c.at) > now - span || c.status !== 'created');
        const recent = local.filter(c => (c.settledAt ?? c.at) >= snapshot.at || c.status !== 'created').length;
        if ((configured != null && local.length + keys.length > configured) || provider.used + recent + keys.length > cap) return { ok: false, reason: `${name}_cap` };
      }
      const ceiling = projectCap(this.policy, project, now);
      if (ceiling != null && claims.filter(c => c.project === project && ((c.settledAt ?? c.at) > now - WINDOWS.day || c.status !== 'created')).length + keys.length > ceiling) return { ok: false, reason: 'project_cap' };
      const pacing = this.policy.poolPacing;
      const fromPct = pacing?.fromPct ?? 0.7;
      if (pacing?.enabled === true && (!Number.isFinite(fromPct) || fromPct < 0 || fromPct > 1)) throw new TypeError('invalid pool pacing threshold');
      const pacingActive = pacing?.enabled === true && Math.max(snapshot.windows.day.used / snapshot.windows.day.limit, snapshot.windows.hour.used / snapshot.windows.hour.limit) >= fromPct;
      const eligible = [], poolComplete = new Map(), poolStatuses = new Map();
      for (const item of state.waiting) {
        if (item.pool) {
          if (!poolComplete.has(item.project)) {
            let complete = await tx.get(`project:${item.project}:pool:snapshot-complete`);
            if (complete === undefined) complete = (await tx.get(`project:${item.project}:pool:snapshot`))?.complete;
            poolComplete.set(item.project, complete);
          }
          const statusKey = JSON.stringify([item.project, item.label ?? null]);
          if (!poolStatuses.has(statusKey)) poolStatuses.set(statusKey, item.label == null
            ? [...(await tx.list({ prefix: `project:${item.project}:pool:status:` })).values()]
            : [await tx.get(`project:${item.project}:pool:status:${item.label}`)]);
          const statuses = poolStatuses.get(statusKey);
          if (poolComplete.get(item.project) === false || statuses.some(status => status?.reason && !status.reason.startsWith('ledger:'))) continue;
        }
        const cap = projectCap(this.policy, item.project, now);
        const group = item.group ?? JSON.stringify([item.key]);
        const count = state.waiting.filter(entry => entry.project === item.project && (entry.group ?? JSON.stringify([entry.key])) === group).length;
        if (!pool && item.pool && pacingActive) {
          const day = snapshot.windows.day, limit = Math.min(day.limit, this.policy.starts?.day ?? Infinity);
          const unobserved = claims.filter(c => (c.settledAt ?? c.at) >= snapshot.at || c.status !== 'created').length;
          const burst = pacing.burst ?? 1, reserve = pacing.reserveStarts ?? 0, marginPct = pacing.marginPct ?? 10;
          if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct >= 100 || !validCount(burst) || burst < 1 || !validCount(reserve)) throw new TypeError('invalid pool pacing');
          const previous = state.poolPacing;
          const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, now - previous.at) * limit * (1 - marginPct / 100) / WINDOWS.day) : burst;
          if (day.used + unobserved + count + reserve > limit || tokens < count) continue;
        }
        if (cap == null || claims.filter(c => c.project === item.project && ((c.settledAt ?? c.at) > now - WINDOWS.day || c.status !== 'created')).length + count <= cap) eligible.push(item);
      }
      eligible.sort((a, b) => a.at - b.at || (a.group ?? JSON.stringify([a.key])).localeCompare(b.group ?? JSON.stringify([b.key])) || a.key.localeCompare(b.key));
      const selected = new Set(eligible.slice(0, keys.length).map(item => item.key));
      if (selected.size !== keys.length || keys.some(key => !selected.has(key))) return { ok: false, reason: 'fairness' };
      if (pool && pacingActive) {
        const marginPct = pacing.marginPct ?? 10, burst = pacing.burst ?? 1, reserve = pacing.reserveStarts ?? 0;
        if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct >= 100 || !validCount(burst) || burst < 1 || !validCount(reserve)) throw new TypeError('invalid pool pacing');
        const day = snapshot.windows.day;
        const cap = Math.min(day.limit, this.policy.starts?.day ?? Infinity);
        const unobserved = claims.filter(c => (c.settledAt ?? c.at) >= snapshot.at || c.status !== 'created').length;
        if (day.used + unobserved + keys.length + reserve > cap) return { ok: false, reason: 'pacing_reserve' };
        const rate = cap * (1 - marginPct / 100) / WINDOWS.day;
        const previous = state.poolPacing;
        const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, now - previous.at) * rate) : burst;
        if (tokens < keys.length) return { ok: false, reason: 'pacing' };
        state.poolPacing = { tokens: tokens - keys.length, at: now };
      }
      for (const key of keys) {
        const jobId = state.waiting.find(item => item.key === key && item.project === project)?.jobId;
        state.claims[key] = { project, at: now, status: 'pending', ...(Number.isSafeInteger(jobId) ? { jobId } : {}) };
      }
      state.waiting = state.waiting.filter(item => !selected.has(item.key));
      await tx.put(this.key, state);
      return { ok: true, recovered: false };
    });
  }
  async cancelPending(project, key) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key), claim = state?.claims[key];
      if (!claim || claim.project !== project || claim.status !== 'pending') return false;
      delete state.claims[key];
      await tx.put(this.key, state);
      return true;
    });
  }
  async begin(project, key, jobId) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key), claim = state?.claims[key];
      if (!claim || claim.project !== project || claim.status !== 'pending') return false;
      claim.status = 'calling';
      claim.callingAt = this.now();
      if (Number.isSafeInteger(jobId) && jobId > 0) claim.jobId = jobId;
      await tx.put(this.key, state);
      return true;
    });
  }
  async claim(key) {
    const state = await this.storage.get(this.key);
    return state?.claims[key] ?? null;
  }
  async resolve(key, status) {
    if (!['created', 'unknown', 'not_created'].includes(status)) throw new TypeError('invalid claim status');
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key);
      if (!state?.claims[key]) return false;
      if (state.claims[key].status === 'created' && status !== 'created') throw new Error('created claim cannot be refunded');
      if (status === 'not_created') delete state.claims[key];
      else {
        if (status === 'created' && state.claims[key].status !== 'created') state.claims[key].settledAt = this.now();
        state.claims[key].status = status;
      }
      await tx.put(this.key, state);
      return true;
    });
  }
}
