import { smokeRepository, localHosts } from '../config/policy.mjs';
import { transition as applyBoxEvent } from './router/box-state.mjs';
import { FleetBase } from './router/fleet-base.mjs';
import { snapshotLimits } from './router/ledger.mjs';
import { dynamicPacing } from './router/dynamic-pacing.mjs';
import { paidExtraEnabled, paidExtraSummary } from './router/paid-extra.mjs';
import { runnableDemand } from './router/workflow-demand.mjs';
import { claimAny } from './router/local-fleet.mjs';
import { ExternalService } from './router/external-service.mjs';
import { leaseBase } from './router/lease-base.mjs';
import { browserBase } from './router/browser-base.mjs';
import { providerWallet } from './apis.mjs';
import { BUILD_COMMIT, BUILD_DEPLOYMENT } from './build.mjs';
import { installRouter } from './router/install.mjs';
import { records } from './router/pool-records.mjs';
import { ReadCache } from './router/read-cache.mjs';
import { DOCKER_REUSE_KEY, localRoom } from './router/box-fleet.mjs';
import { LOCAL_MODE_KEY, labelLocal } from './router/local-fleet.mjs';
import { SETUP_WATCHDOG_SWITCH_KEY, SETUP_WATCHDOG_PREFIX, SETUP_WATCHDOG_CHECK_PREFIX, SETUP_WATCHDOG_RUN_PREFIX, listRecords } from './router/setup-watchdog.mjs';
import { LANES_SWITCH_KEY, laneRules, laneRank, laneUsage, reservedByLane, lanesSwitchOn, laneLending, borrowedSlots } from './router/lanes.mjs';
import { sanitizeSetupLine, PHASES, SETUP_ERROR_CATEGORIES } from './router/setup-diagnostics.mjs';
import { redact } from './redact.mjs';
import { SetupController, authorizedControl, authorizedLocal, hash } from './setup.mjs';
import { appCredentials, moveAppSecrets } from './app-secrets.mjs';
import { exportResponse } from './export.mjs';
import { webhook } from './webhook.mjs';
import { RepoWebhookInbox } from './router/repo-webhook-inbox.mjs';
import { APIs } from './apis.mjs';
import { ApiError, backoff, isPlanRefusal, isSizeRefusal, reservationId, runnerName, jobRunnerName, REPOSITORIES } from './domain.mjs';

const terminal = job => ['done', 'attention'].includes(job.phase);
const stoppedPoll = 10 * 60_000;
const createReconcileWindow = 5 * 60_000;

