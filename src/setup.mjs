import { setupOwner, installedPage } from '../config/policy.mjs';
import manifestTemplate from '../config/github-app-manifest.json' with { type: 'json' };
import { createPrivateKey } from 'node:crypto';

export async function hash(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(x => x.toString(16).padStart(2, '0')).join('');
}
function equal(a, b) {
  if (!/^[a-f0-9]{64}$/.test(a ?? '') || !/^[a-f0-9]{64}$/.test(b ?? '')) return false;
  let difference = 0;
  for (let i = 0; i < 64; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}
function random() { return [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join(''); }
function escape(value) { return String(value).replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[x]); }
function page(body, { status = 200, nonce = random(), headers = {} } = {}) {
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Boat CI setup</title><body>${body}</body></html>`, {
    status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; form-action 'self' https://github.com; base-uri 'none'; frame-ancestors 'none'`, ...headers },
  });
}
function bootstrap(env) {
  try { return JSON.parse(env.SETUP_BOOTSTRAP ?? '{}'); } catch { return {}; }
}
export async function authorizedControl(request, env) {
  const value = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  return Boolean(value && equal(await hash(value), bootstrap(env).controlHash));
}
export async function authorizedLocal(request, env) {
  const value = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
  return Boolean(value && equal(await hash(value), env.LOCAL_CONTROL_HASH));
}
export class SetupController {
  constructor(storage, env, api, now = Date.now, alert = async () => {}) { Object.assign(this, { storage, env, api, now, alert }); }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.origin !== this.env.PUBLIC_ORIGIN) return page('Invalid setup origin.', { status: 400 });
    if (url.pathname === '/setup/reset' && request.method === 'POST') return this.reset(request);
    if (url.pathname === '/setup/status' && request.method === 'GET') {
      if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
      return this.status();
    }
    if (url.pathname === '/setup/installed' && request.method === 'GET') {
      const app = await this.storage.get('github-app');
      return app ? this.installed(app) : page('Setup is incomplete.', { status: 409 });
    }
    if (await this.storage.get('github-app') || this.env.GITHUB_APP_ID) return page('An App is already configured. Setup is closed.', { status: 409 });
    if (this.env.ENABLED !== 'false') return page('Disable machine starts before setup.', { status: 409 });
    if (url.pathname === '/setup' && request.method === 'GET') return this.begin(url.searchParams.get('token'), true);
    if (url.pathname === '/setup' && request.method === 'POST') {
      // The one-use capability authorizes setup. Privacy policies and in-app
      // browsers can omit Origin or serialize it as "null" even for this form.
      const origin = request.headers.get('Origin');
      if (origin && origin !== 'null' && origin !== this.env.PUBLIC_ORIGIN) return page('Invalid setup origin.', { status: 403 });
      if (Number(request.headers.get('Content-Length')) > 4096) return page('Setup request is too large.', { status: 413 });
      const body = await request.text();
      if (body.length > 4096) return page('Setup request is too large.', { status: 413 });
      return this.begin(new URLSearchParams(body).get('token'));
    }
    if (url.pathname === '/setup/callback' && request.method === 'GET') return this.complete(request, url);
    return page('Method not allowed.', { status: 405 });
  }
  async status() {
    const headers = { 'Cache-Control': 'no-store' };
    const app = await this.storage.get('github-app');
    if (!app) return Response.json({ app_configured: false, private_key_stored: false, webhook_secret_stored: false }, { headers });
    try {
      const token = await this.api.appJWT();
      const remote = await this.api.request('github', '/app', { token });
      if (String(remote.id) !== app.id) throw new Error('App identity mismatch');
      const installed = await this.api.request('github', '/app/installations?per_page=100', { token });
      if (!Array.isArray(installed) || installed.length >= 100) throw new Error('Incomplete installations');
      const installations = [];
      for (const installation of installed) {
        const access = await this.api.request('github', `/app/installations/${installation.id}/access_tokens`, {
          method: 'POST', token, body: { permissions: { metadata: 'read' } },
        });
        const repos = await this.api.request('github', '/installation/repositories?per_page=100', { token: access.token });
        if (!Array.isArray(repos.repositories) || repos.total_count !== repos.repositories.length) throw new Error('Incomplete repositories');
        installations.push({ id: installation.id, account: installation.account.login, repository_selection: installation.repository_selection,
          suspended_at: installation.suspended_at, permissions: installation.permissions,
          repositories: repos.repositories.map(repo => repo.full_name) });
      }
      const deliveries = await this.api.request('github', '/app/hook/deliveries?per_page=20', { token });
      return Response.json({ app_configured: true, app_id: app.id, slug: remote.slug,
        private_key_stored: typeof app.pem === 'string' && app.pem.length > 0,
        webhook_secret_stored: typeof app.webhookSecret === 'string' && app.webhookSecret.length > 0,
        installations, deliveries: deliveries.map(item => ({ id: item.id, event: item.event, action: item.action,
          status_code: item.status_code, delivered_at: item.delivered_at, installation_id: item.installation_id, repository_id: item.repository_id })) }, { headers });
    } catch (error) {
      return Response.json({ error: 'github_setup_check_failed', status: Number.isInteger(error.status) ? error.status : 0 }, { status: 502, headers });
    }
  }
  async reset(request) {
    if (!await authorizedControl(request, this.env)) return page('Unauthorized.', { status: 401 });
    if (this.env.ENABLED !== 'false') return page('Disable machine starts before reset.', { status: 409 });
    const reset = await this.storage.transaction(async tx => {
      if (await tx.get('github-app') || this.env.GITHUB_APP_ID) return false;
      const flow = await tx.get('setup-flow');
      if (flow?.phase === 'exchanging' && this.now() - (flow.claimedAt ?? this.now()) < 60_000) return false;
      await tx.put('setup-flow', { phase: 'reset' });
      return true;
    });
    if (!reset) return page('App already configured or conversion still in flight. Inspect the registration before reset.', { status: 409 });
    await this.alert('alert_setup_reset');
    return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  }
  async begin(token, preview = false) {
    const config = bootstrap(this.env);
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token ?? '') || !equal(await hash(token), config.tokenHash) ||
      !Number.isFinite(config.expiresAt) || this.now() >= config.expiresAt) return page('Setup link is invalid or expired.', { status: 401 });
    if (preview) {
      if (await this.storage.get(`setup-used:${config.tokenHash}`)) return page('Setup link was already used.', { status: 409 });
      const nonce = random();
      return page(`<p>Make sure you're signed in to GitHub as <strong>${escape(setupOwner)}</strong>.</p><form id="start" method="post" action="/setup"><input id="token" type="hidden" name="token"><button type="submit">Create GitHub App</button></form><script nonce="${nonce}">document.getElementById('token').value=new URL(location.href).searchParams.get('token');</script>`, { nonce });
    }
    const state = random();
    const stateHash = await hash(state);
    const expiresAt = Math.min(config.expiresAt, this.now() + 30 * 60_000);
    const started = await this.storage.transaction(async tx => {
      if (await tx.get('github-app') || await tx.get(`setup-used:${config.tokenHash}`)) return false;
      const previous = await tx.get('setup-flow');
      if (previous && (previous.phase === 'exchanging' || previous.phase === 'started' && previous.expiresAt > this.now())) return false;
      await tx.put(`setup-used:${config.tokenHash}`, true);
      await tx.put('setup-flow', { phase: 'started', stateHash, expiresAt });
      return true;
    });
    if (!started) return page('Setup link was already used. Resume its browser flow or request a new link after expiry.', { status: 409 });
    const manifest = { ...manifestTemplate, ...(this.env.GITHUB_APP_NAME ? { name: this.env.GITHUB_APP_NAME } : {}), redirect_url: `${this.env.PUBLIC_ORIGIN}/setup/callback`,
      hook_attributes: { url: `${this.env.PUBLIC_ORIGIN}/webhook`, active: true } };
    const nonce = random();
    return page(`<p>Continue on GitHub to create the App.</p><form id="manifest" method="post" action="https://github.com/settings/apps/new?state=${state}"><input type="hidden" name="manifest" value="${escape(JSON.stringify(manifest))}"><button type="submit">Continue to GitHub</button></form><script nonce="${nonce}">history.replaceState(null, '', '/setup');document.getElementById('manifest').submit();</script>`, {
      nonce, headers: { 'Set-Cookie': `__Host-boat-ci-setup=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.floor((expiresAt - this.now()) / 1000)}` },
    });
  }
  async reject(digest) {
    await this.storage.transaction(async tx => {
      const flow = await tx.get('setup-flow');
      if (flow?.phase === 'exchanging' && equal(flow.stateHash, digest)) await tx.put('setup-flow', { phase: 'rejected' });
    });
  }
  async complete(request, url) {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-boat-ci-setup=([a-f0-9]{64})(?:;|$)/)?.[1];
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(code ?? '') || !equal(state, cookie)) return page('Invalid setup callback.', { status: 401 });
    const digest = await hash(state);
    const claimed = await this.storage.transaction(async tx => {
      const flow = await tx.get('setup-flow');
      if (await tx.get('github-app') || flow?.phase !== 'started' || flow.expiresAt <= this.now() || !equal(flow.stateHash, digest)) return false;
      await tx.put('setup-flow', { ...flow, phase: 'exchanging', claimedAt: this.now() });
      return true;
    });
    if (!claimed) return page('Setup callback is expired, unknown, or already used.', { status: 409 });
    let result;
    try { result = await this.api.convertManifest(code); } catch (error) {
      const definite = error.service === 'github' && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status);
      if (definite) await this.reject(digest);
      await this.alert(definite ? 'alert_setup_rejected' : 'alert_setup_uncertain');
      return page(definite ? 'GitHub rejected conversion. Ask for a fresh setup link.' :
        'GitHub conversion could not be confirmed. Inspect the registration before a control-authorized reset.', { status: 502 });
    }
    if (typeof result?.owner?.login === 'string' && result.owner.login !== setupOwner) {
      await this.reject(digest);
      await this.alert('alert_setup_owner_rejected');
      return page(`Make sure you're signed in to GitHub as ${escape(setupOwner)}. This App was not stored. Ask for a fresh setup link.`, { status: 422 });
    }
    let app;
    try {
      if (result?.owner?.login !== setupOwner || !Number.isSafeInteger(result.id) || result.id <= 0 || !/^[a-z0-9-]{1,100}$/.test(result.slug ?? '') ||
        typeof result.pem !== 'string' || typeof result.webhook_secret !== 'string' || !result.webhook_secret.length ||
        createPrivateKey(result.pem).asymmetricKeyType !== 'rsa') throw new Error('Invalid App');
      app = { id: String(result.id), slug: result.slug, pem: result.pem, webhookSecret: result.webhook_secret };
    } catch {
      await this.alert('alert_setup_invalid');
      return page('GitHub returned invalid App credentials. Inspect the registration before a control-authorized reset.', { status: 502 });
    }
    const stored = await this.storage.transaction(async tx => {
      const flow = await tx.get('setup-flow');
      if (flow?.phase !== 'exchanging' || !equal(flow.stateHash, digest) || await tx.get('github-app')) return false;
      await tx.put('github-app', app);
      await tx.put('setup-flow', { phase: 'complete' });
      return true;
    });
    if (!stored) {
      await this.alert('alert_setup_interrupted');
      return page('Setup changed during conversion. Inspect the registration before retrying.', { status: 409 });
    }
    return page('App configured. Continue to installation.', { status: 303, headers: {
      Location: '/setup/installed', 'Set-Cookie': '__Host-boat-ci-setup=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    } });
  }
  installed(app) { return installedPage(app, this.env, page); }
}
