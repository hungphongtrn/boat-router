import { ApiError } from './domain.mjs';

const WINDOWS = [
  { name: 'minute', limit: 'perMinute', setting: 'MAX_STARTS_PER_MINUTE', fallback: 12, span: 60_000 },
  { name: 'hour', limit: 'perHour', setting: 'MAX_STARTS_PER_HOUR', fallback: 60, span: 3600_000 },
  { name: 'day', limit: 'perDay', setting: 'MAX_STARTS_PER_DAY', fallback: 100, span: 86400_000 },
];
function positive(value) { return Number.isSafeInteger(value) && value > 0; }
function setting(env, name, fallback) {
  const value = Number(env[name] ?? fallback);
  if (!positive(value)) throw new ApiError('config', 400, 'invalid_budget');
  return value;
}
function calendar(window, now) {
  return window.name === 'day' ? `starts:${new Date(now).toISOString().slice(0, 10)}` :
    `starts-${window.name}:${Math.floor(now / window.span)}`;
}

export class Budget {
  constructor(storage, env, now = Date.now) { Object.assign(this, { storage, env, now }); }
  snapshot(limits, now) {
    const paced = this.env.START_PACING === 'true';
    const margin = Number(this.env.START_SAFETY_MARGIN ?? 0.1);
    if (!Number.isFinite(margin) || margin <= 0 || margin >= 1) throw new ApiError('config', 400, 'invalid_margin');
    const windows = WINDOWS.map(window => {
      const live = [limits.startLimits?.[window.limit], limits.starts?.[window.name]?.limit].filter(positive);
      const configured = setting(this.env, window.setting, window.fallback);
      const cap = live.length ? Math.min(...live, configured) : null;
      const reported = limits.starts?.[window.name];
      const used = Number.isSafeInteger(reported?.used) && reported.used >= 0 ? reported.used : null;
      const remaining = Number.isSafeInteger(reported?.remaining) && reported.remaining >= 0 ? reported.remaining : null;
      const providerCap = positive(reported?.limit) ? reported.limit : limits.startLimits?.[window.limit];
      const observed = used === null ? null : Math.max(used, positive(providerCap) && remaining !== null ? providerCap - remaining : 0);
      const safe = cap === null ? null : paced ? Math.max(0, Math.min(cap - 1, Math.floor(cap * (1 - margin)))) : cap;
      return { ...window, cap, safe, observed };
    });
    return { at: limits.observedAt ?? now, canStart: limits.canStart === true, windows,
      active: Number.isSafeInteger(limits.activeSandboxes) ? limits.activeSandboxes : null,
      maxActive: Math.min(setting(this.env, 'MAX_ACTIVE', 4), positive(limits.maxActiveSandboxes) ? limits.maxActiveSandboxes : Infinity) };
  }
  async admit(key, limits, { pacing = true } = {}) {
    const now = this.now();
    const snapshot = this.snapshot(limits, now);
    return this.storage.transaction(async tx => {
      if (await tx.get(`start-claim:${key}`)) return { ok: true, recovered: true };
      const previous = await tx.get('start-budget') ?? {};
      const history = (previous.history ?? []).filter(entry => entry.at > now - 86400_000);
      const recent = history.filter(entry => entry.at >= snapshot.at).length;
      const elapsed = Math.max(0, now - (previous.updatedAt ?? now));
      const tokens = {};
      for (const window of snapshot.windows.filter(window => window.name !== 'minute')) {
        const burst = Math.min(window.safe ?? 0, setting(this.env, `START_${window.name.toUpperCase()}_BURST`, Math.max(1, Math.floor((window.safe ?? 0) / 2))));
        const old = previous.tokens?.[window.name];
        tokens[window.name] = { capacity: burst, available: old ? Math.min(burst, old.available + elapsed * (window.safe ?? 0) / window.span) :
          Math.min(burst, Math.max(0, (window.safe ?? 0) - (window.observed ?? 0))) };
      }
      const state = { history, tokens, updatedAt: now, snapshot };
      const refuse = async (reason, nextAt) => {
        await tx.put('start-budget', state);
        return { ok: false, reason, nextAt: Math.max(now + 1000, nextAt) };
      };
      const paced = this.env.START_PACING === 'true';
      if (paced && (snapshot.windows.some(window => window.cap === null || window.observed === null) ||
        !Number.isFinite(snapshot.at) || now - snapshot.at > 30_000 || snapshot.at > now)) return refuse('limits_unavailable', now + 5000);
      const slots = await tx.list({ prefix: 'slot:' });
      if (slots.size > snapshot.maxActive || snapshot.active !== null && snapshot.active + recent >= snapshot.maxActive) {
        return refuse('concurrency', now + 1000);
      }
      // Limit this router’s share of account-wide start windows.
      for (const window of WINDOWS) {
        const raw = this.env[`SHARE_STARTS_PER_${window.name.toUpperCase()}`];
        if (raw === undefined) continue;
        const share = setting(this.env, `SHARE_STARTS_PER_${window.name.toUpperCase()}`, 1);
        const mine = history.filter(entry => entry.at > now - window.span);
        if (mine.length >= share) return refuse(`${window.name}_share`, mine[mine.length - share].at + window.span);
      }
      for (const window of snapshot.windows) {
        if (paced) {
          const local = history.filter(entry => entry.at > now - window.span);
          const used = Math.max(local.length, window.observed + recent);
          if (used >= window.safe) return refuse(`${window.name}_headroom`, local.length >= window.safe && window.safe > 0 ?
            local[local.length - window.safe].at + window.span : now + 5000);
        } else if ((await tx.get(calendar(window, now)) ?? 0) >= (window.cap ?? setting(this.env, window.setting, window.fallback))) {
          return refuse(`${window.name}_guard`, (Math.floor(now / window.span) + 1) * window.span);
        }
      }
      if (!snapshot.canStart) return refuse('provider_start_unavailable', now + 5000);
      if (paced && pacing) {
        for (const window of snapshot.windows.filter(window => window.name !== 'minute')) {
          if (tokens[window.name].available < 1) return refuse(`${window.name}_pacing`, now +
            (1 - tokens[window.name].available) * window.span / Math.max(1, window.safe));
        }
        for (const token of Object.values(tokens)) token.available -= 1;
      } else if (paced) {
        for (const token of Object.values(tokens)) token.available = Math.max(0, token.available - 1);
      }
      for (const window of WINDOWS) {
        const name = calendar(window, now);
        await tx.put(name, (await tx.get(name) ?? 0) + 1);
      }
      history.push({ key, at: now });
      await tx.put('start-claim:' + key, { at: now });
      await tx.put('start-budget', state);
      return { ok: true };
    });
  }
  async status() {
    const state = await this.storage.get('start-budget');
    if (!state) return { scope: 'not_observed', windows: null, tokens: null, observed_at: null };
    const now = this.now();
    const windows = {};
    const recent = state.history.filter(entry => entry.at >= state.snapshot.at).length;
    for (const window of state.snapshot.windows) {
      const local = state.history.filter(entry => entry.at > now - window.span).length;
      const used = window.observed === null ? local : Math.max(local, window.observed + recent);
      windows[window.name] = { cap: window.cap, safe_cap: window.safe, used,
        remaining: Math.max(0, (window.safe ?? 0) - used) };
    }
    const ours = {};
    for (const window of WINDOWS) ours[window.name] = { used: state.history.filter(entry => entry.at > now - window.span).length, share: this.env[`SHARE_STARTS_PER_${window.name.toUpperCase()}`] ?? null };
    return { scope: 'account_snapshot_plus_local_reservations', windows, ours, tokens: state.tokens, observed_at: state.snapshot.at,
      stale: now - state.snapshot.at > 30_000 };
  }
}