const FAILURE_PREFIX = 'verification:attempt:failure:';
const FAILURE_KEY = /^verification:attempt:failure:([A-Za-z0-9_.-]{1,128}):(0|[1-9]\d{0,14})$/;
const FAILURE_CURSOR = /^verification:attempt:failure:[A-Za-z0-9_.:-]{1,160}$/;
function safeFailureMessage(message) {
  if (typeof message !== 'string' || message.length > 65_536) return null;
  let value; try { value = JSON.parse(message); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const safe = {};
  for (const [key, allowed] of Object.entries({
    state: ['starting', 'pending', 'ready', 'idle', 'running', 'error', 'cancelled', 'archived', 'stopped', 'unknown'],
    setupStatus: ['pending', 'starting', 'running', 'done', 'failed', 'cancelled', 'unknown'],
    providerErrorCategory: ['rate_limited', 'timeout', 'network', 'unavailable', 'configuration', 'integrity', 'unknown'],
    captureStatus: ['ok', 'unavailable', 'http_403', 'http_404', 'http_409', 'http_429', 'http_other', 'not_attempted', 'invalid_format'],
    step: ['kill processes', 'docker prune', 'clean work dir', 'prepare runner', 'sanity checks', 'reset command', 'submit reset command', 'read reset result', 'submit baseline command', 'baseline'],
  })) if (allowed.includes(value[key])) safe[key] = value[key];
  if (typeof value.retryEligible === 'boolean') safe.retryEligible = value.retryEligible;
  if (Number.isSafeInteger(value.exitCode) && value.exitCode >= 0 && value.exitCode <= 255) safe.exitCode = value.exitCode;
  // The reuse controller's own reason a box retired: a stage and an exit status
  // alone left a box undiagnosable (2026-11-20), so the failing command's line
  // travels too. Every field is a bounded, allowlisted shape and free text is
  // redacted before it leaves the router.
  if (Array.isArray(value.failed) && value.failed.length <= 8 && value.failed.every(code => typeof code === 'string' && /^[A-Za-z]{1,24}$/.test(code))) safe.failed = value.failed;
  if (value.diagnostic && typeof value.diagnostic === 'object' && !Array.isArray(value.diagnostic)) {
    const diagnostic = {};
    if (typeof value.diagnostic.stage === 'string' && /^[a-z_]{1,40}$/.test(value.diagnostic.stage)) diagnostic.stage = value.diagnostic.stage;
    if (typeof value.diagnostic.exception === 'string' && /^[A-Za-z]{1,40}$/.test(value.diagnostic.exception)) diagnostic.exception = value.diagnostic.exception;
    if (typeof value.diagnostic.operation === 'string' && /^[a-z.-]{1,24}$/.test(value.diagnostic.operation)) diagnostic.operation = value.diagnostic.operation;
    if (Number.isSafeInteger(value.diagnostic.exitCode) && value.diagnostic.exitCode >= -255 && value.diagnostic.exitCode <= 255) diagnostic.exitCode = value.diagnostic.exitCode;
    if (typeof value.diagnostic.output === 'string' && value.diagnostic.output.length <= 200 && /^[\x20-\x7e]*$/.test(value.diagnostic.output)) diagnostic.output = redact(value.diagnostic.output);
    if (Object.keys(diagnostic).length) safe.diagnostic = diagnostic;
  }
  if (Array.isArray(value.setupOutput)) safe.setupOutput = value.setupOutput.slice(-20).map(line => ['[redacted]', '[apt network failure]', '[apt integrity failure]', '[apt lock failure]'].includes(line) ? line : sanitizeSetupLine(line));
  if (SETUP_ERROR_CATEGORIES.has(value.setupErrorCategory)) safe.setupErrorCategory = value.setupErrorCategory;
  if (value.setupPhase === 'unknown' || PHASES.has(value.setupPhase)) safe.setupPhase = value.setupPhase;
  if (value.kernel && typeof value.kernel === 'object' && typeof value.kernel.dmesgReadable === 'boolean' && typeof value.kernel.oomObserved === 'boolean') safe.kernel = { dmesgReadable: value.kernel.dmesgReadable, oomObserved: value.kernel.oomObserved };
  return Object.keys(safe).length ? JSON.stringify(safe) : null;
}
function failureRecord(key, record, paginated) {
  const match = (paginated ? FAILURE_KEY : /^verification:attempt:failure:(.+):(\d+)$/).exec(key);
  if (!match) return null;
  const legacy = { kind: record.kind ?? null, phase: record.phase ?? null, boxId: match[1], generation: Number(match[2]), at: record.at ?? null, message: record.message ?? null };
  if (!paginated) return legacy;
  const kinds = ['boot_failed', 'boot_timeout', 'baseline_failed', 'baseline_timeout', 'registration_uncertain', 'registration_timeout', 'offline_timeout', 'reset_failed', 'reset_timeout'];
  const phases = ['booting', 'baseline', 'ready', 'registering', 'idle', 'busy', 'finished', 'resetting', 'destroying'];
  return { id: key, kind: kinds.includes(record.kind) ? record.kind : null, phase: phases.includes(record.phase) ? record.phase : null, boxId: match[1], generation: Number(match[2]), size: ['small', 'default', 'large', 'xlarge'].includes(record.size) ? record.size : null, at: Number.isFinite(record.at) ? record.at : null, createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null, message: safeFailureMessage(record.message) };
}

const REUSE_OFF_EVENT_LIMIT = 256;
async function readReuseState(tx, prefix = '') {
  const [override, saved] = await Promise.all([tx.get(`${prefix}reuse:override`), tx.get(`${prefix}reuse:revisions`)]);
  if (saved !== undefined && (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || !Array.isArray(saved.offEvents) || !Number.isSafeInteger(saved.offEventFloor) || saved.offEventFloor < 0)) throw new Error('invalid reuse revision state');
  return { override: override ?? 'config', revision: saved?.revision ?? 0, offEvents: saved?.offEvents ?? [], offEventFloor: saved?.offEventFloor ?? 0 };
}
async function writeReuseState(tx, mode, at, source, callerNonce = null, prefix = '') {
  const state = await readReuseState(tx, prefix);
  if (state.revision >= Number.MAX_SAFE_INTEGER) throw new Error('reuse revision exhausted');
  const revision = state.revision + 1;
  const offEvents = mode === 'off' ? [...state.offEvents, { revision, at, source, ...(callerNonce ? { callerNonce } : {}) }] : state.offEvents;
  const removed = offEvents.slice(0, Math.max(0, offEvents.length - REUSE_OFF_EVENT_LIMIT));
  const saved = { revision, offEvents: offEvents.slice(-REUSE_OFF_EVENT_LIMIT), offEventFloor: removed.length ? removed.at(-1).revision : state.offEventFloor };
  await tx.put(`${prefix}reuse:override`, mode);
  await tx.put(`${prefix}reuse:revisions`, saved);
  return { override: mode, ...saved };
}

export class FleetController extends FleetBase {
  constructor(storage, env, api = new APIs(env), now = Date.now, logger = console.log, options = {}) {
    super(storage, env, api, now, logger, options);
  }
  async ingest(event) {
    if (!(this.allowedRepos ?? REPOSITORIES).has(event.repo) && !(this.env.ALLOW_SMOKE === 'true' && event.repo === smokeRepository)) return;
    await this.storage.transaction(async (tx) => {
      const previous = await tx.get(`job:${event.id}`);
      if (previous && (previous.repo !== event.repo || previous.installation !== event.installation)) return;
      if (!previous) {
        const job = { ...event, phase: 'queued', createdAt: this.now(), updatedAt: this.now(), nextAt: 0,
          createKey: crypto.randomUUID(), attempts: 0, intentDone: event.status === 'completed',
          intentStarted: event.status !== 'queued' };
        await this.save(tx, job);
      } else {
        await this.save(tx, { ...previous, intentDone: previous.intentDone || event.status === 'completed',
          intentStarted: previous.intentStarted || event.status !== 'queued',
          nextAt: event.status === 'completed' ? 0 : previous.nextAt }, previous);
        await this.emit('reuse', previous, { phase: previous.phase }, tx);
      }
      await this.assignEvent(tx, event);
    });
    await this.wake();
  }
  async assignEvent(tx, event) {
    const reserved = reservationId(event.runnerName);
    if (reserved === null) return;
    const owner = await tx.get(`job:${reserved}`);
    if (owner && event.runnerName === runnerName(owner.id, owner.generation) && owner.repo === event.repo && owner.size === event.size && owner.label === event.label && !terminal(owner)) {
      await this.save(tx, { ...owner, assignedJobId: event.id,
        assignedDone: owner.assignedDone || event.status === 'completed', nextAt: 0 }, owner);
      await this.emit('assignment', owner, { assigned_job_id: event.id }, tx);
    }
  }
  async attention(job, event, detail) {
    await this.sharedBudget?.abandon?.(job.createKey);
    await this.emit(event, job, detail);
    await this.patch(job.id, { phase: 'attention', attentionReason: event, nextAt: 0 });
    if (!job.machineId && !job.createPending) await this.release(job);
  }
  async finish(job) {
    await this.sharedBudget?.abandon?.(job.createKey);
    if (job.phase !== 'reconciling') job = await this.patch(job.id, { phase: 'reconciling' });
    if (job.haltAfterCleanup) return this.attention(job, 'alert_job_abandoned');
    if (!job.intentDone && !job.intentStarted) {
      const actual = await this.api.getJob(job, job.id);
      job = await this.patch(job.id, { intentDone: actual.status === 'completed', intentStarted: actual.status === 'in_progress' });
      if (!job.intentDone && !job.intentStarted) {
        const generation = (job.generation ?? 0) + 1;
        if ((job.retryCount ?? job.generation ?? 0) + 1 >= this.policy('MAX_JOB_ATTEMPTS', 3)) return this.attention(job, 'alert_job_retries_exhausted');
        const next = await this.storage.transaction(async tx => {
          const current = await tx.get(`job:${job.id}`);
          if (current.intentDone || current.intentStarted) return null;
          const replacement = { ...current, phase: 'queued', generation, retryCount: (current.retryCount ?? current.generation ?? 0) + 1, createKey: crypto.randomUUID(), createPending: false,
            machineId: null, machineCreatedAt: null, runnerId: null, runnerStartedAt: null, operationId: null,
            assignedJobId: null, assignedDone: false, budgetDay: null, budgetMinute: null, budgetHour: null,
            machineSize: null, createAttemptedAt: null,
            attempts: 0, permanentFailures: 0, createConflicts: 0, purgeRetries: 0, lastCheckedAt: null, nextAt: this.now() + 5000 };
          await tx.delete(`slot:${job.id}`);
          return this.save(tx, replacement, current);
        });
        if (next) { await this.emit('replacement', next); return; }
      }
    }
    await this.release(job);
    await this.patch(job.id, { phase: 'done', nextAt: 0 });
    await this.emit('done', job);
  }
  async status(privateStatus = false) {
    const active = await this.storage.list({ prefix: 'due:', limit: 1 });
    const blocked = await this.storage.get('blocked');
    const result = { enabled: this.env.ENABLED === 'true', blocked: Boolean(blocked && blocked.epoch === (this.env.RESUME_EPOCH ?? '0')),
      has_active_jobs: active.size > 0 };
    if (!privateStatus) return result;
    const sizeBlocks = await this.storage.list({ prefix: 'size-block:' });
    const flow = await this.storage.get('setup-flow');
    return { ...result, runner_environment_revision: '2026-10-19-utc', blocked_sizes: [...sizeBlocks].filter(([, block]) => block.epoch === (this.env.RESUME_EPOCH ?? '0')).map(([key]) => key.slice('size-block:'.length)),
      active_reservations: (await this.storage.list({ prefix: 'slot:' })).size,
      starts_today: await this.storage.get(`starts:${this.day()}`) ?? 0,
      starts_this_minute: await this.storage.get(`starts-minute:${Math.floor(this.now() / 60_000)}`) ?? 0,
      starts_this_hour: await this.storage.get(`starts-hour:${Math.floor(this.now() / 3600_000)}`) ?? 0,
      max_active: this.maxActive(), max_starts_per_day: this.policy('MAX_STARTS_PER_DAY', 100),
      max_starts_per_minute: this.policy('MAX_STARTS_PER_MINUTE', 12), max_starts_per_hour: this.policy('MAX_STARTS_PER_HOUR', 60),
      downgrade_count: await this.storage.get('downgrade-count') ?? 0, downgrades: await this.storage.get('downgrades') ?? [],
      setup_phase: flow?.phase ?? 'unstarted', app_configured: Boolean(await this.storage.get('github-app') || this.env.GITHUB_APP_ID),
      allowed_repositories: [...(this.allowedRepos ?? REPOSITORIES)], alerts: await this.storage.get('alerts') ?? [] };
  }
  async startsStopped(job) {
    if (!(this.allowedRepos ?? REPOSITORIES).has(job.repo) && !(this.env.ALLOW_SMOKE === 'true' && job.repo === smokeRepository)) return true;
    const epoch = this.env.RESUME_EPOCH ?? '0';
    const fleet = await this.storage.get('blocked');
    const size = await this.storage.get(`size-block:${job.size}`);
    return this.env.ENABLED !== 'true' || fleet?.epoch === epoch || size?.epoch === epoch;
  }
  async hasSpareMachine(job) {
    return this.storage.transaction(async tx => {
      let queued = 0; let unassigned = 0; let startAfter = '';
      for (;;) {
        const due = await tx.list({ prefix: 'due:', startAfter, limit: 128 });
        for (const id of due.values()) {
          const other = await tx.get(`job:${id}`);
          if (!other || terminal(other) || other.repo !== job.repo || other.size !== job.size || other.label !== job.label) continue;
          if (other.id !== job.id && !other.intentDone && !other.intentStarted) queued++;
          if (other.machineId && !other.assignedJobId && ['waiting', 'configuring', 'starting', 'running'].includes(other.phase)) unassigned++;
        }
        if (due.size < 128) break;
        startAfter = [...due.keys()].at(-1);
      }
      return unassigned > queued;
    });
  }
  async reserve(job, machineSize) {
    const maxActive = this.maxActive();
    const routerCreateName = this.sharedBudget ? `boat-router-${(await this.sharedBudget.claimKey(job.createKey)).slice(0, 32)}` : undefined;
    const windows = this.sharedBudget ? [] : [
      { field: 'budgetDay', stamp: this.day(), key: `starts:${this.day()}`, limit: this.policy('MAX_STARTS_PER_DAY', 100) },
      { field: 'budgetMinute', stamp: Math.floor(this.now() / 60_000), key: `starts-minute:${Math.floor(this.now() / 60_000)}`, limit: this.policy('MAX_STARTS_PER_MINUTE', 12) },
      { field: 'budgetHour', stamp: Math.floor(this.now() / 3600_000), key: `starts-hour:${Math.floor(this.now() / 3600_000)}`, limit: this.policy('MAX_STARTS_PER_HOUR', 60) },
    ];
    return this.storage.transaction(async tx => {
      const current = await tx.get(`job:${job.id}`);
      if (current.intentDone || current.intentStarted || terminal(current)) return null;
      if (this.beforeReserve && !await this.beforeReserve(tx, current)) return null;
      if (maxActive !== null) {
        const slots = await tx.list({ prefix: 'slot:', limit: maxActive });
        if (!await tx.get(`slot:${job.id}`) && slots.size >= maxActive) return null;
      }
      for (const window of windows) {
        window.count = await tx.get(window.key) ?? 0;
        if (current[window.field] !== window.stamp && window.count >= window.limit) return null;
      }
      const next = { ...current, machineSize: current.machineSize ?? machineSize, createPending: true, createAttemptedAt: current.createAttemptedAt ?? this.now(), ...(this.localFleet?.enabled(current.label) ? { localBoatHistory: true } : {}), ...(routerCreateName ? { routerCreateName } : {}) };
      for (const window of windows) {
        if (current[window.field] !== window.stamp) await tx.put(window.key, window.count + 1);
        next[window.field] = window.stamp;
      }
      await tx.put(`slot:${job.id}`, next.createKey);
      return this.save(tx, next, current);
    });
  }
  async create(job, ttl, recovering = false) {
    let result;
    if (this.sharedBudget) {
      if (recovering) {
        const claim = await this.sharedBudget.claim(job.createKey);
        if (claim?.status === 'pending') {
          if (job.intentDone || job.intentStarted || await this.startsStopped(job)) {
            if (!await this.sharedBudget.cancelPending(job.createKey)) throw new ApiError('boat', 503, 'reconciliation_required');
            await this.release(job);
            return this.patch(job.id, { createPending: false, createAttemptedAt: null, nextAt: this.now() });
          }
          if (this.startPreparationFailed) return this.patch(job.id, { nextAt: this.now() + 60000 });
          if (!await this.sharedBudget.begin(job.createKey, job.id)) throw new ApiError('boat', 503, 'reconciliation_required');
        } else if (!claim) {
          await this.release(job);
          return this.patch(job.id, { createPending: false, createAttemptedAt: null, nextAt: this.now() });
        } else {
          const sandbox = await this.api.findCreated(job);
          if (!sandbox) {
            if (this.now() - (claim.callingAt ?? job.createAttemptedAt ?? claim.at) < createReconcileWindow) throw new ApiError('boat', 503, 'reconciliation_required');
            await this.sharedBudget.settle(job.createKey, 'not_created');
            await this.release(job);
            return this.patch(job.id, { createPending: false, createAttemptedAt: null, nextAt: this.now() });
          }
          result = { sandbox };
        }
      } else if (!await this.sharedBudget.begin(job.createKey, job.id)) throw new ApiError('boat', 503, 'reconciliation_required');
    }
    try {
      if (!result) result = await this.api.create(job, ttl);
      if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(result.sandbox?.id ?? '')) throw new ApiError('boat', 502);
      if (this.sharedBudget && !await this.sharedBudget.settle(job.createKey, 'created')) throw new Error('start claim unavailable');
    } catch (e) {
      this.alertHook?.('create_failures', { value: 1, limit: 1, active: true });
      if (this.sharedBudget && e.service === 'boat' && e.status === 409) {
        const current = await this.storage.get(`job:${job.id}`);
        const createConflicts = (current.createConflicts ?? 0) + 1;
        await this.patch(job.id, { createConflicts });
        if (createConflicts % 3 === 0) await this.emit('alert_repeated_refusal', current, { status: 409 });
      }
      const refused = e.service === 'boat' && ((e.status >= 400 && e.status < 500 && e.status !== 409) || e.code === 'request_not_sent');
      if (this.sharedBudget && refused) {
        await this.sharedBudget.settle(job.createKey, 'not_created');
        await this.patch(job.id, { createPending: false, createAttemptedAt: null });
        await this.release(job);
      } else await this.sharedBudget?.settle(job.createKey, 'unknown');
      if (!this.sharedBudget && !recovering && e.code !== 'transport_or_response' && (e.status >= 400 && e.status < 500 || e.status === 503)) {
        await this.patch(job.id, { createPending: false, createAttemptedAt: null }); await this.release(job);
      }
      throw e;
    }
    this.alertHook?.('create_failures', { value: 0, limit: 1, active: false });
    job = await this.storage.transaction(async tx => {
      const current = await tx.get(`job:${job.id}`);
      const next = { ...current, machineId: result.sandbox.id, machineCreatedAt: current.createAttemptedAt ?? this.now(),
        createPending: false, phase: 'waiting', attempts: 0, permanentFailures: 0, routerRefusals: 0, createConflicts: 0, nextAt: this.now() + 5000, updatedAt: this.now() };
      await this.save(tx, next, current);
      if (current.machineId !== next.machineId && next.size === 'xlarge' && next.machineSize === 'large') {
        await this.emit('size_downgrade', next, { requested_size: 'xlarge', size: 'large' }, tx);
      }
      return next;
    });
    await this.emit('start', job, { size: job.machineSize ?? job.size });
    if (recovering && (job.intentDone || job.intentStarted || await this.startsStopped(job))) {
      await this.patch(job.id, { phase: 'destroying', nextAt: this.now() });
    }
  }
  async purgeFailure(job, status = 0) {
    const retries = (job.purgeRetries ?? 0) + 1;
    if (retries > 3) return this.attention(job, 'alert_purge_failed', { status });
    const delay = backoff(retries);
    await this.emit('purge_retry', job, { status, retry_ms: delay });
    return this.patch(job.id, { phase: 'destroying', purgeRetries: retries, nextAt: this.now() + delay });
  }
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async runTick() {
    await this.storage.setAlarm(this.now() + 60_000);
    const active = await this.storage.list({ prefix: 'due:', limit: 4 });
    for (const id of active.values()) {
      const job = await this.storage.get(`job:${id}`);
      if (!job || terminal(job) || job.nextAt > this.now()) continue;
      try {
        await this.step(job);
      } catch (error) {
        const current = await this.storage.get(`job:${id}`);
        const attempts = current.attempts + 1;
        const delay = backoff(attempts, error.retrySeconds ?? 0);
        const routerRefusal = this.sharedBudget && current.phase === 'queued' && !current.createPending && error.service === 'boat' && error.status >= 400 && error.status < 500;
        const routerRefusals = routerRefusal && error.status !== 429 ? (current.routerRefusals ?? 0) + 1 : 0;
        if (routerRefusals && routerRefusals % 3 === 0) await this.emit('alert_repeated_refusal', current, { status: error.status });
        if (isSizeRefusal(error) && !routerRefusal) {
          await this.storage.put(`size-block:${current.size}`, { epoch: this.env.RESUME_EPOCH ?? '0', at: this.now(), status: error.status });
          await this.emit('alert_size_refused', current, { size: current.size, status: error.status });
        } else if (isPlanRefusal(error) && !routerRefusal) {
          await this.storage.put('blocked', { epoch: this.env.RESUME_EPOCH ?? '0', at: this.now(), status: error.status });
          await this.emit('plan_refusal', current, { status: error.status });
          await this.emit('alert_plan_refusal', current, { status: error.status });
        } else {
          await this.emit('refusal', current, { status: error instanceof ApiError ? error.status : 0, retry_ms: delay });
          if (error.service === 'boat' && error.status === 429) {
            await this.emit('alert_start_limit', current, { status: 429, retry_ms: delay });
          }
          if (current.phase === 'queued' && error.service === 'boat' && [429, 503].includes(error.status)) {
            await this.storage.put('startBackoffUntil', this.now() + delay);
          }
        }
        const permanent = !routerRefusal && error instanceof ApiError && error.status >= 400 && error.status < 500 &&
          ![408, 409, 429].includes(error.status) && !isPlanRefusal(error) && !isSizeRefusal(error);
        const permanentFailures = (current.permanentFailures ?? 0) + Number(permanent);
        if (permanentFailures >= 3) {
          if (current.machineId && !['destroying', 'unregister', 'purging', 'reconciling'].includes(current.phase)) {
            await this.emit('alert_permanent_error', current, { status: error.status });
            await this.patch(id, { phase: 'destroying', haltAfterCleanup: true, permanentFailures: 0, nextAt: this.now() });
          } else await this.attention(current, 'alert_permanent_error', { status: error.status });
        } else await this.patch(id, { attempts, permanentFailures, routerRefusals, nextAt: this.now() + delay });
      }
    }
    const next = await this.storage.list({ prefix: 'due:', limit: 1 });
    if (next.size) {
      const time = Number(next.keys().next().value.split(':')[1]);
      await this.wake(Math.max(1000, time - this.now()));
    }
  }
  async step(job) {
    const now = this.now();
    const ttl = Number(this.env.MACHINE_TTL_SECONDS ?? 7200);
    if (!Number.isInteger(ttl) || ttl < 300 || ttl > 86400) throw new ApiError('config', 400);
    if (job.phase === 'reconciling') return this.finish(job);
    const expired = job.machineId && now - job.machineCreatedAt >= ttl * 1000;
    if (expired && !['destroying', 'purging', 'unregister', 'done'].includes(job.phase)) {
      job = await this.patch(job.id, { phase: 'destroying' });
      await this.emit('timeout', job);
    }
    if (job.phase === 'destroying') return this.destroy(job);
    if (job.phase === 'unregister') {
      if (job.runnerId) {
        try { await this.api.removeRunner(job); } catch (e) {
          if (this.sharedBudget && job.silentRecovery && e.status === 422) return this.patch(job.id, { nextAt: now + 60_000 });
          if (e.status !== 404) throw e;
        }
      }
      if (!job.operationId) return this.finish(job);
      return this.patch(job.id, { phase: 'purging', nextAt: now, permanentFailures: 0 });
    }
    if (job.phase === 'purging') {
      let result;
      try { result = await this.api.deletion(job); } catch (e) { if (e.status === 404) return this.purgeFailure(job, 404); throw e; }
      if (result.operation?.status === 'failed') return this.purgeFailure(job);
      if (result.operation?.status === 'completed') {
        await this.emit('destroy_purged', job, { operation_id: job.operationId });
        return this.finish(job);
      }
      return this.patch(job.id, { nextAt: now + 60_000 });
    }
    if (job.phase === 'queued' && job.createPending && this.sharedBudget) {
      if (!job.intentDone && (!job.lastCheckedAt || now - job.lastCheckedAt >= 60_000)) {
        const actual = await this.api.getJob(job);
        job = await this.patch(job.id, { lastCheckedAt: now, intentDone: actual.status === 'completed', intentStarted: actual.status === 'in_progress' });
      }
      if (job.intentDone) await this.release(job);
      return this.create(job, ttl, true);
    }
    if (job.phase === 'queued' && job.createPending) return this.create(job, ttl, true);
    if (!job.machineId && !job.createPending && (job.intentDone || job.intentStarted)) {
      return this.finish(job);
    }
    const paused = job.phase === 'queued' && await this.startsStopped(job);
    const poll = paused ? stoppedPoll : 60_000;
    const trackedDone = job.assignedJobId ? job.assignedDone : job.intentDone;
    if (!trackedDone && (!job.lastCheckedAt || now - job.lastCheckedAt >= poll)) {
      let actual;
      try { actual = await this.api.getJob(job); } catch (e) {
        if (e.status !== 404 || !job.machineId) throw e;
        await this.emit('alert_job_unavailable', job, { status: 404 });
        return this.patch(job.id, { phase: 'destroying', nextAt: now });
      }
      const done = actual.status === 'completed';
      const values = { lastCheckedAt: now };
      if (actual.runner_name === jobRunnerName(job)) { values.assignedJobId = actual.id; values.assignedDone = done; }
      if (job.assignedJobId) values.assignedDone = job.assignedDone || done;
      else {
        values.intentDone = job.intentDone || done;
        values.intentStarted = job.intentStarted || actual.status === 'in_progress';
      }
      job = await this.patch(job.id, values);
      if (!job.machineId && !job.createPending && (job.intentDone || job.intentStarted)) return this.finish(job);
    }
    if (job.machineId && job.assignedDone) return this.completePooled ? this.completePooled(job) : this.patch(job.id, { phase: 'destroying', nextAt: now });
    if (job.machineId && !job.assignedJobId && job.intentDone) {
      let missingRunner = false;
      if (job.runnerId) {
        try { if ((await this.api.runner(job)).busy) return this.patch(job.id, { nextAt: now + 60_000 }); } catch (e) { if (e.status !== 404) throw e; missingRunner = true; }
      }
      if (missingRunner) {
        const retired = await this.storage.transaction(async tx => {
          const current = await tx.get(`job:${job.id}`);
          if (!current?.intentDone || current.assignedJobId || current.phase !== job.phase || current.machineId !== job.machineId || current.runnerId !== job.runnerId) return null;
          const next = { ...current, phase: 'destroying', nextAt: now };
          await this.save(tx, next, current);
          return next;
        });
        if (retired) { await this.emit('surplus_retired', retired); return this.destroy(retired); }
        return;
      }
      job = await this.storage.get(`job:${job.id}`);
      if (!job.assignedJobId && await this.hasSpareMachine(job)) {
        job = await this.patch(job.id, { phase: 'destroying', nextAt: now });
        await this.emit('surplus_retired', job);
        return this.destroy(job);
      }
    }
    if (job.phase === 'queued') {
      if (paused) return this.patch(job.id, { nextAt: now + stoppedPoll });
      const backoffUntil = await this.storage.get('startBackoffUntil');
      if (backoffUntil > now) return this.patch(job.id, { nextAt: backoffUntil });
      if (job.generation && await this.hasSpareMachine(job)) return this.patch(job.id, { nextAt: now + 60_000 });
      const limits = await this.api.limits();
      if (limits.checkoutRequired || ['past_due', 'unpaid', 'canceled'].includes(limits.billingStatus)) throw new ApiError('boat', 402);
      const available = size => limits.machineTypes?.some(m => m.type === size && m.available === true);
      const machineSize = job.machineSize ?? (!this.sharedBudget && job.size === 'xlarge' && !available('xlarge') ? 'large' : job.size);
      if (!available(machineSize)) throw new ApiError('boat', 403, 'machine_class_plan_required');
      if (!limits.canStart) throw new ApiError('boat', 429, 'limit_reached', 60);
      const balance = await this.balanceAdmission?.(job, limits, machineSize);
      if (balance?.defer) {
        await this.sharedBudget?.abandon(job.createKey);
        return this.patch(job.id, { balancerWaitAt: job.balancerWaitAt ?? now, balancerWaitMachine: balance.waitMachine, nextAt: balance.nextAt });
      }
      if (this.sharedBudget) {
        const admission = await this.sharedBudget.admit(job.createKey, { ...limits, observedAt: limits.observedAt ?? now }, { queuedAt: job.createdAt ?? now, jobId: job.id });
        if (!admission.ok) { this.logger(JSON.stringify({ event: 'admission_refused', job_id: job.id, reason: admission.reason ?? 'refused' })); return this.patch(job.id, { nextAt: admission.nextAt ?? now + 60_000 }); }
      }
      const reserved = await this.reserve(job, machineSize);
      if (!reserved) { await this.sharedBudget?.cancelPending(job.createKey); return this.patch(job.id, { nextAt: now + 60_000 }); }
      return this.create(reserved, ttl);
    }
    if (job.phase === 'waiting') {
      const { sandbox } = await this.api.sandbox(job);
      if (sandbox?.setupStatus === 'failed' || ['error', 'cancelled', 'archived', 'stopped'].includes(sandbox?.state)) {
        await this.emit('bootstrap_failed', job);
        await this.emit('alert_bootstrap_failed', job);
        return this.patch(job.id, { phase: 'destroying', nextAt: now });
      }
      if (['ready', 'idle', 'running'].includes(sandbox?.state) && sandbox.setupStatus === 'done') {
        return this.patch(job.id, { phase: 'configuring', nextAt: now });
      }
      if (now - job.machineCreatedAt > 15 * 60_000) {
        await this.emit('bootstrap_timeout', job);
        await this.emit('alert_bootstrap_timeout', job);
        return this.patch(job.id, { phase: 'destroying', nextAt: now });
      }
      return this.patch(job.id, { nextAt: now + 10_000 });
    }
    if (job.phase === 'configuring') {
      await this.api.configure(job, (runnerId) => this.patch(job.id, { runnerId }));
      return this.patch(job.id, { phase: 'starting', attempts: 0, nextAt: now });
    }
    if (job.phase === 'starting') {
      const result = await this.api.start(job);
      if (result.success === false) throw new ApiError('boat', 502);
      return this.patch(job.id, { phase: 'running', runnerStartedAt: now, attempts: 0, nextAt: now + 60_000 });
    }
    if (job.phase === 'running') {
      if (!job.assignedJobId && now - job.runnerStartedAt > 15 * 60_000) {
        if (job.runnerId) {
          try { if ((await this.api.runner(job)).busy) return this.patch(job.id, { nextAt: now + 60_000 }); } catch (e) { if (e.status !== 404) throw e; }
        }
        await this.emit('assignment_timeout', job);
        await this.emit('alert_assignment_timeout', job);
        return this.patch(job.id, { phase: 'destroying', nextAt: now });
      }
      return this.patch(job.id, { nextAt: now + 60_000 });
    }
  }
  async destroy(job) {
    let result;
    try { result = await this.api.destroy(job); } catch (e) {
      if (e.status !== 404) throw e;
      await this.release(job);
      if (job.purgeRetries) return this.purgeFailure(job, 404);
      await this.emit('destroy_absent', job);
      return this.patch(job.id, { phase: 'unregister', nextAt: this.now() });
    }
    if (typeof result.operation?.id !== 'string') throw new ApiError('boat', 502);
    await this.release(job);
    await this.patch(job.id, { phase: 'unregister', operationId: result.operation.id, permanentFailures: 0, nextAt: this.now() });
    await this.emit('destroy', job, { operation_id: result.operation.id });
  }
}

