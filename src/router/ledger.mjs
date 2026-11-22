import { dynamicPacing } from './dynamic-pacing.mjs';
import { dayLimit, paidExtraBudget, paidExtraEnabled, paidExtraPrice, paidExtraSpend, paidExtraStart, paidExtraSummary, paidStartAllowed, PAID_EXTRA_WINDOW_MS } from './paid-extra.mjs';
const WINDOWS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
const validCount = n => Number.isSafeInteger(n) && n >= 0;
function releaseFloor(state, key) {
  if (Array.isArray(state?.dynamicPacing?.floorStarts)) state.dynamicPacing.floorStarts = state.dynamicPacing.floorStarts.filter(item => item.key !== key);
  if (Array.isArray(state?.dynamicPacing?.floorOverflow)) state.dynamicPacing.floorOverflow = state.dynamicPacing.floorOverflow.filter(item => item.key !== key);
}
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
  return { at: limits?.observedAt ?? at, canStart: limits?.canStart === true && limits?.checkoutRequired !== true && !['past_due', 'unpaid', 'canceled'].includes(limits?.billingStatus), ...(limits?.nextStartDollars === undefined ? {} : { nextStartDollars: limits.nextStartDollars }), windows, concurrency };
}
function projectCap(policy, project, now) {
  if (policy.openStartQueue === true) return null;
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
  async enqueueBatch(project, keys, at = this.now(), jobId, { pool = false, label, client, snapshotRecovery = false } = {}) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(project) || !Array.isArray(keys) || keys.length < 1 || keys.length > 64 || new Set(keys).size !== keys.length || keys.some(key => typeof key !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) || !Number.isFinite(at)) throw new TypeError('invalid start request');
    if (client !== undefined && (typeof client !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(client) || !(this.policy.externalClients?.[client] && (this.policy.externalClients[client].startsPerDay === null || validCount(this.policy.externalClients[client].startsPerDay))))) throw new TypeError('invalid external client');
    const group = JSON.stringify([...keys].sort());
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key) ?? { claims: {}, waiting: [] };
      const claims = keys.map(key => state.claims[key]);
      if (claims.some(claim => claim && (claim.project !== project || claim.client !== client))) throw new Error('claim belongs to another client');
      if (claims.every(Boolean)) return;
      if (claims.some(Boolean)) throw new Error('partial batch');
      const waiting = keys.map(key => state.waiting.find(item => item.key === key));
      if (waiting.some(item => item && (item.project !== project || item.client !== client || (item.group ?? JSON.stringify([item.key])) !== group))) throw new Error('request belongs to another batch');
      if (waiting.some(Boolean) && !waiting.every(Boolean)) throw new Error('partial batch');
      if (!waiting.some(Boolean)) for (const key of keys) state.waiting.push({ project, key, at, group, ...(client ? { client } : {}), ...(pool ? { pool: true, ...(typeof label === 'string' ? { label } : {}) } : {}), ...(keys.length === 1 && Number.isSafeInteger(jobId) && jobId > 0 ? { jobId } : {}) });
      else if (keys.length === 1 && Number.isSafeInteger(jobId) && jobId > 0) waiting[0].jobId = jobId;
      if (pool) for (const item of waiting) if (item) { item.pool = true; if (typeof label === 'string') item.label = label; }
      if (pool && snapshotRecovery && keys.length === 1) {
        const item = state.waiting.find(entry => entry.key === keys[0] && entry.project === project);
        if (item) item.snapshotRecovery = true;
      }
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
  async withdrawPoolWaiters(project) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key);
      if (!state) return;
      const waiting = state.waiting.filter(item => item.project !== project || item.pool !== true);
      if (waiting.length !== state.waiting.length) await tx.put(this.key, { ...state, waiting });
    });
  }
  async clearOrphanPoolWaiters(project, createKeys, hashes) {
    const expected = [...createKeys].sort();
    const valid = new Set(hashes);
    return this.storage.transaction(async tx => {
      if (!['on', 'drain'].includes(await tx.get(`project:${project}:pool:mode`)) || !(await tx.get(`project:${project}:pool:migrated`))?.done) return;
      const prefix = `project:${project}:create:`, actual = []; let startAfter = '';
      for (;;) {
        const page = await tx.list({ prefix, startAfter, limit: 128 });
        actual.push(...[...page.keys()].map(key => key.slice(prefix.length)));
        if (page.size < 128) break;
        startAfter = [...page.keys()].at(-1);
      }
      if (JSON.stringify(actual.sort()) !== JSON.stringify(expected)) return;
      const state = await tx.get(this.key);
      if (!state) return;
      const waiting = state.waiting.filter(item => item.project !== project || item.pool !== true || valid.has(item.key));
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
      if (cancelled) { delete state.claims[key]; releaseFloor(state, key); }
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
      const allowPaidExtra = paidExtraEnabled(this.policy);
      if (this.policy.forbidPaidStarts && snapshot.nextStartDollars !== 0) return { ok: false, reason: 'paid_start_refused' };
      if (allowPaidExtra && !paidStartAllowed(snapshot.nextStartDollars)) return { ok: false, reason: 'paid_start_ceiling' };
      const margin = this.policy.margin ?? 0;
      if (!Number.isFinite(margin) || margin < 0 || margin >= 1) throw new TypeError('invalid margin');
      const dayReserve = this.policy.dayReserve ?? (this.policy.defaultDayReserve ?? 0);
      if (!validCount(dayReserve)) throw new TypeError('invalid day reserve');
      const claims = Object.values(state.claims);
      const ownedDayCap = this.policy.maxOwnedStartsPerDay;
      if (ownedDayCap !== undefined) {
        if (!validCount(ownedDayCap)) throw new TypeError('invalid owned daily start cap');
        const owned = claims.filter(claim => claim.status !== 'created' || (claim.settledAt ?? claim.at) > now - WINDOWS.day).length;
        if (owned + keys.length > ownedDayCap) return { ok: false, reason: 'owned_day_cap' };
      }
      const dynamicEnabled = this.policy.poolPacing?.enabled === true && this.policy.poolPacing?.mode === 'dynamic';
      const unpaced = dynamicEnabled && (this.policy.poolPacing?.unpaced === true || this.policy.poolPacing?.slotBudget === true);
      const dynamic = dynamicEnabled ? dynamicPacing({ snapshot, policy: this.policy, claims, previous: state.dynamicPacing, now }) : null;
      if (dynamicEnabled && !dynamic) return { ok: false, reason: 'limits_unavailable' };
      if (dynamic) {
        state.dynamicPacing = dynamic.state;
        state.pacingStatus = dynamic.status;
        await tx.put(this.key, state);
      }
      if (this.policy.requireConcurrency) {
        const concurrency = snapshot.concurrency;
        if (!concurrency || !validCount(concurrency.active) || !validCount(concurrency.limit) || concurrency.limit < 1) return { ok: false, reason: 'limits_unavailable' };
        // The provider snapshot includes existing boxes. Claims that may not
        // be reflected in that snapshot must also occupy account slots.
        const unobserved = claims.filter(c => c.status !== 'created' || (c.settledAt ?? c.at) >= snapshot.at).length;
        const liveCap = this.policy.liveSandboxCap ?? concurrency.limit;
        if (!validCount(liveCap) || liveCap < 1) throw new TypeError('invalid live sandbox budget');
        if (concurrency.active + unobserved + keys.length > Math.min(concurrency.limit, liveCap)) return { ok: false, reason: 'concurrency' };
      }
      let freeRefusal = null, freeDailyExhausted = false, freeDailyReserved = false, floorRequired = false;
      for (const [name, span] of Object.entries(WINDOWS)) {
        if (dynamic && dynamic.status.hardRemaining[name] < keys.length) return { ok: false, reason: `${name}_cap` };
        if (dynamic && !unpaced && dynamic.status.remaining[name] < keys.length) {
          if (name !== 'day') return { ok: false, reason: `${name}_cap` };
          floorRequired = true;
        }
        const provider = snapshot.windows?.[name];
        const configured = this.policy.starts?.[name];
        if (!provider || !validCount(provider.limit) || !validCount(provider.used) || (configured != null && !validCount(configured)) || provider.limit < 1) return { ok: false, reason: 'limits_unavailable' };
        const windowMargin = this.policy.windowMargins?.[name] ?? margin;
        if (!Number.isFinite(windowMargin) || windowMargin < 0 || windowMargin >= 1) throw new TypeError('invalid window margin');
        const providerWindow = name === 'day' ? dayLimit(provider.limit, configured, allowPaidExtra) : provider.limit;
        const cappedLimit = unpaced ? Math.min(configured ?? Infinity, providerWindow) : dynamicEnabled ? Math.floor(Math.min(configured ?? Infinity, providerWindow) * (1 - windowMargin)) : Math.min(configured ?? Infinity, Math.floor(providerWindow * (1 - windowMargin)));
        const cap = Math.max(0, cappedLimit - (name === 'day' ? (unpaced ? (this.policy.poolPacing.hardDayReserve ?? 0) : dayReserve) : 0));
        const local = claims.filter(c => (c.settledAt ?? c.at) > now - span || c.status !== 'created');
        const recent = local.filter(c => (c.settledAt ?? c.at) >= snapshot.at || c.status !== 'created').length;
        if (name === 'day') {
          freeDailyExhausted = provider.used >= provider.limit;
          freeDailyReserved = !freeDailyExhausted && provider.used + recent + keys.length > provider.limit;
        }
        if ((configured != null && local.length + keys.length > configured) || provider.used + recent + keys.length > cap) {
          if (dynamicEnabled && !unpaced && name === 'day') floorRequired = true;
          else if (name !== 'day' || !pool || this.policy.paidOverflow?.enabled !== true) return { ok: false, reason: `${name}_cap` };
          else freeRefusal = 'day_cap';
        }
      }
      const requested = state.waiting.filter(item => keys.includes(item.key) && item.project === project);
      const client = requested[0]?.client;
      if (requested.some(item => item.client !== client)) throw new Error('mixed client batch');
      if (client) {
        const limit = this.policy.externalClients?.[client]?.startsPerDay;
        if (limit !== null && !validCount(limit)) return { ok: false, reason: 'client_disabled' };
        const reserve = this.policy.externalClients[client].concurrencyReserve ?? 0;
        const concurrency = snapshot.concurrency;
        if (!validCount(reserve) || !concurrency || !validCount(concurrency.active) || !validCount(concurrency.limit)) return { ok: false, reason: 'limits_unavailable' };
        const unobserved = claims.filter(c => c.status !== 'created' || (c.settledAt ?? c.at) >= snapshot.at).length;
        if (concurrency.active + unobserved + keys.length + reserve > concurrency.limit) return { ok: false, reason: 'client_concurrency_reserve' };
        if (limit !== null && claims.filter(c => c.client === client && ((c.settledAt ?? c.at) > now - WINDOWS.day || c.status !== 'created')).length + keys.length > limit) return { ok: false, reason: 'client_cap' };
      }
      const ceiling = projectCap(this.policy, project, now);
      if (ceiling != null && claims.filter(c => c.project === project && ((c.settledAt ?? c.at) > now - WINDOWS.day || c.status !== 'created')).length + keys.length > ceiling) return { ok: false, reason: 'project_cap' };
      const pacing = this.policy.poolPacing;
      const fromPct = pacing?.fromPct ?? 0.7;
      if (pacing?.enabled === true && (!Number.isFinite(fromPct) || fromPct < 0 || fromPct > 1)) throw new TypeError('invalid pool pacing threshold');
      const pacingActive = pacing?.enabled === true && !dynamicEnabled && Math.max(snapshot.windows.day.used / snapshot.windows.day.limit, snapshot.windows.hour.used / snapshot.windows.hour.limit) >= fromPct;
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
          let recovered = false;
          if (item.snapshotRecovery && Number.isSafeInteger(item.jobId)) {
            const proof = await tx.get(`project:${item.project}:snapshot-recovery-proof:${item.key}`);
            const job = await tx.get(`project:${item.project}:gh-job:${item.jobId}`);
            const create = proof?.createKey && await tx.get(`project:${item.project}:create:${proof.createKey}`);
            recovered = proof?.jobId === item.jobId && Number.isFinite(proof.until) && proof.until >= now && job?.status === 'queued' && job.source === 'webhook' && !job.missing && create?.state === 'pending' && create.snapshotRecoveryJobId === item.jobId;
          }
          if ((!recovered && poolComplete.get(item.project) === false) || statuses.some(status => status?.reason && !status.reason.startsWith('ledger:') && !(recovered && status.reason === 'snapshot_incomplete'))) continue;
        }
        const cap = projectCap(this.policy, item.project, now);
        if (item.client) {
          const clientCap = this.policy.externalClients?.[item.client]?.startsPerDay;
          if (clientCap !== null && (!validCount(clientCap) || claims.filter(c => c.client === item.client && ((c.settledAt ?? c.at) > now - WINDOWS.day || c.status !== 'created')).length >= clientCap)) continue;
        }
        const group = item.group ?? JSON.stringify([item.key]);
        const count = state.waiting.filter(entry => entry.project === item.project && (entry.group ?? JSON.stringify([entry.key])) === group).length;
        if (!pool && item.pool && pacingActive) {
          const day = snapshot.windows.day, limit = dayLimit(day.limit, this.policy.starts?.day, allowPaidExtra);
          const unobserved = claims.filter(c => (c.settledAt ?? c.at) >= snapshot.at || c.status !== 'created').length;
          const burst = pacing.burst ?? 1, reserve = pacing.reserveStarts ?? 0, marginPct = pacing.marginPct ?? 10;
          if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct >= 100 || !validCount(burst) || burst < 1 || !validCount(reserve)) throw new TypeError('invalid pool pacing');
          const previous = state.poolPacing;
          const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, now - previous.at) * limit * (1 - marginPct / 100) / WINDOWS.day) : burst;
          // A group wider than the burst would wait forever; it needs a full bucket, not more tokens than the bucket holds.
          if (day.used + unobserved + count + reserve > limit || tokens < Math.min(count, burst)) continue;
        }
        if (cap == null || claims.filter(c => c.project === item.project && ((c.settledAt ?? c.at) > now - WINDOWS.day || c.status !== 'created')).length + count <= cap) eligible.push(item);
      }
      eligible.sort((a, b) => (this.policy.openStartQueue === true ? 0 : Number(Boolean(a.client)) - Number(Boolean(b.client))) || a.at - b.at || (a.group ?? JSON.stringify([a.key])).localeCompare(b.group ?? JSON.stringify([b.key])) || a.key.localeCompare(b.key));
      const selected = new Set(eligible.slice(0, keys.length).map(item => item.key));
      if (selected.size !== keys.length || keys.some(key => !selected.has(key))) return { ok: false, reason: 'fairness' };
      // Floor reservations are account-wide and are stored with the claims in
      // this transaction. They never bypass provider hard limits.
      const useFloor = dynamic && !unpaced && (floorRequired || dynamic.state.credit + 1e-9 < keys.length);
      let useOverflow = false;
      if (useFloor) {
        const floorLimit = pacing.floorStartsPerHour ?? 2, overflowLimit = pacing.floorOverflowPerHour ?? 1;
        if (state.dynamicPacing.floorStarts.length + keys.length > floorLimit) {
          // With the free day window empty, one billed start per hour may pass
          // the spent floor so a queued job is not stranded behind a retired
          // box. The paid-extra budget still bounds it below.
          const overflow = state.dynamicPacing.floorOverflow ?? [];
          if (!floorRequired || !allowPaidExtra || !validCount(overflowLimit) || overflowLimit < 1 || overflow.length + keys.length > overflowLimit) return { ok: false, reason: floorRequired ? 'day_cap' : 'pacing' };
          useOverflow = true;
        }
      }
      if ((pool || client) && pacingActive) {
        const marginPct = pacing.marginPct ?? 10, burst = pacing.burst ?? 1, reserve = pacing.reserveStarts ?? 0;
        if (!Number.isFinite(marginPct) || marginPct < 0 || marginPct >= 100 || !validCount(burst) || burst < 1 || !validCount(reserve)) throw new TypeError('invalid pool pacing');
        const day = snapshot.windows.day;
        const cap = dayLimit(day.limit, this.policy.starts?.day, allowPaidExtra);
        const unobserved = claims.filter(c => (c.settledAt ?? c.at) >= snapshot.at || c.status !== 'created').length;
        if (day.used + unobserved + keys.length + reserve > cap) freeRefusal ??= 'pacing_reserve';
        const rate = cap * (1 - marginPct / 100) / WINDOWS.day;
        const previous = state.poolPacing;
        const tokens = previous ? Math.min(burst, previous.tokens + Math.max(0, now - previous.at) * rate) : burst;
        if (tokens < keys.length) freeRefusal ??= 'pacing';
        if (!freeRefusal) state.poolPacing = { tokens: tokens - keys.length, at: now };
      }
      let paid = false;
      if (freeRefusal) {
        if (freeDailyReserved) return { ok: false, reason: freeRefusal };
        const cfg = this.policy.paidOverflow;
        if (!pool || cfg?.enabled !== true) return { ok: false, reason: freeRefusal };
        // Some accounts permit paid starts only after the provider's free
        // allowance is exhausted. Keep pacing and configured limits intact
        // before that point.
        if (cfg.onlyAfterFreeExhausted === true && !freeDailyExhausted) return { ok: false, reason: freeRefusal };
        const wait = cfg.afterWaitMinutes ?? 15, max = cfg.maxPaidStartsPerDay ?? 40, price = cfg.pricePerStartUsd ?? 0.05;
        if (!Number.isFinite(wait) || wait < 0 || !validCount(max) || !Number.isFinite(price) || price < 0) throw new TypeError('invalid paid overflow');
        const oldest = eligible[0];
        const spacing = cfg.minSecondsBetweenPaid ?? 60;
        if (!Number.isFinite(spacing) || spacing < 0) throw new TypeError('invalid paid overflow spacing');
        const count = claims.filter(c => c.paid && (c.status !== 'created' || (c.settledAt ?? c.at) > now - WINDOWS.day)).length;
        if (keys.length !== 1 || !oldest?.pool || oldest.key !== keys[0] || now - oldest.at < wait * 60_000 || (freeDailyExhausted && (count >= max || !this.paidTick || this.paidTick.used || (state.lastPaidCallAt != null && now - state.lastPaidCallAt < spacing * 1000)))) return { ok: false, reason: freeRefusal };
        paid = freeDailyExhausted;
      }
      // A billed extra start is recorded against the account's rolling 30-day
      // budget. Free starts are never counted and never refused, and an account
      // without a budget keeps today's behaviour.
      const budget = allowPaidExtra ? paidExtraBudget(this.policy) : null;
      const extra = allowPaidExtra && paidExtraStart(snapshot.windows.day, snapshot.nextStartDollars);
      const extraPrice = extra ? paidExtraPrice(snapshot.nextStartDollars) : 0;
      const extraSpend = budget != null ? paidExtraSpend(state.paidExtraSpend, now) : [];
      if (budget != null && extra) {
        const spent = extraSpend.reduce((total, record) => total + record.dollars, 0);
        if (spent + extraPrice * keys.length > budget + 1e-9) return { ok: false, reason: 'paid_extra_budget', nextAt: (extraSpend.length ? Math.min(...extraSpend.map(record => record.at)) : now) + PAID_EXTRA_WINDOW_MS };
      }
      if (dynamic) {
        if (useFloor) {
          if (useOverflow) state.dynamicPacing.floorOverflow.push(...keys.map(key => ({ key, at: now })));
          else state.dynamicPacing.floorStarts.push(...keys.map(key => ({ key, at: now })));
        }
        else state.dynamicPacing.credit = Math.max(0, state.dynamicPacing.credit - keys.length);
        state.pacingStatus.burstCredit = state.dynamicPacing.credit;
        for (const name of Object.keys(state.pacingStatus.remaining)) state.pacingStatus.remaining[name] = Math.max(0, state.pacingStatus.remaining[name] - keys.length);
      }
      for (const key of keys) {
        const jobId = state.waiting.find(item => item.key === key && item.project === project)?.jobId;
        state.claims[key] = { project, at: now, status: 'pending', ...(client ? { client } : {}), ...(paid ? { paid: true, pricePerStartUsd: this.policy.paidOverflow.pricePerStartUsd ?? 0.05 } : {}), ...(Number.isSafeInteger(jobId) ? { jobId } : {}) };
      }
      state.waiting = state.waiting.filter(item => !selected.has(item.key));
      if (budget != null && extra) state.paidExtraSpend = [...extraSpend, ...keys.map(() => ({ at: now, dollars: extraPrice }))];
      await tx.put(this.key, state);
      if (paid) { this.paidTick.used = true; this.paidTick.key = keys[0]; }
      return { ok: true, recovered: false, ...(paid ? { paid: true } : {}) };
    });
  }
  async cancelPending(project, key) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key), claim = state?.claims[key];
      if (!claim || claim.project !== project || claim.status !== 'pending') return false;
      delete state.claims[key];
      releaseFloor(state, key);
      await tx.put(this.key, state);
      return true;
    });
  }
  async begin(project, key, jobId) {
    return this.storage.transaction(async tx => {
      const state = await tx.get(this.key), claim = state?.claims[key];
      if (!claim || claim.project !== project || claim.status !== 'pending') return false;
      if (claim.paid && (!this.paidTick || (this.paidTick.used && this.paidTick.key !== key))) return false;
      const now = this.now();
      if (claim.paid) {
        const spacing = this.policy.paidOverflow?.minSecondsBetweenPaid ?? 60;
        if (!Number.isFinite(spacing) || spacing < 0) throw new TypeError('invalid paid overflow spacing');
        if (state.lastPaidCallAt != null && now - state.lastPaidCallAt < spacing * 1000) return false;
        state.lastPaidCallAt = now;
      }
      claim.status = 'calling';
      claim.callingAt = now;
      if (Number.isSafeInteger(jobId) && jobId > 0) claim.jobId = jobId;
      await tx.put(this.key, state);
      if (claim.paid) { this.paidTick.used = true; this.paidTick.key = key; }
      return true;
    });
  }
  async paidStatus() {
    const state = await this.storage.get(this.key);
    const claims = Object.values(state?.claims ?? {}).filter(c => c.paid && (c.status !== 'created' || (c.settledAt ?? c.at) > this.now() - WINDOWS.day));
    return { count: claims.length, estimatedUsd: claims.reduce((sum, c) => sum + c.pricePerStartUsd, 0) };
  }
  // The rolling 30-day spend against the account's budget, for operators.
  async paidExtraStatus() {
    const state = await this.storage.get(this.key);
    return paidExtraSummary(state?.paidExtraSpend, this.policy, this.now());
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
      if (status === 'not_created') { delete state.claims[key]; releaseFloor(state, key); }
      else {
        if (status === 'created' && state.claims[key].status !== 'created') state.claims[key].settledAt = this.now();
        state.claims[key].status = status;
      }
      await tx.put(this.key, state);
      return true;
    });
  }
}
