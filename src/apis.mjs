import { defaultWallet } from '../config/policy.mjs';
import { Buffer } from 'node:buffer';
import { createPrivateKey, sign } from 'node:crypto';
import { appCredentials } from './app-secrets.mjs';
import { ApiError, jobRunnerName } from './domain.mjs';
import { bootstrap, dockerBootstrap, START_COMMAND, RUNNER_WORK_FOLDER } from './bootstrap.mjs';
import { snapshotBootstrap } from './snapshot-bootstrap.mjs';
import { reuseBootstrap, reuseStartCommand, refreshCommand, parseRefreshResult, REFRESH_RESULT_MAX_BYTES } from './refresh.mjs';
import { lightResetCommand, lightResetDiagnosticCommand, parseLightResetResult, lightStartCommand, healthProbeCommand, parseHealthProbe } from './router/light-reset.mjs';
import { dockerBaselineCommand, dockerResetCommand, dockerStartCommand, parseDockerBaselineResult, parseDockerResetResult } from './router/docker-reset.mjs';
import { PROBE, REUSE_PROBE } from './router/jit-liveness.mjs';
import { setupProviderFields, setupOutputTail, setupCaptureStatus, setupErrorCategory, setupRetryEligible, setupPhase, setupExitCode } from './router/setup-diagnostics.mjs';

export const providerWallet = env => env.BOAT_PROVIDER_WALLET ?? env.BOAT_WALLET ?? defaultWallet;