export class Fleet {
  constructor(ctx, env, deployment = BUILD_DEPLOYMENT) {
    this.ctx = ctx;
    this.env = env;
    this.storage = env.PLUGIN_ROUTER === 'true' ? new ReadCache().wrap(ctx.storage) : ctx.storage;
    const api = new APIs(env, fetch, Date.now, () => this.storage.get('github-app'));
    this.controller = new FleetController(this.storage, env, api);
    this.setup = new SetupController(this.storage, env, api, Date.now, event => this.controller.emit(event, null));
    this.router = env.PLUGIN_ROUTER === 'true' ? installRouter(this.storage, () => this.env, { api, waitUntil: promise => ctx.waitUntil(promise), deployment }) : null;
    this.repoWebhookInbox = this.router && env.GITHUB_POLL_REPO && env.GITHUB_WEBHOOK_SECRET ? new RepoWebhookInbox(this.storage, this.router) : null;
    this.external = this.router ? new ExternalService(this.router, this.storage, this.router.externalApi ?? api, this.router.account.externalClients) : null;
    if (this.external) {
      this.router.externalSweep = () => this.external.sweep();
      this.router.externalAdmissionEntries = () => this.external.admissionEntries();
      this.router.externalAdmitStart = entry => this.external.admitStart(entry);
    }
  }
  async fetch(request) {
    this.env = { ...this.env, ENABLED: request.headers.get('X-Boat-CI-Enabled') === 'true' ? 'true' : 'false' };
    this.controller.env = this.setup.env = this.env;
    const url = new URL(request.url);
    const pollRepo = this.env.GITHUB_POLL_REPO;
    if (pollRepo && (url.pathname.startsWith('/setup') || url.pathname === '/router/resync')) return new Response(null, { status: 404 });
    if (url.pathname.startsWith('/setup')) return this.setup.fetch(request);
    if (url.pathname === '/webhook' && request.method === 'POST') {
      if (pollRepo) {
        const secret = this.env.GITHUB_WEBHOOK_SECRET;
        if (!this.router || !secret) return new Response(null, { status: 404 });
        return webhook(request, this.env, secret, async (selection, { receivedAt, verifiedAt }) => {
          const selectedAt = Date.now(), { event } = selection;
          await this.repoWebhookInbox.enqueue(selection, receivedAt);
          if (event.status === 'queued') console.info(JSON.stringify({ event: 'repo_webhook_ack', job_id: event.id, run_id: event.runId, verify_ms: verifiedAt - receivedAt, select_ms: selectedAt - verifiedAt, persist_ms: Date.now() - selectedAt }));
        }, (name, payload) => {
          if (name !== 'workflow_job' || payload?.repository?.full_name !== pollRepo) return null;
          // Use the same internal placeholder as the repo-token snapshot. No App installation is consulted.
          return this.router.select(name, { ...payload, installation: { id: 1 } });
        });
      }
      const { webhookSecret } = appCredentials(this.env, await this.storage.get('github-app'));
      if (this.router) return webhook(request, this.env, webhookSecret, selection => this.router.ingest(selection), (n, p) => this.router.select(n, p));
      return webhook(request, this.env, webhookSecret, event => this.controller.ingest(event));
    }
    // Disaster-recovery export of the durable state: every record minus secrets, plus the plain configuration.
    if (url.pathname === '/export' && request.method === 'GET') {
      if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
      return exportResponse(this.storage, this.env, { build: BUILD_COMMIT, deployment: BUILD_DEPLOYMENT });
    }
    if (this.router) {
      if (url.pathname.startsWith('/router/lease/')) return this.externalRequest(request, url);
      const claimerPath = url.pathname.replace('/router/claimer/', '/router/local/');
      if (url.pathname === '/router/build' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        return Response.json({ do_commit: BUILD_COMMIT }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/pool-mode' && request.method === 'POST') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const mode = url.searchParams.get('mode');
        const ids = [...this.router.projects.values()].filter(project => project.box).map(project => project.config.id);
        if (!['on', 'drain'].includes(mode) || !ids.length) return new Response(null, { status: 400 });
        if (this.router.ticking) return new Response(null, { status: 409 });
        const operation = this.storage.transaction(async tx => {
          const current = await Promise.all(ids.map(id => tx.get(`project:${id}:pool:mode`)));
          const migrated = await Promise.all(ids.map(id => tx.get(`project:${id}:pool:migrated`)));
          const disabled = current.every(value => [undefined, 'off', 'shadow'].includes(value));
          if (mode === 'on' && disabled && migrated.some(value => value?.done) && !migrated.every(value => value?.done)) return false;
          if (mode === 'on' && (current.every(value => value === 'drain') || (disabled && migrated.some(value => value?.done)))) {
            const ledger = await tx.get(this.router.ledger.key);
            if (Object.values(ledger?.claims ?? {}).some(claim => ids.includes(claim.project) && claim.status !== 'created')) return false;
            for (const id of ids) {
              for (const [prefix, safe] of [['create:', 'pending'], ['box:', 'deleted']]) {
                let cursor = '';
                for (;;) {
                  const page = await tx.list({ prefix: `project:${id}:${prefix}`, startAfter: cursor, limit: 128 });
                  if ([...page.values()].some(record => record.state !== safe)) return false;
                  if (page.size < 128) break;
                  cursor = [...page.keys()].at(-1);
                }
              }
            }
          } else if (mode === 'on' && current.some(value => ![undefined, 'off', 'shadow'].includes(value))) return false;
          if (mode === 'drain' && current.some(value => !['on', 'drain'].includes(value))) return false;
          for (const id of ids) {
            await writeReuseState(tx, 'off', Date.now(), 'pool_mode', null, `project:${id}:`);
            await tx.put(`project:${id}:pool:mode`, mode);
          }
          return true;
        });
        this.router.ticking = operation;
        try { if (!await operation) return new Response(null, { status: 409 }); }
        finally { if (this.router.ticking === operation) this.router.ticking = null; }
        for (const id of ids) { this.router.observeAlert?.(id, 'pool_drain', mode === 'drain'); this.router.observeAlert?.(id, 'reuse_off', true); }
        await this.storage.setAlarm(Date.now() + 1000);
        return new Response(null, { status: 202 });
      }
      if (url.pathname === '/router/pools' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.box) return new Response(null, { status: 400 });
        const pools = Object.fromEntries(await project.storage.list({ prefix: 'pool:status:' }));
        return Response.json({ pools, snapshot: await project.storage.get('pool:snapshot') ?? null, ...(this.router.account.paidOverflow?.enabled === true ? { paidOverflow: await this.router.ledger.paidStatus() } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/external-leases' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const items = []; let cursor = '';
        for (;;) {
          const page = await this.storage.list({ prefix: 'external-lease:', startAfter: cursor, limit: 128 });
          for (const lease of page.values()) if (lease.state !== 'closed') items.push({ client: lease.client, id: lease.id, state: lease.state, project: lease.project ?? null, size: lease.size ?? null, machineId: lease.machineId ?? null, createdAt: lease.createdAt, expiresAt: lease.expiresAt, releaseRequested: lease.releaseRequested === true });
          if (page.size < 128) break;
          cursor = [...page.keys()].at(-1);
        }
        return Response.json({ leases: items }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/boxes' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.box) return new Response(null, { status: 400 });
        const boxes = []; let startAfter = '';
        for (;;) {
          const page = await project.storage.list({ prefix: 'box:', startAfter, limit: 128 });
          for (const box of page.values()) boxes.push({ createdAt: box.createdAt ?? null, machineId: box.machineId, account: box.account ?? (this.env.ACCOUNT_CUTOVER === 'true' ? 'secondary' : this.router.account.id), state: box.state, jobs: box.jobs ?? 0, generation: box.generation ?? 0, runnerName: box.runnerName ?? null, lane: box.lane ?? null, size: box.size ?? null, since: box.since ?? null, retirementReason: box.retirementReason ?? box.failureReason ?? null, exitReason: box.exitReason ?? null, lastTransition: box.history?.at(-1) ?? null, crossSizeHandoffs: box.crossSizeHandoffs ?? 0, lastCrossSizeAt: box.lastCrossSizeAt ?? null, hostCpu: box.hostCpu ?? null, slowHost: box.slowHost === true });
          if (page.size < 128) break;
          startAfter = [...page.keys()].at(-1);
        }
        // Slow boxes by host class: live boxes and boxes created in the last 24 h.
        const hostClasses = {};
        for (const box of boxes) {
          if (!box.hostCpu) continue;
          const row = hostClasses[box.hostCpu] ??= { live: 0, liveSlow: 0, day: 0, daySlow: 0 };
          if (box.state !== 'deleted') { row.live++; if (box.slowHost) row.liveSlow++; }
          if (Number.isFinite(box.createdAt) && Date.now() - box.createdAt < 86_400_000) { row.day++; if (box.slowHost) row.daySlow++; }
        }
        return Response.json({ project: project.config.id, boxes: boxes.map(({ createdAt, ...rest }) => rest), hostClasses }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/reconcile' && request.method === 'POST') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.box || !['on', 'drain'].includes(await project.storage.get('pool:mode'))) return new Response(null, { status: 400 });
        await project.storage.put('pool:snapshot-due', Date.now());
        await project.storage.setAlarm(Date.now() + 1000);
        return new Response(null, { status: 202 });
      }
      if (url.pathname === '/router/box' && request.method === 'POST') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project')), id = url.searchParams.get('machine_id');
        if (!project?.box || !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(id ?? '') || url.searchParams.get('action') !== 'retire') return new Response(null, { status: 400 });
        if (!['on', 'drain'].includes(await project.storage.get('pool:mode')) || this.router.ticking) return new Response(null, { status: 409 });
        const snapshot = await project.storage.get('pool:snapshot'), box = await project.storage.get(`box:${id}`);
        if (!snapshot?.complete || box?.state !== 'idle' || snapshot.runners?.some(runner => runner.id === box.runnerId && runner.busy)) return new Response(null, { status: 409 });
        const operation = project.box({ storage: project.storage, ledger: this.router.ledger, config: project.config, hooks: project.hooks }).retire(id);
        this.router.ticking = operation;
        try { return new Response(null, { status: await operation ? 202 : 409 }); }
        finally { if (this.router.ticking === operation) this.router.ticking = null; }
      }
      if (url.pathname === '/router/restart' && request.method === 'POST') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        if (this.env.ENABLED !== 'false') return new Response(null, { status: 409 });
        this.ctx.abort('operator restart during disabled deployment');
      }
      if (url.pathname === '/sweep' && request.method === 'POST') { await this.moveAppSecretsOnce(); await this.router.tick(); return new Response(null, { status: 202 }); }
      if (url.pathname === '/health' && request.method === 'GET') return Response.json({ mode: 'router', account: this.router.account.id });
      if (claimerPath === '/router/local/claim' && request.method === 'GET') {
        if (url.searchParams.get('demand') === '1') {
          if (!await authorizedControl(request, this.env) && !await authorizedLocal(request, this.env)) return new Response(null, { status: 401 });
          const projects = {};
          for (const [id, project] of this.router.projects) {
            if (!project.local) continue;
            const mode = await project.storage.get('pool:mode');
            const snapshot = await project.storage.get('pool:snapshot');
            if (mode !== 'on' || snapshot?.complete !== true) { projects[id] = { complete: false, labels: [] }; continue; }
            const labels = new Set(), jobs = (await records(project.storage, 'gh-job:')).filter(job => !job.missing);
            for (const job of runnableDemand(jobs, project.config.workflowConcurrency, true, { laneCaps: await lanesSwitchOn(project.storage, project.config) })) {
              if (job.status !== 'queued') continue;
              try { const [repo, label] = JSON.parse(job.pool); if (repo === project.config.repo && project.config.labels?.includes(label)) labels.add(label); } catch {}
            }
            projects[id] = { complete: true, labels: [...labels] };
          }
          return Response.json({ projects }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const name = url.searchParams.get('name');
        if (name !== null) {
          if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
          const project = this.router.projects.get(url.searchParams.get('project'));
          if (!project?.local || !/^local-[a-f0-9-]{36}$/.test(name)) return new Response(null, { status: 400 });
          const runner = await project.storage.get(`local-runner:${name}`);
          if (!runner) return new Response(null, { status: 404 });
          const { jobId, assignedJobId, state, at, startedAt, completedAt, retiringAt, retiredAt, host, label, lost, lostOutcome, lostJobId, lostCheck } = runner;
          return Response.json({ jobId, assignedJobId, state, at, startedAt, completedAt, retiringAt, retiredAt, host, label, ...(lost ? { lost, lostOutcome: lostOutcome ?? null, lostJobId: lostJobId ?? null } : {}), ...(lostCheck ? { lostCheck } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
        }
        if (!await authorizedControl(request, this.env) && !await authorizedLocal(request, this.env)) return new Response(null, { status: 401 });
        if (![...this.router.projects.values()].some(project => project.local && (project.config.externalClaimer ?? project.config.localFirst)?.enabled === true)) return new Response(null, { status: 404 });
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      }
      if (['/router/local/claim', '/router/local/unavailable', '/router/local/release', '/router/local/started', '/router/local/operator-release', '/router/local/capacity'].includes(claimerPath) && request.method === 'POST') {
        // The claimer token alone reaches the agent endpoints (a claim mints a GitHub JIT runner
        // credential); the operator token alone reaches operator-release.
        const operator = claimerPath === '/router/local/operator-release';
        if (operator ? !await authorizedControl(request, this.env) : !await authorizedLocal(request, this.env)) return new Response(null, { status: 401 });
        if (Number(request.headers.get('Content-Length')) > 4096) return new Response(null, { status: 413 });
        let body;
        try { const raw = await request.text(); if (raw.length > 4096) return new Response(null, { status: 413 }); body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
        if (claimerPath === '/router/local/capacity') {
          if (!body || typeof body !== 'object' || !['active', 'offers', 'maxConcurrent', 'maxPerMini'].every(k => Number.isSafeInteger(body[k]) && body[k] >= 0 && body[k] <= 1000) || !body.reasons || typeof body.reasons !== 'object' || Array.isArray(body.reasons) || Object.entries(body.reasons).length > 50 || !Object.entries(body.reasons).every(([k,v]) => /^[a-z_0-9]{1,48}$/.test(k) && Number.isSafeInteger(v) && v >= 0 && v <= 10000)) return new Response(null, { status: 400 });
          if (body.hosts !== undefined && (!body.hosts || typeof body.hosts !== 'object' || Array.isArray(body.hosts) || !Object.entries(body.hosts).every(([host, reasons]) => localHosts.includes(host) && reasons && typeof reasons === 'object' && !Array.isArray(reasons) && Object.entries(reasons).length <= 50 && Object.entries(reasons).every(([key, count]) => /^[a-z_0-9]{1,48}$/.test(key) && Number.isSafeInteger(count) && count >= 0 && count <= 10000)))) return new Response(null, { status: 400 });
          this.router.localCapacity = { at: Date.now(), active: body.active, offers: body.offers, maxConcurrent: body.maxConcurrent, maxPerMini: body.maxPerMini, reasons: body.reasons, hosts: body.hosts ?? {} };
          return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
        }
        const project = this.router.projects.get(body?.project);
        if (!project?.local || (project.config.externalClaimer ?? project.config.localFirst)?.enabled !== true) return new Response(null, { status: 404, headers: { 'X-Local-Reason': 'project_disabled', 'Cache-Control': 'no-store' } });
        const local = project.local({ storage: project.storage, ledger: this.router.ledger, config: project.config, hooks: project.hooks });
        if (!local) return new Response(null, { status: 404 });
        const labelOperation = url.pathname.endsWith('/claim') || url.pathname.endsWith('/unavailable');
        if (labelOperation && (!Array.isArray(body.labels) || body.labels.length !== 1 || typeof body.labels[0] !== 'string')) return new Response(null, { status: 400 });
        if (url.pathname.endsWith('/claim') && body.host !== undefined && (typeof body.host !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.host))) return new Response(null, { status: 400 });
        if (body.waitMs !== undefined && (!Number.isInteger(body.waitMs) || body.waitMs < 0 || body.waitMs > 8000 || !body.host || !url.pathname.endsWith('/claim'))) return new Response(null, { status: 400 });
        if (!labelOperation && (typeof body.name !== 'string' || !/^local-[a-f0-9-]{36}$/.test(body.name))) return new Response(null, { status: 400 });
        if (body.reason !== undefined && (!url.pathname.endsWith('/release') || typeof body.reason !== 'string' || !/^[a-z_]{1,32}$/.test(body.reason))) return new Response(null, { status: 400 });
        if (body.detail !== undefined && (body.reason === undefined || typeof body.detail !== 'string' || !/^[a-z0-9_ ]{0,64}$/i.test(body.detail))) return new Response(null, { status: 400 });
        let candidates = null;
        if (body.offers !== undefined) {
          if (!url.pathname.endsWith('/claim') || !body.host || !Array.isArray(body.offers) || body.offers.length < 1 || body.offers.length > 20) return new Response(null, { status: 400 });
          const slotClass = local.config.labels?.[body.labels[0]], seen = new Set();
          candidates = [];
          for (const entry of body.offers) {
            const candidate = this.router.projects.get(entry?.project), key = `${entry?.project}:${entry?.label}`;
            const config = candidate?.config?.externalClaimer ?? candidate?.config?.localFirst;
            const kind = config?.labels?.[entry?.label];
            if (!candidate?.local || candidate.config.dispatchOnly !== true || config?.enabled !== true || config.localOnly?.includes(entry?.label) || !kind || !(kind === slotClass || (slotClass === 'browser' && kind === 'generic')) || seen.has(key)) return new Response(null, { status: 400 });
            seen.add(key);
            candidates.push({ project: entry.project, label: entry.label, local: candidate.local({ storage: candidate.storage, ledger: this.router.ledger, config: candidate.config, hooks: candidate.hooks }) });
          }
        }
        const diagnostics = {};
        const operation = cache => url.pathname.endsWith('/claim') ? candidates ? claimAny(candidates, body.host, diagnostics, cache ?? this.router.localCountsCache()) : local.claim(body.labels[0], body.host, diagnostics) : url.pathname.endsWith('/unavailable') ? local.unavailable(body.labels[0]) : (url.pathname.endsWith('/release') || url.pathname.endsWith('/operator-release')) ? local.release(body.name, body.reason ?? null, body.detail ?? null) : local.started(body.name);
        const localRequestAt = Date.now();
        try {
          // A reserved mini slot may join the offer queue without waiting for
          // an unrelated tick. Only the admission boundary consumes it.
          if (candidates && body.waitMs > 0 && project.config.dispatchOnly === true) {
            const offered = this.router.offerLocal(operation, value => (candidates.find(entry => entry.project === value.project)?.local ?? local).release(value.name), request.signal, body.waitMs);
            await local.controller.wake(1000);
            const result = await offered;
            if (!result) return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store', 'X-Local-Reason': diagnostics.reason ?? 'no_runnable_job' } });
            return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
          }
          const outcome = await this.router.localAtBoundary(operation);
          if (!outcome.ran) return new Response(null, { status: url.pathname.endsWith('/claim') ? 204 : 503, headers: { 'Cache-Control': 'no-store', 'X-Local-Reason': 'router_busy' } });
          let result = outcome.value;
          const offerWait = Math.min(body.waitMs ?? 0, Math.max(0, 13000 - (Date.now() - localRequestAt)));
          if (!result && url.pathname.endsWith('/claim') && project.config.dispatchOnly === true && offerWait > 0 && diagnostics.reason === 'no_runnable_job') {
            const offered = this.router.offerLocal(operation, value => (candidates?.find(entry => entry.project === value.project)?.local ?? local).release(value.name), request.signal, offerWait);
            if (this.router.ticking) await local.controller.wake(1000);
            result = await offered;
          }
          if (!result) return new Response(null, { status: url.pathname.endsWith('/claim') ? 204 : 409, headers: { 'Cache-Control': 'no-store', ...(diagnostics.reason ? { 'X-Local-Reason': diagnostics.reason } : {}) } });
          return url.pathname.endsWith('/claim') ? Response.json(result, { headers: { 'Cache-Control': 'no-store' } }) : new Response(null, { status: 204 });
        } catch { return new Response(null, { status: 503 }); }
      }
      if (url.pathname === '/router/resync' && request.method === 'POST') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (project && ['on', 'drain'].includes(await project.storage.get('pool:mode'))) return new Response(null, { status: 404 });
        const id = Number(url.searchParams.get('job_id'));
        const installation = Number(url.searchParams.get('installation'));
        if (!project || !Number.isSafeInteger(id) || id < 1 || !Number.isSafeInteger(installation) || installation < 1) return new Response(null, { status: 400 });
        let job;
        try { job = await this.controller.api.getJob({ repo: project.config.repo, installation, id }); }
        catch { return new Response(null, { status: 503 }); }
        if (job?.id !== id || !((job.status === 'queued' && !job.runner_name) || (job.status === 'in_progress' && typeof job.runner_name === 'string' && job.runner_name.startsWith('boat-ci-j')))) return new Response(null, { status: 409 });
        const selection = this.router.select('workflow_job', { action: job.status, repository: { full_name: project.config.repo }, installation: { id: installation }, workflow_job: job });
        if (!selection || selection.project !== project.config.id) return new Response(null, { status: 422 });
        if (project.resync) await project.resync(selection.event, { storage: project.storage, ledger: this.router.ledger, config: project.config, hooks: project.hooks });
        else await this.router.ingest(selection);
        return new Response(null, { status: 202 });
      }
      if (url.pathname === '/router/pool-shadow' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.local) return new Response(null, { status: 400 });
        if (request.method === 'POST') {
          const mode = url.searchParams.get('mode');
          if (mode === 'shadow') return Response.json({ error: 'shadow pool mode is retired' }, { status: 400 });
          if (mode !== 'off') return new Response(null, { status: 400 });
          if (await project.storage.get('pool:migrated') || ['on', 'drain'].includes(await project.storage.get('pool:mode'))) return new Response(null, { status: 409 });
          if (this.router.ticking) return new Response(null, { status: 409 });
          const previous = await project.storage.get('pool:mode');
          await project.storage.put('pool:mode', mode);
          if (previous !== mode) this.router.observeAlert?.(project.config.id, 'pool_drain', mode === 'off');
          if (mode === 'shadow') await project.storage.setAlarm(Date.now() + 1000);
        }
        const entries = await project.storage.get('pool:shadow') ?? [];
        return Response.json({ mode: await project.storage.get('pool:mode') ?? 'off', latest: entries.at(-1) ?? null, entries }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/pacing' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const headers = { 'Cache-Control': 'no-store' }, name = url.searchParams.get('account');
        const selected = name ? this.router.accountPools?.[name] : null;
        if (name && !selected) return new Response(null, { status: 400 });
        const policy = selected?.ledger.policy ?? this.router.account;
        if (policy.poolPacing?.enabled !== true || policy.poolPacing?.mode !== 'dynamic') return Response.json({ enabled: false, available: false, reason: 'disabled' }, { headers });
        const sampledAt = Date.now();
        let limits;
        try { limits = await (selected?.limits?.() ?? this.router.accountLimits?.() ?? this.controller.api.limits()); }
        catch { return Response.json({ enabled: true, available: false, reason: 'provider_unavailable' }, { headers }); }
        const snapshot = snapshotLimits(limits, sampledAt);
        const ledger = await this.storage.get(selected?.ledger.key ?? this.router.ledger.key);
        const projected = dynamicPacing({ snapshot: { ...snapshot, canStart: true }, policy, claims: Object.values(ledger?.claims ?? {}), previous: ledger?.dynamicPacing, now: Date.now() });
        if (!projected) return Response.json({ enabled: true, available: false, reason: 'limits_unavailable' }, { headers });
        return Response.json({ enabled: true, available: true, admissionAvailable: snapshot.canStart && (selected?.enabled ?? true), ...(selected ? { account: name, accountEnabled: selected.enabled } : {}),
          ...projected.status, ...(!snapshot.canStart ? { reason: 'provider_refused' } : {}), ...(paidExtraEnabled(policy) ? { paidExtra: paidExtraSummary(ledger?.paidExtraSpend, policy, sampledAt) } : {}) }, { headers });
      }
      if (url.pathname === '/router/claims' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const name = url.searchParams.get('account'), selected = name ? this.router.accountPools?.[name] : null;
        if (name && !selected) return new Response(null, { status: 400 });
        const ledger = await this.storage.get(selected?.ledger.key ?? this.router.ledger.key);
        const policy = selected?.ledger.policy ?? this.router.account;
        return Response.json({ claims: ledger?.claims ?? {}, waiting: ledger?.waiting ?? [], poolPacing: ledger?.poolPacing ?? null,
          ...(paidExtraEnabled(policy) ? { paidExtra: paidExtraSummary(ledger?.paidExtraSpend, policy, Date.now()) } : {}) }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/balancer' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const projects = {};
        for (const [id, project] of this.router.projects) projects[id] = await project.storage.get('balancer:decisions') ?? [];
        return Response.json({ enabled: this.router.account.balancer?.enabled === true, projects }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/status' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        if (!url.searchParams.has('project') && !url.searchParams.has('job_id')) return Response.json({ autoscale: this.router.autoscale ?? null }, { headers: { 'Cache-Control': 'no-store' } });
        const project = this.router.projects.get(url.searchParams.get('project'));
        const id = Number(url.searchParams.get('job_id'));
        if (!project || !Number.isSafeInteger(id) || id < 1) return new Response(null, { status: 400 });
        if (['on', 'drain'].includes(await project.storage.get('pool:mode'))) {
          const job = await project.storage.get(`gh-job:${id}`);
          if (!job) return new Response(null, { status: 404 });
          const owner = job.runnerName ? await project.storage.get(`runner:${job.runnerName}`) : null;
          const box = owner?.machineId ? await project.storage.get(`box:${owner.machineId}`) : null;
          const label = JSON.parse(job.pool)[1], pool = await project.storage.get(`pool:status:${label}`);
          const placement = await project.storage.get(`placement:${id}`) ?? null;
          return Response.json({ job, box, pool, placement }, { headers: { 'Cache-Control': 'no-store' } });
        }
        const job = await project.storage.get(`job:${id}`);
        if (!job) return new Response(null, { status: 404 });
        const machineId = job.machineId ?? job.lastMachineId;
        const machine = machineId ? await project.storage.get(`machine:${machineId}`) : null;
        const override = await project.storage.get('reuse:override') ?? 'config';
        return Response.json({ job_id: id, phase: job.phase, attention_reason: job.attentionReason ?? null, machine_id: machineId ?? null,
          reuse_override: override, reuse_enabled: override !== 'off' && this.router.account.reuse?.enabled === true && project.config.reuse?.mode === 'on' && project.config.dockerAccess !== true,
          runner_id: job.runnerId ?? job.lastRunnerId ?? null, generation: job.generation ?? null,
          machine_state: machine?.state ?? null, machine_jobs: machine?.jobs ?? null }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/reuse' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project || !project.local) return new Response(null, { status: 400 });
        if (request.method === 'POST') {
          const mode = url.searchParams.get('mode');
          if (!['off', 'config'].includes(mode)) return new Response(null, { status: 400 });
          const rawJobId = url.searchParams.get('queue_job_id');
          if (rawJobId !== null && (mode !== 'off' || !/^[1-9]\d*$/.test(rawJobId) || !Number.isSafeInteger(Number(rawJobId)))) return new Response(null, { status: 400 });
          const rawRevision = url.searchParams.get('if_revision');
          if (rawRevision !== null && (mode !== 'config' || !/^(0|[1-9]\d*)$/.test(rawRevision) || !Number.isSafeInteger(Number(rawRevision)))) return new Response(null, { status: 400 });
          const callerNonce = url.searchParams.get('caller_nonce');
          if (callerNonce !== null && (mode !== 'off' || !/^[0-9a-f]{32}$/.test(callerNonce))) return new Response(null, { status: 400 });
          if (this.router.ticking) return new Response(null, { status: 409 });
          const operation = project.storage.transaction(async tx => {
            if (rawRevision !== null && (await readReuseState(tx)).revision !== Number(rawRevision)) return false;
            if (rawJobId !== null) {
              const id = Number(rawJobId), job = await tx.get(`gh-job:${id}`), claim = await tx.get(`wait:claim:${id}`);
              if (!job || job.status !== 'queued' || job.runnerName || !job.pool) return false;
              let label;
              try { label = JSON.parse(job.pool)[1]; } catch { return false; }
              if (typeof label !== 'string') return false;
              const pool = await tx.get(`pool:status:${label}`);
              if (!pool || ['ledger:pacing', 'ledger:pacing_reserve', 'ledger:fairness', 'ledger:day_cap'].includes(pool.reason)) return false;
              if (claim && (!Number.isFinite(claim.until) || claim.until > Date.now())) return false;
            }
            return writeReuseState(tx, mode, Date.now(), 'control', callerNonce);
          });
          this.router.ticking = operation;
          let changed;
          try { changed = await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
          if (!changed) return new Response(null, { status: 412 });
          this.router.observeAlert?.(project.config.id, 'reuse_off', mode === 'off');
        }
        const state = await project.storage.transaction(tx => readReuseState(tx));
        return Response.json({ ...state, enabled: state.override !== 'off' && this.router.account.reuse?.enabled === true && project.config.reuse?.mode === 'on' && project.config.dockerAccess !== true }, { headers: { 'Cache-Control': 'no-store' } });
      }
      // Per-label switch for Docker-enabled reuse. Off by default; off is the rollback:
      // new boxes are created for one job, and reset boxes are destroyed at their next finish or ready step.
      if (url.pathname === '/router/docker-reuse' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.box || project.config.dockerAccess !== true) return new Response(null, { status: 400 });
        if (request.method === 'POST') {
          const label = url.searchParams.get('label'), mode = url.searchParams.get('mode');
          if (!project.config.labels.includes(label) || !['on', 'off'].includes(mode)) return new Response(null, { status: 400 });
          if (project.config.reuse?.docker !== true && mode === 'on') return new Response(null, { status: 409 });
          if (this.router.ticking) return new Response(null, { status: 409 });
          const operation = project.storage.transaction(async tx => {
            const current = await tx.get(DOCKER_REUSE_KEY) ?? {};
            await tx.put(DOCKER_REUSE_KEY, { ...current, [label]: mode });
            await tx.put('reuse:docker-labels:history', [...(await tx.get('reuse:docker-labels:history') ?? []).slice(-49), { at: Date.now(), label, mode }]);
            return true;
          });
          this.router.ticking = operation;
          try { await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
          await project.storage.setAlarm(Date.now() + 1000);
        }
        const switches = await project.storage.get(DOCKER_REUSE_KEY) ?? {};
        return Response.json({ project: project.config.id, supported: project.config.reuse?.docker === true, labels: Object.fromEntries(project.config.labels.map(label => [label, switches[label] === 'on' ? 'on' : 'off'])), idleHoldSeconds: project.config.reuse?.idleHoldSeconds ?? null, maxJobs: project.config.reuse?.maxJobs ?? null, history: await project.storage.get('reuse:docker-labels:history') ?? [] }, { headers: { 'Cache-Control': 'no-store' } });
      }
      // per-label switch for local-first on the minis (through the local agent's
      // Docker sidecar runner). Off by default; off is the rollback: the agent's claims are refused with
      // local_disabled and the pool plans Boat boxes without an offer hold.
      if (url.pathname === '/router/local-mode' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        const claimer = project?.config?.externalClaimer ?? project?.config?.localFirst;
        if (!project?.box || !project.local || claimer?.switch !== 'storage') return new Response(null, { status: 400 });
        if (request.method === 'POST') {
          const label = url.searchParams.get('label'), mode = url.searchParams.get('mode');
          if (!project.config.labels.includes(label) || !['on', 'off'].includes(mode)) return new Response(null, { status: 400 });
          if (mode === 'on' && (claimer.enabled !== true || !claimer.labels?.[label])) return new Response(null, { status: 409 });
          if (this.router.ticking) return new Response(null, { status: 409 });
          const operation = project.storage.transaction(async tx => {
            const current = await tx.get(LOCAL_MODE_KEY) ?? {};
            await tx.put(LOCAL_MODE_KEY, { ...current, [label]: mode });
            await tx.put('local:labels:history', [...(await tx.get('local:labels:history') ?? []).slice(-49), { at: Date.now(), label, mode }]);
            return true;
          });
          this.router.ticking = operation;
          try { await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
          await project.storage.setAlarm(Date.now() + 1000);
        }
        const switches = await project.storage.get(LOCAL_MODE_KEY) ?? {};
        const capacity = this.router.localCapacity ?? null;
        return Response.json({ project: project.config.id, labels: Object.fromEntries(project.config.labels.map(label => [label, { mode: switches[label] === 'on' ? 'on' : 'off', local: labelLocal(claimer, switches, label), class: claimer.labels?.[label] ?? null }])), offerSeconds: claimer.offerSeconds ?? 30, registeredHoldSeconds: claimer.registeredHoldSeconds ?? 0, branches: claimer.branches ?? null, boatOnlyJobs: claimer.boatOnlyJobs ?? null, boatLabels: project.config.boatLabels ?? [], agent: capacity ? { at: capacity.at, active: capacity.active, maxConcurrent: capacity.maxConcurrent, room: localRoom(capacity, Date.now()), hosts: capacity.hosts ?? {} } : null, offers: await project.storage.get('local:offer-seen') ?? {}, history: await project.storage.get('local:labels:history') ?? [] }, { headers: { 'Cache-Control': 'no-store' } });
      }
      // Setup watchdog records and its runtime switch (default on while the config enables it; off needs no deploy).
      if (url.pathname === '/router/setup-watchdog' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.box) return new Response(null, { status: 400 });
        if (request.method === 'POST') {
          const mode = url.searchParams.get('mode');
          if (!['on', 'off'].includes(mode)) return new Response(null, { status: 400 });
          if (!project.config.setupWatchdog) return new Response(null, { status: 409 });
          if (this.router.ticking) return new Response(null, { status: 409 });
          const operation = project.storage.transaction(async tx => {
            await tx.put(SETUP_WATCHDOG_SWITCH_KEY, { mode, at: Date.now() });
            await tx.put(`${SETUP_WATCHDOG_SWITCH_KEY}:history`, [...(await tx.get(`${SETUP_WATCHDOG_SWITCH_KEY}:history`) ?? []).slice(-49), { at: Date.now(), mode }]);
            return true;
          });
          this.router.ticking = operation;
          try { await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
        }
        const [records, checks, runs, switchRecord, history] = await Promise.all([
          listRecords(project.storage, SETUP_WATCHDOG_PREFIX), listRecords(project.storage, SETUP_WATCHDOG_CHECK_PREFIX), listRecords(project.storage, SETUP_WATCHDOG_RUN_PREFIX),
          project.storage.get(SETUP_WATCHDOG_SWITCH_KEY), project.storage.get(`${SETUP_WATCHDOG_SWITCH_KEY}:history`),
        ]);
        const mode = !project.config.setupWatchdog?.enabled ? 'disabled' : switchRecord?.mode === 'off' ? 'off' : 'on';
        return Response.json({ project: project.config.id, config: project.config.setupWatchdog ?? null, mode, switchedAt: switchRecord?.at ?? null, history: history ?? [], records, checks, runs }, { headers: { 'Cache-Control': 'no-store' } });
      }
      // lane view and runtime switch. GET shows the rules, the queued jobs per lane with their effective
      // rank, and the slot usage against the reservation; POST mode=off restores plain FIFO without a deploy.
      if (url.pathname === '/router/lanes' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.box) return new Response(null, { status: 400 });
        const rules = laneRules(project.config);
        if (request.method === 'POST') {
          const mode = url.searchParams.get('mode');
          if (!['on', 'off'].includes(mode)) return new Response(null, { status: 400 });
          if (!rules.length) return new Response(null, { status: 409 });
          if (this.router.ticking) return new Response(null, { status: 409 });
          const operation = project.storage.transaction(async tx => {
            await tx.put(LANES_SWITCH_KEY, { mode, at: Date.now() });
            await tx.put(`${LANES_SWITCH_KEY}:history`, [...(await tx.get(`${LANES_SWITCH_KEY}:history`) ?? []).slice(-49), { at: Date.now(), mode }]);
            return true;
          });
          this.router.ticking = operation;
          try { await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
        }
        const now = Date.now();
        const [jobs, boxes, creates, switchRecord, history] = await Promise.all([
          records(project.storage, 'gh-job:'), records(project.storage, 'box:'), records(project.storage, 'create:'),
          project.storage.get(LANES_SWITCH_KEY), project.storage.get(`${LANES_SWITCH_KEY}:history`),
        ]);
        const mode = !rules.length ? 'disabled' : switchRecord?.mode === 'off' ? 'off' : 'on';
        const open = jobs.filter(job => ['queued', 'in_progress'].includes(job.status) && !job.missing);
        const queued = open.filter(job => job.status === 'queued').map(job => ({ id: job.id, runId: job.runId ?? null, runName: job.runName ?? null, lane: job.lane ?? null, lanePriority: job.lanePriority ?? null, rank: laneRank(job, now), queuedAt: job.queuedAt ?? null, waitSeconds: Number.isFinite(job.queuedAt) ? Math.max(0, Math.round((now - job.queuedAt) / 1000)) : null, pool: job.pool }))
          .sort((a, b) => a.rank - b.rank || a.queuedAt - b.queuedAt || a.id - b.id);
        const running = open.filter(job => job.status === 'in_progress').map(job => ({ id: job.id, runId: job.runId ?? null, runName: job.runName ?? null, lane: job.lane ?? null, runnerName: job.runnerName ?? null, startedAt: job.startedAt ?? null }));
        const byLane = {};
        for (const job of open) { const key = job.lane ?? 'none'; byLane[key] ??= { queued: 0, running: 0 }; byLane[key][job.status === 'queued' ? 'queued' : 'running']++; }
        // `borrowed` is the number of reserved slots the other lanes hold right now (from the usage, so it
        // stays visible after lending stopped); `lending` is this tick's decision per reserved lane.
        const used = laneUsage(boxes, creates, open), reserved = reservedByLane(project.config), cap = project.config.caps?.concurrent;
        const lending = mode === 'on' ? laneLending(project.config, jobs, now) : { lend: {}, lanes: {} };
        const borrowed = mode === 'on' ? borrowedSlots({ used, cap, reserved }) : 0;
        return Response.json({ project: project.config.id, mode, switchedAt: switchRecord?.at ?? null, history: history ?? [], rules, concurrent: cap ?? null, reserved, used, borrowed, lending: lending.lanes, lend: lending.lend, lanes: byLane, queued, running }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/verification-outcomes' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.resetVerificationBreaker) return new Response(null, { status: 400 });
        return Response.json(await project.storage.get('verification:reset-outcomes') ?? [], { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/verification-failures' && request.method === 'GET') {
        try {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.resetVerificationBreaker) return new Response(null, { status: 400 });
        const prefix = FAILURE_PREFIX, failures = [];
        const rawLimit = url.searchParams.get('limit'), rawCursor = url.searchParams.get('cursor');
        const paginated = rawLimit !== null || rawCursor !== null;
        if (rawLimit !== null && (!/^[1-9]\d{0,2}$/.test(rawLimit) || Number(rawLimit) > 128)) return new Response(null, { status: 400 });
        if (rawCursor !== null && !FAILURE_CURSOR.test(rawCursor)) return new Response(null, { status: 400 });
        let startAfter = rawCursor ?? '';
        const limit = paginated ? Number(rawLimit ?? 128) : 128;
        for (;;) {
          const page = await project.storage.list({ prefix, startAfter, limit });
          for (const [key, record] of page) { const failure = failureRecord(key, record, paginated); if (failure) failures.push(failure); }
          const nextCursor = page.size === limit ? [...page.keys()].at(-1) : null;
          if (paginated) return Response.json({ failures, nextCursor }, { headers: { 'Cache-Control': 'no-store' } });
          if (!nextCursor) break;
          startAfter = nextCursor;
        }
        return Response.json(failures, { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) {
          console.error(JSON.stringify({ event: 'verification_failures_exception', errorClass: error?.constructor?.name ?? 'Unknown', message: redact(error?.message ?? '').slice(0, 1024), stack: redact(error?.stack ?? '').slice(0, 4096) }));
          throw error;
        }
      }
      if (url.pathname === '/router/verification-breaker' && ['GET', 'POST'].includes(request.method)) {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.resetVerificationBreaker) return new Response(null, { status: 400 });
        if (request.method === 'GET') return Response.json(await project.storage.get('verification:breaker') ?? { counts: {}, tripped: false }, { headers: { 'Cache-Control': 'no-store' } });
        if (this.router.ticking) return new Response(null, { status: 409 });
        const wasTripped = (await project.storage.get('verification:breaker'))?.tripped === true;
        const operation = project.resetVerificationBreaker({ storage: project.storage, ledger: this.router.ledger, config: project.config, hooks: project.hooks });
        this.router.ticking = operation;
        try { await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
        if (wasTripped) this.router.observeAlert?.(project.config.id, 'breaker_open', false, true);
        return new Response(null, { status: 204 });
      }
      if (url.pathname === '/router/release' && request.method === 'POST') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (project && ['on', 'drain'].includes(await project.storage.get('pool:mode'))) return new Response(null, { status: 404 });
        const id = Number(url.searchParams.get('job_id'));
        if (!project?.release || !Number.isSafeInteger(id) || id < 1) return new Response(null, { status: 400 });
        if (this.router.ticking) return new Response(null, { status: 409 });
        const operation = project.release(id, { storage: project.storage, ledger: this.router.ledger, config: project.config, hooks: project.hooks });
        this.router.ticking = operation;
        let released;
        try { released = await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
        return new Response(null, { status: released ? 204 : 409 });
      }
      return new Response(null, { status: 404 });
    }
    if (url.pathname === '/proof' && request.method === 'GET') {
      if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401, headers: { 'Cache-Control': 'no-store' } });
      const id = Number(url.searchParams.get('job_id'));
      if (!Number.isSafeInteger(id) || id <= 0) return new Response(null, { status: 400 });
      const job = await this.storage.get(`job:${id}`);
      return Response.json({ job_id: id, machine_id: job?.machineId ?? null, phase: job?.phase ?? null,
        events: await this.storage.get(`audit:${id}`) ?? [] }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/sweep' && request.method === 'POST') {
      await this.moveAppSecretsOnce();
      await this.controller.wake();
      return new Response(null, { status: 202 });
    }
    if (url.pathname === '/health' && request.method === 'GET') return Response.json(await this.controller.status());
    if (url.pathname === '/status' && request.method === 'GET') {
      if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
      return Response.json(await this.controller.status(true), { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname === '/events' && request.method === 'GET') {
      if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
      const listeners = this.controller.listeners;
      const encoder = new TextEncoder();
      let stop;
      const body = new ReadableStream({
        start(stream) {
          const send = value => { try { stream.enqueue(encoder.encode(value)); } catch { stop(); } };
          const listener = record => send(`data: ${JSON.stringify(record)}\n\n`);
          const timer = setInterval(() => send(': keepalive\n\n'), 25_000);
          stop = () => { clearInterval(timer); listeners.delete(listener); };
          listeners.add(listener);
          send('data: {"event":"connected"}\n\n');
        },
        cancel() { stop(); },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' } });
    }
    return new Response(null, { status: 404 });
  }
  // Once per Durable Object lifetime: strip the App secrets from storage when the Worker secrets hold them.
  async moveAppSecretsOnce() {
    if (this.appSecretsMoved) return;
    this.appSecretsMoved = true;
    try {
      const result = await moveAppSecrets(this.storage, this.env);
      if (result === 'moved') await this.controller.emit('alert_app_secrets_moved', null);
      else if (result.endsWith('_mismatch')) await this.controller.emit('alert_app_secrets_mismatch', null, { reason: result });
    } catch { this.appSecretsMoved = false; }
  }
  async externalRequest(request, url) {
    const headers = { 'Cache-Control': 'no-store' };
    const client = request.headers.get('X-Lease-Client');
    const config = this.external.config(client);
    const token = request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,128})$/)?.[1];
    const expected = config?.tokenHash;
    if (!token || !/^[a-f0-9]{64}$/.test(expected ?? '')) return new Response(null, { status: 401, headers });
    const actual = await hash(token); let difference = 0;
    for (let i = 0; i < 64; i++) difference |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
    if (difference) return new Response(null, { status: 401, headers });
    if (request.method !== 'POST' || Number(request.headers.get('Content-Length')) > 6_000_000) return new Response(null, { status: 400, headers });
    let body; try { const text = await request.text(); if (text.length > 6_000_000) return new Response(null, { status: 413, headers }); body = JSON.parse(text); } catch { return new Response(null, { status: 400, headers }); }
    const id = body?.id;
    if (!/^[a-f0-9-]{36}$/.test(id ?? '')) return new Response(null, { status: 400, headers });
    const action = url.pathname.slice('/router/lease/'.length);
    if (action === 'file-write' && this.router.ticking) {
      if ((this.leaseWriteWaiters ?? 0) >= 3) return new Response(null, { status: 409, headers });
      this.leaseWriteWaiters = (this.leaseWriteWaiters ?? 0) + 1;
      try {
        const deadline = Date.now() + 20_000;
        while (this.router.ticking && Date.now() < deadline) {
          const pending = this.router.ticking;
          let timer;
          try {
            await Promise.race([
              Promise.resolve(pending).catch(() => {}),
              new Promise(resolve => { timer = setTimeout(resolve, Math.max(0, deadline - Date.now())); }),
            ]);
          } finally { clearTimeout(timer); }
          if (this.router.ticking === pending) break;
        }
      } finally { this.leaseWriteWaiters--; }
    }
    if (this.router.ticking) return new Response(null, { status: 409, headers });
    const op = async () => {
      const project = this.router.projects.get(config.project);
      if (action === 'claim') {
        if (this.env.ENABLED !== 'true') return new Response(null, { status: 503, headers });
        const prior = await this.storage.get(`external-lease:${client}:${id}`);
        if (prior?.state === 'closed') return new Response(null, { status: 410, headers });
        if (body.base != null && (body.base !== 'browser-v1' || config?.seededBase !== true || this.router.account.openStartQueue !== true || body.isolation !== 'external-v2')) return new Response(null, { status: 400, headers });
        if (prior?.size && (prior.base === 'browser-v1') !== (body.base === 'browser-v1')) return new Response(null, { status: 409, headers });
        const configured = config?.seededBase === true && body.isolation === 'external-v2' && ['LEASE_BASE_SNAPSHOT_NAME','LEASE_BASE_SNAPSHOT_ID','LEASE_BASE_MANIFEST_SHA256','LEASE_BASE_PROFILE_SHA256'].some(key => this.env[key] != null);
        const selection = prior?.size ? (prior.base ? { base: prior.base, baseId: prior.baseId, routerSnapshot: prior.routerSnapshot } : null) : body.base ? await browserBase(this.env) : configured ? await leaseBase(this.env) : null;
        if ((body.base || configured) && !prior?.size && !selection) return new Response(null, { status: 503, headers });
        const lease = await this.external.claim(client, id, body.size ?? 'default', body.isolation ?? null, body.repoKey ?? null, false, selection);
        await project.storage.setAlarm(Date.now() + 10000);
        return lease ? Response.json({ id, machineId: lease.machineId, expiresAt: lease.expiresAt, ...(lease.isolation === 'external-v2' ? { isolation: lease.isolation } : {}), ...(lease.base === 'browser-v1' ? { base: lease.base } : {}) }, { headers }) : Response.json({ reason: await this.external.pendingReason(client, id, body.size ?? 'default') }, { status: 202, headers });
      }
      if (action === 'release') {
        const done = await this.external.release(client, id);
        await project.storage.setAlarm(Date.now() + 1000);
        return new Response(null, { status: done ? 204 : 202, headers });
      }
      const lease = await this.storage.get(`external-lease:${client}:${id}`);
      if (!lease || lease.state !== 'active' || lease.expiresAt <= Date.now() || lease.project !== config.project) return new Response(null, { status: 409, headers });
      if (action === 'renew') {
        const renewed = await this.external.leases.renew(client, id, config.ttlSeconds * 1000);
        return renewed ? Response.json({ expiresAt: renewed.expiresAt }, { headers }) : new Response(null, { status: 409, headers });
      }
      if (lease.fileWritePending) return new Response(null, { status: 409, headers });
      const operationApi = this.router.externalApi ? await this.router.externalApi.forIdentity(lease) : this.controller.api;
      const base = `/sandboxes/${lease.machineId}`;
      if (action === 'mirror-extend' && config?.seededBase === true && lease.isolation === 'external-v2' && lease.repoKey && body.repoKey === lease.repoKey) {
        const boxKey = `project:${lease.project}:box:${lease.machineId}`;
        const box = await this.storage.get(boxKey);
        if (box?.state !== 'leased' || box.leaseId !== id) return new Response(null, { status: 409, headers });
        const ttlSeconds = 14400;
        if ((box.machineTtlSeconds ?? 7200) >= ttlSeconds) return new Response(null, { status: 204, headers });
        await operationApi.request('boat', base, { method: 'PATCH', body: { ttlSeconds } });
        await this.storage.transaction(async tx => {
          const current = await tx.get(boxKey);
          if (current?.state === 'leased' && current.leaseId === id) await tx.put(boxKey, applyBoxEvent(current, 'lease_update', { machineTtlSeconds: ttlSeconds }, Date.now()));
        });
        return new Response(null, { status: 204, headers });
      }
      if (action === 'mirror-record' && typeof body.repoKey === 'string' && /^[a-f0-9]{64}$/.test(body.repoKey) && /^[a-f0-9]{40}$/.test(body.sha ?? '') && body.repoKey === lease.repoKey && lease.isolation === 'external-v2') {
        const boxKey = `project:${lease.project}:box:${lease.machineId}`;
        const recorded = await this.storage.transaction(async tx => {
          const box = await tx.get(boxKey), current = await tx.get(`external-lease:${client}:${id}`);
          if (box?.state !== 'leased' || box.leaseId !== id || current?.state !== 'active' || current.repoKey !== body.repoKey) return false;
          const keys = Array.isArray(box.mirrorKeys) ? box.mirrorKeys.filter(key => /^[a-f0-9]{64}$/.test(key)) : [];
          const retained = [...keys.filter(key => key !== body.repoKey), body.repoKey].slice(-16);
          const heads = Object.fromEntries(retained.map(key => [key, key === body.repoKey ? body.sha : box.mirrorHeads?.[key]]).filter(([, sha]) => /^[a-f0-9]{40}$/.test(sha ?? '')));
          await tx.put(boxKey, applyBoxEvent(box, 'lease_update', { mirrorKeys: retained, mirrorHeads: heads }, Date.now()));
          return true;
        });
        return new Response(null, { status: recorded ? 204 : 409, headers });
      }
      if (action === 'execute' && typeof body.command === 'string' && body.command.length <= 65536) {
        const result = await operationApi.request('boat', `${base}/commands`, { method: 'POST', body: { command: body.command, detached: true } });
        return Response.json(result, { headers });
      }
      if (action === 'status' && Number.isSafeInteger(body.processId) && body.processId > 0) {
        const result = await operationApi.request('boat', `${base}/commands/${body.processId}?tailBytes=65536`);
        return Response.json(result, { headers });
      }
      if (action === 'file-write' && typeof body.path === 'string' && /^\/(?:home\/user|tmp)\//.test(body.path) && typeof body.content === 'string' && body.content.length <= 5_600_000 && body.encoding === 'base64') {
        const token = crypto.randomUUID();
        const key = `external-lease:${client}:${id}`;
        const deadline = Date.now() + 150_000;
        const claimed = await this.storage.transaction(async tx => {
          const current = await tx.get(key);
          if (current?.state !== 'active' || current.expiresAt <= Date.now() || current.machineId !== lease.machineId || current.fileWritePending) return false;
          await tx.put(key, { ...current, fileWritePending: { token, deadline } });
          return true;
        });
        if (!claimed) return new Response(null, { status: 409, headers });
        await project.storage.setAlarm(Date.now() + 1000);
        return { fileWrite: { operationApi, base, token, key } };
      }
      if (action === 'file-read' && typeof body.path === 'string' && /^\/(?:home\/user|tmp)\//.test(body.path)) {
        const result = await operationApi.request('boat', `${base}/files?path=${encodeURIComponent(body.path)}&encoding=base64`);
        return Response.json(result, { headers });
      }
      if (action === 'stream' && Number.isSafeInteger(body.processId) && body.processId > 0 && Number.isSafeInteger(body.stdoutOffset) && body.stdoutOffset >= 0 && Number.isSafeInteger(body.stderrOffset) && body.stderrOffset >= 0) {
        const suffix = `${base}/commands/${body.processId}/stream?stdoutOffset=${body.stdoutOffset}&stderrOffset=${body.stderrOffset}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10_000);
        let response;
        try { response = await operationApi.fetch(`https://boat.dev/api/v1${suffix}`, { headers: { Authorization: `Bearer ${operationApi.env.BOAT_CI_API_KEY}`, 'X-Boat-Org': providerWallet(operationApi.env) }, redirect: 'manual', signal: controller.signal }); }
        finally { clearTimeout(timeout); }
        if (!response.ok) return new Response(null, { status: 503, headers });
        return new Response(response.body, { status: response.status, headers: { ...headers, 'Content-Type': 'application/x-ndjson' } });
      }
      return new Response(null, { status: 400, headers });
    };
    const operation = op(); this.router.ticking = operation;
    let result;
    try { result = await operation; } catch { return new Response(null, { status: 503, headers }); }
    finally { if (this.router.ticking === operation) this.router.ticking = null; }
    if (!result?.fileWrite) return result;
    const { operationApi, base, token: uploadToken, key } = result.fileWrite;
    try {
      const uploaded = await operationApi.request('boat', `${base}/files`, { method: 'PUT', body: { path: body.path, content: body.content, encoding: 'base64' }, timeoutMs: 120_000 });
      const cleared = await this.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.state !== 'active' || current.fileWritePending?.token !== uploadToken) return false;
        await tx.put(key, { ...current, fileWritePending: null });
        return true;
      });
      return cleared ? Response.json(uploaded, { headers }) : new Response(null, { status: 409, headers });
    } catch {
      await this.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.state === 'active' && current.fileWritePending?.token === uploadToken) await tx.put(key, { ...current, fileWritePending: { ...current.fileWritePending, failed: true } });
      });
      await this.router.projects.get(config.project).storage.setAlarm(Date.now() + 1000);
      return new Response(null, { status: 503, headers });
    }
  }
  alarm() { return this.repoWebhookInbox ? this.repoWebhookInbox.alarm() : this.router ? this.router.tick() : this.controller.tick(); }
}
