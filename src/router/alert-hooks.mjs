import { safeLogger } from '../redact.mjs';

const encoder = new TextEncoder();

export class AlertHooks {
  constructor(storage, configs, env, { now = Date.now, fetcher = fetch.bind(globalThis), waitUntil = () => {}, deployment = 'unknown' } = {}) {
    Object.assign(this, { storage, configs, env, now, fetcher, waitUntil, deployment });
    this.logError = safeLogger((...args) => console.error(...args));
  }

  async observe(event, { project, value, limit, active, window, previousActive } = {}) {
    if (!Array.isArray(this.configs)) return;
    for (const [index, config] of this.configs.entries()) {
      if (!config.on?.includes(event) && !(event === 'breaker_open' && config.on?.includes('breaker_cleared'))) continue;
      const threshold = event === 'queue_wait' ? (config.minutes ?? 5) : (config.thresholdPct ?? 80);
      const pct = Number.isFinite(value) && Number.isFinite(limit) && limit > 0 ? value / limit * 100 : null;
      const crossed = active ?? (event === 'queue_wait' ? value > threshold : pct !== null && pct >= threshold);
      const key = `alert-hook:${index}:${event}:${project ?? ''}`;
      const at = this.now();
      const payload = await this.storage.transaction(async tx => {
        const previous = await tx.get(key) ?? (previousActive === undefined ? undefined : { active: previousActive });
        const rolled = window != null && previous?.window !== window;
        const emit = crossed && (!previous?.active || rolled) ? (config.on.includes(event) ? event : null) : !crossed && previous?.active ? (event === 'breaker_open' && config.on.includes('breaker_cleared') ? 'breaker_cleared' : config.on.includes(event) ? 'recovered' : null) : null;
        await tx.put(key, { active: Boolean(crossed), window: window ?? null });
        return emit ? { event: emit, ...(project ? { project } : {}), value: value ?? null, limit: limit ?? null, pct, at: new Date(at).toISOString(), deployment: this.deployment, ...(emit === 'recovered' ? { recovered: event } : {}) } : null;
      });
      if (payload) this.waitUntil(this.deliver(config, payload).catch(() => this.logError('Alert delivery failed', payload.event, 'error preparing delivery')));
    }
  }

  async deliver(config, payload) {
    const body = JSON.stringify(payload), headers = { 'content-type': 'application/json' };
    if (config.secretEnv) {
      const secret = this.env()[config.secretEnv];
      if (typeof secret !== 'string' || !secret) {
        this.logError('Alert delivery failed', payload.event, 'missing signing secret');
        return;
      }
      const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
      headers['x-boat-signature'] = `sha256=${[...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('')}`;
    }
    let failure;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await this.fetcher(config.url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
        if (response.ok) return;
        failure = `HTTP ${response.status}`;
      } catch (error) {
        failure = error instanceof TypeError ? 'TypeError' : 'request error';
      }
    }
    this.logError('Alert delivery failed', payload.event, failure);
  }
}