export class APIs {
  constructor(env, fetcher = fetch, now = Date.now, credentials = async () => null) {
    this.env = env;
    this.fetch = fetcher.bind(globalThis);
    this.now = now;
    this.tokens = new Map();
    this.credentials = credentials;
  }
  async request(service, path, { method = 'GET', body, headers = {}, token, expectEmpty = false, metadata = false, timeoutMs = 10_000, textResponse = false } = {}) {
    let response;
    let data;
    let encoded;
    try { encoded = body === undefined ? undefined : JSON.stringify(body); }
    catch { throw new ApiError(service, 0, 'request_not_sent'); }
    try {
      response = await this.fetch((service === 'boat' ? 'https://boat.dev/api/v1' : 'https://api.github.com') + path, {
        method, headers: {
          'Content-Type': 'application/json', 'User-Agent': 'boat-router',
          ...(service === 'github' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } :
            { 'X-Boat-Org': providerWallet(this.env) }),
          ...((service === 'boat' ? this.env.BOAT_CI_API_KEY : token) ?
            { Authorization: `Bearer ${service === 'boat' ? this.env.BOAT_CI_API_KEY : token}` } : {}), ...headers,
        },
        body: encoded, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual',
      });
      if (response.status === 304 || response.status === 204 || (response.ok && expectEmpty)) data = {};
      else if (response.ok && textResponse) {
        const value = await response.text();
        try { data = JSON.parse(value); } catch { data = value; }
      } else data = await response.json();
    } catch {
      throw new ApiError(service, response?.status ?? 0, 'transport_or_response');
    }
    if (!response.ok && !(metadata && response.status === 304)) {
      const wait = data.retryAfterSeconds ?? data.retryAfter ??
        ({ minute: 60, hour: 300, day: 900 }[data.window]) ?? 0;
      throw new ApiError(service, response.status, data.code ?? data.error,
        Number.isFinite(Number(wait)) ? Number(wait) : 0);
    }
    if (metadata) {
      const remaining = response.headers.get('x-ratelimit-remaining');
      return { status: response.status, data, etag: response.headers.get('etag'), rateRemaining: remaining !== null && /^\d+$/.test(remaining) ? Number(remaining) : null };
    }
    return data;
  }
  async appJWT() {
    const app = appCredentials(this.env, await this.credentials());
    const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const now = Math.floor(this.now() / 1000);
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 540, iss: app.id })}`;
    if (typeof app.pem !== 'string') throw new ApiError('github', 0, 'app_private_key_missing');
    const key = createPrivateKey(app.pem);
    return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), key).toString('base64url')}`;
  }
  async github(job, path, options = {}) {
    const { actionsWrite = false, permissions = null, ...requestOptions } = options;
    // a call may ask for its own token scope (e.g. checks:read) so that a permission the App
    // lacks fails only that call, never the shared read or write tokens.
    const scope = permissions ? `scope:${Object.entries(permissions).map(([k, v]) => `${k}=${v}`).sort().join(',')}` : actionsWrite ? 'write' : 'read';
    const key = `${job.installation}:${job.repo}:${scope}`;
    let cached = this.tokens.get(key);
    if (!cached || cached.expires <= this.now() + 60_000) {
      const auth = await this.request('github', `/app/installations/${job.installation}/access_tokens`, {
        method: 'POST', token: await this.appJWT(), body: { repositories: [job.repo.split('/')[1]],
          permissions: permissions ?? (actionsWrite ? { actions: 'write' } : { administration: 'write', actions: 'read' }) },
      });
      if (typeof auth.token !== 'string' || !Number.isFinite(Date.parse(auth.expires_at))) throw new ApiError('github', 502);
      cached = { token: auth.token, expires: Date.parse(auth.expires_at) };
      this.tokens.set(key, cached);
    }
    try {
      return await this.request('github', `/repos/${job.repo}${path}`, { ...requestOptions, token: cached.token });
    } catch (error) {
      if (error.status === 401) this.tokens.delete(key);
      throw error;
    }
  }
  snapshotPage(job, path, etag) {
    return this.github(job, path, { metadata: true, headers: etag ? { 'If-None-Match': etag } : {} });
  }
  getJob(job, id = job.assignedJobId ?? job.id) { return this.github(job, `/actions/jobs/${id}`); }
  getRun(job, id) { return this.github(job, `/actions/runs/${id}`); }
  rerunJob(job, id) { return this.github(job, `/actions/jobs/${id}/rerun`, { method: 'POST', actionsWrite: true, expectEmpty: true }); }
  // An Actions job's check run shares its id; GitHub writes "lost communication with the server" there.
  jobAnnotations(job, id) { return this.github(job, `/check-runs/${id}/annotations?per_page=100`, { permissions: { checks: 'read' } }); }
  convertManifest(code) { return this.request('github', `/app-manifests/${encodeURIComponent(code)}/conversions`, { method: 'POST' }); }
  limits() { return this.request('boat', '/limits'); }
  create(job, ttl) {
    let body;
    try {
      const snapshot = job.routerSnapshot;
      const lease = snapshot?.kind === 'lease-v1', browser = snapshot?.kind === 'browser-v1';
      if (snapshot && (!(lease ? /^lease-ci-\d{8}-[a-f0-9]{8,64}$/ : browser ? /^browser-ci-\d{8}-[a-f0-9]{8,64}$/ : /^[a-z][a-z0-9-]{0,40}-\d{8}-[a-f0-9]{8,64}$/).test(snapshot.name ?? '') ||
        !/^[a-f0-9]{64}$/.test(snapshot.manifestSha256 ?? '') || (lease && (!/^[a-f0-9]{64}$/.test(snapshot.profileSha256 ?? '') || job.routerReusable !== true)) ||
        (browser && (!/^[a-f0-9]{64}$/.test(snapshot.browserManifestSha256 ?? '') || !/^[a-f0-9]{64}$/.test(snapshot.profileSha256 ?? '') || job.routerReusable !== true)) || (!lease && !browser && (snapshot.kind != null || snapshot.profileSha256 != null || snapshot.browserManifestSha256 != null)) || job.routerResetMode === 'docker' || job.routerDockerAccess === true)) throw new TypeError('invalid snapshot');
      body = { type: job.machineSize ?? job.size, ttlSeconds: ttl, noEnv: true, snapshots: false, monitoring: false,
        failFast: true, setupScript: snapshot ? snapshotBootstrap(snapshot.manifestSha256, { reusable: job.routerReusable === true, ...(lease || browser ? { leaseProfileSha256: snapshot.profileSha256 } : {}), ...(browser ? { browserManifestSha256: snapshot.browserManifestSha256 } : {}) }) : job.routerResetMode === 'docker' || job.routerDockerAccess === true ? dockerBootstrap() : job.routerReusable ? reuseBootstrap() : bootstrap(), ...(snapshot ? { from: snapshot.name, env: {} } : {}), ...(job.routerCreateName ? { name: job.routerCreateName } : {}) };
    } catch { throw new ApiError('boat', 0, 'request_not_sent'); }
    return this.request('boat', '/sandboxes', { method: 'POST', headers: { 'Idempotency-Key': job.createKey }, body });
  }
  async listSandboxes() {
    let cursor;
    const sandboxes = [];
    const seen = new Set();
    do {
      if (seen.size >= 50) throw new ApiError('boat', 502, 'lookup_incomplete');
      const page = await this.request('boat', `/sandboxes?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(page.sandboxes)) throw new ApiError('boat', 502);
      sandboxes.push(...page.sandboxes);
      cursor = page.pageInfo?.nextCursor;
      if (cursor != null && (typeof cursor !== 'string' || !cursor || seen.has(cursor))) throw new ApiError('boat', 502);
      if (cursor) seen.add(cursor);
    } while (cursor);
    return sandboxes;
  }
  async findCreated(job) {
    if (!/^boat-router-[a-f0-9]{32}$/.test(job.routerCreateName ?? '')) throw new ApiError('boat', 502, 'lookup_identity_missing');
    const matches = (await this.listSandboxes()).filter(sandbox => sandbox?.name === job.routerCreateName);
    if (matches.length > 1 || (matches.length && !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(matches[0]?.id ?? ''))) throw new ApiError('boat', 502);
    return matches[0] ?? null;
  }
  sandbox(job) { return this.request('boat', `/sandboxes/${job.machineId}`); }
  async setupDiagnostics(job, observedSandbox) {
    let observed = observedSandbox;
    try {
      if (!observed) observed = await this.sandbox(job);
      const fields = setupProviderFields(observed);
      const setupOutput = setupOutputTail((observed?.sandbox ?? observed)?.setupError);
      const category = setupErrorCategory(setupOutput);
      const integrityFailure = ['apt_integrity', 'checksum_mismatch'].includes(category);
      const retryEligible = !integrityFailure && (fields.retryEligible || (fields.providerErrorCategory === 'unknown' && setupRetryEligible(category)));
      const exitCode = setupExitCode(setupOutput);
      return { ...fields, retryEligible, captureStatus: setupOutput === null ? 'unavailable' : 'ok', setupOutput: setupOutput ?? [],
        setupErrorCategory: category, setupPhase: setupPhase(setupOutput), ...(exitCode === null ? {} : { exitCode }) };
    } catch (error) {
      return { ...setupProviderFields(observed), captureStatus: setupCaptureStatus(error), setupOutput: [], setupErrorCategory: 'unknown', setupPhase: 'unknown' };
    }
  }
  async configure(job, saveRunner) {
    const name = jobRunnerName(job);
    const existing = await this.github(job, `/actions/runners?name=${encodeURIComponent(name)}&per_page=100`);
    for (const runner of existing.runners ?? []) {
      if (runner.name !== name) continue;
      if (runner.busy || runner.status === 'online') throw new ApiError('github', 409, 'runner_already_started', 30);
      await this.github(job, `/actions/runners/${runner.id}`, { method: 'DELETE' });
    }
    const jit = await this.github(job, '/actions/runners/generate-jitconfig', { method: 'POST',
      body: { name, runner_group_id: 1, labels: job.labels ?? [job.label], work_folder: RUNNER_WORK_FOLDER } });
    if (!Number.isSafeInteger(jit.runner?.id) || typeof jit.encoded_jit_config !== 'string') throw new ApiError('github', 502);
    await saveRunner(jit.runner.id);
    await this.request('boat', `/sandboxes/${job.machineId}/files`, { method: 'PUT',
      body: { path: '/home/user/.boat-ci/jit', content: jit.encoded_jit_config, encoding: 'utf8' } });
  }
  start(job) {
    return this.request('boat', `/sandboxes/${job.machineId}/commands`, {
      method: 'POST', body: { command: job.routerResetMode === 'docker' ? dockerStartCommand() : job.boxGeneration === true && job.generation > 0 ? lightStartCommand(job.generation) : job.routerReusable ? reuseStartCommand(job.boxGeneration === true ? job.generation : job.generation - 1, job.routerDockerAccess === true) : START_COMMAND, detached: true },
    });
  }
  refresh(job, mode, generation) {
    const submit = () => this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: refreshCommand(mode, generation), detached: true } });
    // A baseline or reset command that never reached Boat is a transport fault, not a fault of the box:
    // one retry keeps a paid box that would otherwise be retired as baseline_failed (2026-11-20,
    // bx_jkrtk8m2). The controller holds a lock and writes one result file, so a second submission
    // converges on the same state.
    return submit().catch(error => error?.status === 0 ? submit() : Promise.reject(error));
  }
  async refreshResult(job, processId, generation) {
    if (!Number.isSafeInteger(processId) || processId < 1) throw new ApiError('boat', 502);
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands/${processId}?tailBytes=${REFRESH_RESULT_MAX_BYTES}`);
    if (result.running === true) return null;
    if (result.exitCode !== 0) return { ok: false };
    return parseRefreshResult(result, generation);
  }
  lightReset(job, generation) {
    return this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: lightResetCommand(generation, job.leaseId ?? null, job.minimumDiskKiB, job.minimumHomeDiskKiB, job.healthMode === 'enforce' ? 'enforce' : 'observe'), detached: true } });
  }
  async healthProbe(job) {
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: healthProbeCommand(), detached: false, timeoutSeconds: 25 } });
    return parseHealthProbe(result);
  }
  async lightResetDiagnostics(job) {
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: lightResetDiagnosticCommand(), detached: false, timeoutSeconds: 15 } });
    if (result?.exitCode !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 256) return null;
    try {
      const value = JSON.parse(result.stdout);
      if (typeof value.dmesgReadable !== 'boolean' || typeof value.oomObserved !== 'boolean') return null;
      return { dmesgReadable: value.dmesgReadable, oomObserved: value.oomObserved };
    } catch { return null; }
  }
  async lightResetResult(job, processId, generation) {
    if (!Number.isSafeInteger(processId) || processId < 1) throw new ApiError('boat', 502);
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands/${processId}?tailBytes=8192`);
    return parseLightResetResult(result, generation);
  }
  // Docker-enabled Actions boxes: baseline once after setup, in-box reset between jobs.
  dockerBaseline(job) {
    return this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: dockerBaselineCommand(), detached: true } });
  }
  async dockerBaselineResult(job, processId) {
    if (!Number.isSafeInteger(processId) || processId < 1) throw new ApiError('boat', 502);
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands/${processId}?tailBytes=8192`);
    return parseDockerBaselineResult(result);
  }
  async dockerReset(job, generation) {
    return this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: dockerResetCommand(generation, job.baselineHash), detached: true } });
  }
  async dockerResetResult(job, processId, generation) {
    if (!Number.isSafeInteger(processId) || processId < 1) throw new ApiError('boat', 502);
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands/${processId}?tailBytes=8192`);
    return parseDockerResetResult(result, generation);
  }
  async jitProbe(job) {
    const result = await this.request('boat', `/sandboxes/${job.machineId}/commands`, { method: 'POST', body: { command: job.routerReusable && job.routerResetMode !== 'docker' ? REUSE_PROBE : PROBE, detached: false, timeoutSeconds: 8 } });
    if (result.running === true || result.exitCode !== 0 || typeof result.stdout !== 'string' || result.stdout.length > 4096) return null;
    try { return JSON.parse(result.stdout); } catch { return null; }
  }
  runner(job) { return this.github(job, `/actions/runners/${job.runnerId}`); }
  removeRunner(job) { return this.github(job, `/actions/runners/${job.runnerId}`, { method: 'DELETE' }); }
  destroy(job) {
    return this.request('boat', `/sandboxes/${job.machineId}`, {
      method: 'DELETE', headers: { 'X-Ascii-Confirm-Delete': job.machineId },
    });
  }
  deletion(job) { return this.request('boat', `/deletion-operations/${job.operationId}`); }
}
