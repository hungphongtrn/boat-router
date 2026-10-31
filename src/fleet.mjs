import { smokeRepository } from '../config/policy.mjs';
import { FleetBase } from './router/fleet-base.mjs';
import { BUILD_COMMIT } from './build.mjs';
import { installRouter } from './router/install.mjs';
import { SetupController, authorizedControl, authorizedLocal, hash } from './setup.mjs';
import { webhook } from './webhook.mjs';
import { APIs } from './apis.mjs';
import { ApiError, backoff, isPlanRefusal, isSizeRefusal, reservationId, runnerName, jobRunnerName, REPOSITORIES } from './domain.mjs';

const terminal = job => ['done', 'attention'].includes(job.phase);
const stoppedPoll = 10 * 60_000;
const createReconcileWindow = 5 * 60_000;

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
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;
    const api = new APIs(env, fetch, Date.now, () => ctx.storage.get('github-app'));
    this.controller = new FleetController(ctx.storage, env, api);
    this.setup = new SetupController(ctx.storage, env, api, Date.now, event => this.controller.emit(event, null));
    this.router = env.PLUGIN_ROUTER === 'true' ? installRouter(ctx.storage, () => this.env, { api, waitUntil: promise => ctx.waitUntil(promise) }) : null;
  }
  async fetch(request) {
    this.env = { ...this.env, ENABLED: request.headers.get('X-Boat-CI-Enabled') === 'true' ? 'true' : 'false' };
    this.controller.env = this.setup.env = this.env;
    const url = new URL(request.url);
    if (url.pathname.startsWith('/setup')) return this.setup.fetch(request);
    if (url.pathname === '/webhook' && request.method === 'POST') {
      const app = await this.storage.get('github-app');
      if (this.router) return webhook(request, this.env, app?.webhookSecret ?? this.env.GITHUB_WEBHOOK_SECRET, selection => this.router.ingest(selection), (n, p) => this.router.select(n, p));
      return webhook(request, this.env, app?.webhookSecret ?? this.env.GITHUB_WEBHOOK_SECRET, event => this.controller.ingest(event));
    }
    if (this.router) {
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
            await tx.put(`project:${id}:reuse:override`, 'off');
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
        return Response.json({ pools, snapshot: await project.storage.get('pool:snapshot') ?? null }, { headers: { 'Cache-Control': 'no-store' } });
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
      if (url.pathname === '/sweep' && request.method === 'POST') { await this.router.tick(); return new Response(null, { status: 202 }); }
      if (url.pathname === '/health' && request.method === 'GET') return Response.json({ mode: 'router', account: this.router.account.id });
      if (claimerPath === '/router/local/claim' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env) && !await authorizedLocal(request, this.env)) return new Response(null, { status: 401 });
        if (![...this.router.projects.values()].some(project => project.local && (project.config.externalClaimer ?? project.config.localFirst)?.enabled === true)) return new Response(null, { status: 404 });
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      }
      if (['/router/local/claim', '/router/local/release', '/router/local/started', '/router/local/operator-release'].includes(claimerPath) && request.method === 'POST') {
        if (!await authorizedControl(request, this.env) && (url.pathname.endsWith('/operator-release') || !await authorizedLocal(request, this.env))) return new Response(null, { status: 401 });
        if (Number(request.headers.get('Content-Length')) > 4096) return new Response(null, { status: 413 });
        let body;
        try { const raw = await request.text(); if (raw.length > 4096) return new Response(null, { status: 413 }); body = JSON.parse(raw); } catch { return new Response(null, { status: 400 }); }
        const project = this.router.projects.get(body?.project);
        if (!project?.local || (project.config.externalClaimer ?? project.config.localFirst)?.enabled !== true) return new Response(null, { status: 404 });
        const local = project.local({ storage: project.storage, ledger: this.router.ledger, config: project.config, hooks: project.hooks });
        if (!local) return new Response(null, { status: 404 });
        if (url.pathname.endsWith('/claim') && (!Array.isArray(body.labels) || body.labels.length !== 1 || typeof body.labels[0] !== 'string')) return new Response(null, { status: 400 });
        if (!url.pathname.endsWith('/claim') && (typeof body.name !== 'string' || !/^local-[a-f0-9-]{36}$/.test(body.name))) return new Response(null, { status: 400 });
        if (this.router.ticking) return new Response(null, { status: 409 });
        const operation = url.pathname.endsWith('/claim') ? local.claim(body.labels[0]) : (url.pathname.endsWith('/release') || url.pathname.endsWith('/operator-release')) ? local.release(body.name) : local.started(body.name);
        this.router.ticking = operation;
        try {
          const result = await operation;
          if (!result) return new Response(null, { status: url.pathname.endsWith('/claim') ? 204 : 409, headers: { 'Cache-Control': 'no-store' } });
          return url.pathname.endsWith('/claim') ? Response.json(result, { headers: { 'Cache-Control': 'no-store' } }) : new Response(null, { status: 204 });
        } catch { return new Response(null, { status: 503 }); }
        finally { if (this.router.ticking === operation) this.router.ticking = null; }
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
      if (url.pathname === '/router/claims' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const ledger = await this.storage.get(this.router.ledger.key);
        return Response.json({ claims: ledger?.claims ?? {}, waiting: ledger?.waiting ?? [], poolPacing: ledger?.poolPacing ?? null }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/balancer' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const projects = {};
        for (const [id, project] of this.router.projects) projects[id] = await project.storage.get('balancer:decisions') ?? [];
        return Response.json({ enabled: this.router.account.balancer?.enabled === true, projects }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/status' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        const id = Number(url.searchParams.get('job_id'));
        if (!project || !Number.isSafeInteger(id) || id < 1) return new Response(null, { status: 400 });
        if (['on', 'drain'].includes(await project.storage.get('pool:mode'))) {
          const job = await project.storage.get(`gh-job:${id}`);
          if (!job) return new Response(null, { status: 404 });
          const owner = job.runnerName ? await project.storage.get(`runner:${job.runnerName}`) : null;
          const box = owner?.machineId ? await project.storage.get(`box:${owner.machineId}`) : null;
          const label = JSON.parse(job.pool)[1], pool = await project.storage.get(`pool:status:${label}`);
          return Response.json({ job, box, pool }, { headers: { 'Cache-Control': 'no-store' } });
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
          if (this.router.ticking) return new Response(null, { status: 409 });
          const operation = project.storage.put('reuse:override', mode);
          this.router.ticking = operation;
          try { await operation; } finally { if (this.router.ticking === operation) this.router.ticking = null; }
          this.router.observeAlert?.(project.config.id, 'reuse_off', mode === 'off');
        }
        const override = await project.storage.get('reuse:override') ?? 'config';
        return Response.json({ override, enabled: override !== 'off' && this.router.account.reuse?.enabled === true && project.config.reuse?.mode === 'on' && project.config.dockerAccess !== true }, { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/verification-outcomes' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.resetVerificationBreaker) return new Response(null, { status: 400 });
        return Response.json(await project.storage.get('verification:reset-outcomes') ?? [], { headers: { 'Cache-Control': 'no-store' } });
      }
      if (url.pathname === '/router/verification-failures' && request.method === 'GET') {
        if (!await authorizedControl(request, this.env)) return new Response(null, { status: 401 });
        const project = this.router.projects.get(url.searchParams.get('project'));
        if (!project?.resetVerificationBreaker) return new Response(null, { status: 400 });
        const prefix = 'verification:attempt:failure:', failures = [];
        let startAfter = '';
        for (;;) {
          const page = await project.storage.list({ prefix, startAfter, limit: 128 });
          for (const [key, record] of page) {
            const match = /^verification:attempt:failure:(.+):(\d+)$/.exec(key);
            if (match) failures.push({ kind: record.kind ?? null, phase: record.phase ?? null, boxId: match[1], generation: Number(match[2]), at: record.at ?? null, message: record.message ?? null });
          }
          if (page.size < 128) break;
          startAfter = [...page.keys()].at(-1);
        }
        return Response.json(failures, { headers: { 'Cache-Control': 'no-store' } });
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
  alarm() { return this.router ? this.router.tick() : this.controller.tick(); }
}
