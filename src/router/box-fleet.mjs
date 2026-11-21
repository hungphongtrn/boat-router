import { runnableDemand, matchesWorkflowRule } from './workflow-demand.mjs';
import { plan, poolKey, poolSize, supplyCounts, uncovered, localOfferActive } from './pool.mjs';
import { records } from './pool-records.mjs';
import { registrationRejected, rejectedRegistrationAbsent } from './registration-recovery.mjs';
import { observeRouterStall } from './stall-alarm.mjs';
import { isPlanRefusal, isSizeRefusal } from '../domain.mjs';
import { prunePool, RETENTION } from './pool-prune.mjs';
import { waitClaims } from './wait-for-busy.mjs';
import { reusePacing, reuseHold, nominalReuseHold, paidIdleHold } from './reuse-pacing.mjs';
import { currentBreaker, breakerCanProbe, breakerForSize, reserveSizedProbe, releaseSizedProbe, releaseSizedProbeInTransaction, recordSizedBreakerOutcome, BREAKER_PROBE_DELAY_MS } from './verification-breaker.mjs';
import { MACHINE_SIZES } from './sizes.mjs';
import { SetupWatchdog } from './setup-watchdog.mjs';
import { LOCAL_MODE_KEY, labelLocal, localJobAllowed } from './local-fleet.mjs';
import { LANES_SWITCH_KEY, laneRules, laneComparator, laneRank, laneUsage, laneRoom, reservedByLane, lanePriorityOf, createYieldsTo, laneLending, borrowedSlots } from './lanes.mjs';
import { transition as applyBoxEvent, applyTransition, boxDeadline, reservationActive, reservationExpired, MISSING_RESULT_GRACE_MS, RUNNER_GONE_GRACE_MS } from './box-state.mjs';
export { boxDeadline } from './box-state.mjs';

// local-first for a pool label whose runtime local switch is on. The local
// agent reports its capacity every 15 s; with a fresh report and a free slot, a job
// first seen queued at t is offered to the minis until t + offerSeconds before a
// Boat box is created for it, and a reset box stays `ready` while no offer has aged.
export const LOCAL_OFFER_KEY = 'local:offer-seen';
export function localRoom(capacity, now) {
  return Boolean(capacity) && Number.isFinite(capacity.at) && now - capacity.at >= 0 && now - capacity.at <= 60_000 && Number.isSafeInteger(capacity.active) && Number.isSafeInteger(capacity.maxConcurrent) && capacity.active < capacity.maxConcurrent;
}
import { DOCKER_RESET_MAX_GENERATION } from './docker-reset.mjs';

// Health check mode. 'auto' enforces only while the account can replace a retired box: at least
// `healthEnforceMinStarts` (default 20) day starts left, credit above zero and starts allowed. Any unknown limit
// reading keeps boxes (observe). One provider read per API object every 30 s.
const healthLimitCache = new WeakMap();
export function healthGateFromLimits(limits, minStarts = 20) {
  const remaining = limits?.starts?.day?.remaining, credit = limits?.creditBalanceHours;
  return Number.isSafeInteger(remaining) && remaining >= minStarts && Number.isFinite(credit) && credit > 0 && limits?.canStart === true;
}
// 'enforce' retires a box that fails its health check; 'auto' does so only while the account can replace the
// box, and every other mode only observes. The same window governs a reused box: with the day's starts used
// up, a slow host is kept and handed out last instead of burning a paid start to replace it (2026-11-20,
// bx_u2wnajhs was retired by health_check while the day window was empty).
export function reuseHealthMode(account, limits) {
  const mode = account?.reuse?.healthCheck;
  if (mode === 'enforce') return 'enforce';
  if (mode !== 'auto') return 'observe';
  return healthGateFromLimits(limits, account.reuse?.healthEnforceMinStarts ?? 20) ? 'enforce' : 'observe';
}
export async function effectiveHealthMode(account, api, now) {
  const mode = account?.reuse?.healthCheck;
  if (mode === 'enforce' || mode !== 'auto') return reuseHealthMode(account);
  if (typeof api?.limits !== 'function') return 'observe';
  let entry = healthLimitCache.get(api);
  if (!entry || now - entry.at > 30_000 || entry.at > now) {
    let limits = null;
    try { limits = await api.limits(); } catch { limits = null; }
    entry = { at: now, limits }; healthLimitCache.set(api, entry);
  }
  return reuseHealthMode(account, entry.limits);
}
// A slow box is handed out last: it yields while a healthy box of the same pool is ready and
// unreserved. For a large box it also yields for 60 s to a healthy box that is resetting or finishing its
// baseline, so a large test shard does not land on a slow disk when a healthy box is about to be free.
export function slowBoxYields(box, job, boxes, now) {
  // Both waits are bounded by the job's queue age, so a slow box still serves a job nobody else takes.
  const healthy = boxes.filter(other => other.machineId !== box.machineId && other.pool === box.pool && other.slowHost !== true);
  const queuedFor = Number.isFinite(job?.queuedAt) ? now - job.queuedAt : Infinity;
  if (queuedFor < 120_000 && healthy.some(other => other.state === 'ready' && !reservationActive(other, now))) return true;
  return box.size === 'large' && queuedFor < 60_000 && healthy.some(other => ['resetting', 'baseline'].includes(other.state));
}
const healthFields = health => health ? { slowHost: health.measured === true && health.slow === true, ...(health.cpu ? { hostCpu: health.cpu } : {}) } : {};

export const DOCKER_REUSE_KEY = 'reuse:docker-labels';

// Which reset a new box of this label gets, or null for one job per box.
// Docker labels reuse only with the in-box Docker reset and only while
// the per-label switch is on; the switch is off by default and is the rollback.
export function labelReuse(project, account, override, label, dockerSwitches = {}) {
  if (account?.reuse?.enabled !== true || project?.reuse?.mode !== 'on' || override === 'off') return null;
  if (project.dockerAccess !== true) return 'light';
  if (project.reuse?.docker !== true || dockerSwitches?.[label] !== 'on') return null;
  return 'docker';
}
const poolLabel = pool => { try { return JSON.parse(pool)[1]; } catch { return null; } };

const sameOrigin = (pool, repo) => { try { return JSON.parse(pool)[0] === repo; } catch { return false; } };

export function largerDemandExpected(jobs, project, size, now) {
  const rank = MACHINE_SIZES.indexOf(size);
  if (rank < 0) return true;
  return jobs.some(job => {
    try {
      const [repo, label] = JSON.parse(job.pool);
      const jobRank = MACHINE_SIZES.indexOf(poolSize(project, label));
      return repo === project.repo && jobRank >= rank &&
        (job.status === 'queued' || (Number.isFinite(job.queuedAt) && job.queuedAt <= now && now - job.queuedAt < 60_000));
    } catch { return true; }
  });
}

const limited = error => error?.service === 'boat' && (error.status === 429 || ['trial_compute_limit_reached', 'quota_exceeded', 'limit_exceeded', 'rate_limited'].includes(String(error.code?.code ?? error.code?.type ?? error.code ?? '').toLowerCase()));
// What a provider failure says, for the log and the stored last-error: a create that fails here is
// otherwise only visible as "a create did not happen", which names no cause.
const failureDetail = error => ({ status: error?.status ?? null, code: String(error?.code?.code ?? error?.code?.type ?? error?.code ?? '') || null, retry_s: Number.isFinite(error?.retrySeconds) ? error.retrySeconds : null });

export function placementEvidence(capacity, now, enabled = true) {
  if (!enabled) return { reason: 'project_disabled', categories: [], capacity: null };
  if (!capacity || !Number.isFinite(capacity.at) || now - capacity.at < 0 || now - capacity.at > 30000) return { reason: 'no_recent_agent_report', categories: [], capacity: null };
  const reasons = capacity.reasons ?? {}, groups = {
    agent_capacity: ['agent_capacity'], per_mini_slots: ['per_mini_slots'], container_memory: ['container_memory', 'memory_or_slots'],
    lease_load: ['no_idle_mini'], cooldown: ['cooldown'], probe: ['probe', 'timeout', 'claim_timeout'], probe_or_lease: ['lease_or_probe'], browser_git_copy: ['lease_browser_git_copy'], lease_exit_98: ['lease_launch_exit_98'],
  };
  const categories = Object.entries(groups).filter(([, keys]) => keys.some(key => reasons[key] > 0)).map(([name]) => name);
  const reason = capacity.offers > 0 ? 'no_claim_in_time' : categories.length === 1 ? categories[0] : categories.length > 1 ? 'multiple_admission_limits' : 'no_claim_in_time';
  return { reason, categories, capacity };
}

export class BoxFleet {
  constructor(storage, api, now = Date.now, options = {}) { Object.assign(this, { storage, api, now, ...options }); }

  // Direct suites lease a box themselves. No GitHub runner is registered.
  async acquireDirect(pool, runId, excluded = []) {
    if (!pool || !runId) throw new TypeError('pool and run id required');
    if (!Array.isArray(excluded)) throw new TypeError('excluded machine ids must be an array');
    const prior = await this.storage.get(`direct:lease:${runId}`);
    if (prior) {
      const box = await this.storage.get(`box:${prior}`);
      if (!box || box.pool !== pool || box.state !== 'busy' || box.executor !== 'direct' || box.lease !== runId) throw new Error('direct lease identity mismatch');
      return box;
    }
    const candidates = (await records(this.storage, 'box:')).filter(box => box.pool === pool && box.state === 'idle' && box.executor === 'direct' && !excluded.includes(box.machineId)).sort((a, b) => a.since - b.since || a.machineId.localeCompare(b.machineId));
    for (const candidate of candidates) {
      const leased = await this.storage.transaction(async tx => {
        const existingId = await tx.get(`direct:lease:${runId}`);
        if (existingId) {
          const existing = await tx.get(`box:${existingId}`);
          if (!existing || existing.pool !== pool || existing.state !== 'busy' || existing.executor !== 'direct' || existing.lease !== runId) throw new Error('direct lease identity mismatch');
          return existing;
        }
        const key = `box:${candidate.machineId}`, box = await tx.get(key);
        if (!box || box.pool !== pool || box.state !== 'idle' || box.executor !== 'direct') return null;
        const next = applyBoxEvent(box, 'direct_lease', { lease: runId }, this.now());
        await tx.put(key, next);
        await tx.put(`direct:lease:${runId}`, candidate.machineId);
        return next;
      });
      if (leased) return leased;
    }
    return null;
  }

  async releaseDirect(machineId, runId) {
    return this.storage.transaction(async tx => {
      const key = `box:${machineId}`, box = await tx.get(key);
      if (!box || box.executor !== 'direct' || box.state !== 'busy' || box.lease !== runId) return false;
      await tx.put(key, applyBoxEvent(box, 'direct_release', { lease: null, lastLease: runId, runnerFenced: true, jobs: (box.jobs ?? 0) + 1 }, this.now()));
      if (await tx.get(`direct:lease:${runId}`) === machineId) await tx.delete(`direct:lease:${runId}`);
      return true;
    });
  }

  preview(input) {
    const decisions = plan(input);
    const deadlines = input.units.filter(unit => unit.machineId && !unit.busy && (input.complete || unit.state !== 'idle')).map(unit => ({ machineId: unit.machineId, state: unit.state, action: boxDeadline(unit, input.now) })).filter(unit => unit.action);
    const retire = [];
    if (input.complete) for (const pool of input.pools) {
      const pending = input.units.filter(unit => unit.pool === pool.key && unit.kind === 'create' && unit.state === 'pending').length;
      let surplus = Math.max(0, decisions[pool.key].surplus - pending);
      const idle = input.units.filter(unit => unit.pool === pool.key && unit.machineId && unit.state === 'idle' && !unit.busy).sort((a, b) => a.since - b.since);
      for (const unit of idle) {
        const hold = unit.reusable ? (input.idleHoldSeconds ?? 120) : 120;
        if (!surplus || !Number.isFinite(unit.onlineAt ?? unit.since) || input.now - (unit.onlineAt ?? unit.since) < hold * 1000) continue;
        retire.push({ pool: pool.key, machineId: unit.machineId, observedBusy: unit.busy === true });
        surplus--;
      }
    }
    return { plan: decisions, deadlines, retire };
  }

  async prepare(pool, size, count, queuedAt, reusable = false, options = {}) {
    const laneFields = { ...(options.lane ? { lane: options.lane, lanePriority: options.lanePriority ?? null } : {}), ...(options.orderJobId !== undefined ? { orderJobId: options.orderJobId } : {}), ...(Number.isSafeInteger(options.orderRunId) ? { orderRunId: options.orderRunId } : {}), ...(options.orderSource === 'webhook' ? { orderSource: 'webhook' } : {}) };
    if (!this.budget || !Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid admission');
    if (options.executor && (options.executor !== 'direct' || options.prefix !== 'direct-' || typeof options.golden !== 'string' || !options.golden)) throw new TypeError('invalid direct executor');
    if (options.resetMode !== undefined && (options.resetMode !== 'docker' || !reusable)) throw new TypeError('invalid reset mode');
    const created = [];
    for (let i = 0; i < count; i++) {
      const createKey = crypto.randomUUID();
      const routerCreateName = `${options.executor === 'direct' ? options.prefix : 'boat-router-'}${(await this.budget.claimKey(createKey)).slice(0, 32)}`;
      const record = { pool, size, createKey, routerCreateName, state: 'pending', at: this.now(), queuedAt, reusable, ...laneFields, ...(options.resetMode ? { resetMode: options.resetMode } : {}), ...(this.createAccount ? { account: this.createAccount } : {}), ...(options.executor ? { executor: options.executor, golden: options.golden } : {}) };
      await this.storage.put(`create:${createKey}`, record);
      await this.budget.enqueue(createKey, queuedAt, undefined, { pool: true });
      created.push(record);
    }
    return created;
  }

  async discardCreate(createKey) {
    const item = await this.storage.get(`create:${createKey}`);
    await this.storage.delete(`create:${createKey}`);
    if (item?.size) await releaseSizedProbe(this.storage, item.size, createKey);
  }

  async finishSnapshotFallback(record, afterStart = null) {
    const claim = await this.budget.claim(record.createKey);
    if (claim?.status === 'created') return false;
    await afterStart?.(record, 'not_created');
    if (claim && !await this.budget.settle(record.createKey, 'not_created')) return false;
    const { routerSnapshot, fallbackKey, fallbackName, callingAt, provisionerFingerprint, ...rest } = record;
    const next = { ...rest, createKey: fallbackKey, routerCreateName: fallbackName, state: 'pending', bootPath: 'plain_fallback', fallbackOf: record.createKey, at: this.now() };
    const saved = await this.storage.transaction(async tx => {
      const current = await tx.get(`create:${record.createKey}`);
      if (current?.state !== 'snapshot_missing' || current.fallbackKey !== fallbackKey) return false;
      await releaseSizedProbeInTransaction(tx, record.size, record.createKey);
      await tx.put(`create:${fallbackKey}`, next);
      await tx.delete(`create:${record.createKey}`);
      return true;
    });
    if (saved) await this.budget.enqueue(fallbackKey, next.queuedAt, next.snapshotRecoveryJobId, { pool: true, snapshotRecovery: Boolean(next.snapshotRecoveryJobId) });
    return saved;
  }

  async admit(createKey, limits, ttl, epoch = '0', beforeStart = null, afterStart = null) {
    const key = `create:${createKey}`;
    let record = await this.storage.get(key);
    if (!record) return false;
    if (record.state === 'snapshot_missing') return this.finishSnapshotFallback(record, afterStart);
    if (record.fallbackAfterMachineId && (await this.storage.get(`box:${record.fallbackAfterMachineId}`))?.state !== 'deleted') return false;
    let claim = await this.budget.claim(createKey);
    if ((!claim || claim.status === 'pending') && !await reserveSizedProbe(this.storage, record.size, createKey, this.now())) return false;
    if (!claim) {
      const result = await this.budget.admit(createKey, limits, { queuedAt: record.queuedAt, jobId: record.snapshotRecoveryJobId, pool: true, snapshotRecovery: Boolean(record.snapshotRecoveryJobId) });
      if (!result.ok) {
        this.logger?.(JSON.stringify({ event: 'admission_refused', project: this.project?.id, reason: result.reason ?? 'refused' }));
        const label = JSON.parse(record.pool)[1], statusKey = `pool:status:${label}`, status = await this.storage.get(statusKey);
        if (status) await this.storage.put(statusKey, { ...status, reason: `ledger:${result.reason ?? 'refused'}` });
        return false;
      }
      claim = await this.budget.claim(createKey);
      this.logger?.(JSON.stringify({ event: 'create_claim', project: this.project?.id, size: record.size, status: claim?.status ?? 'missing' }));
    }
    let sandbox, createMs;
    if (claim?.status !== 'pending') {
      sandbox = await this.api.findCreated(record);
      if (!sandbox) {
        if (claim?.status !== 'created' && this.now() - (claim?.callingAt ?? record.at) >= 300_000) {
          if (await this.budget.settle(createKey, 'not_created')) { await afterStart?.(record, 'not_created'); await this.discardCreate(createKey); }
        }
        return false;
      }
    } else {
      if (beforeStart) {
        let allowed;
        try { allowed = await beforeStart(record, limits); }
        catch (error) { await this.budget.cancelPending(createKey); throw error; }
        if (!allowed) {
          // The provider call has not begun, so this claim is refundable.
          await this.budget.cancelPending(createKey);
          return false;
        }
      }
      if (!await reserveSizedProbe(this.storage, record.size, createKey, this.now())) return false;
      if (!record.bootPath) {
        const env = this.getEnv?.() ?? {};
        // Snapshots live in one Boat account each: a secondary box uses only the secondary copy, else it boots plain.
        const account = record.account ?? this.createAccount ?? env.BOAT_WALLET;
        const eligible = this.project?.snapshotBoot === true && (account === 'primary' || account === 'secondary' || account === env.BOAT_WALLET) && !record.executor && record.resetMode !== 'docker' && this.project?.dockerAccess !== true;
        const suffix = account === 'secondary' ? '_SECONDARY' : '';
        const name = eligible ? env[`PROJECT_SNAPSHOT_NAME${suffix}`] : undefined;
        const manifestSha256 = eligible ? env[`PROJECT_SNAPSHOT_MANIFEST_SHA256${suffix}`] : undefined;
        if ((name || manifestSha256) && (!/^[a-z][a-z0-9-]{0,40}-\d{8}-[a-f0-9]{8,64}$/.test(name ?? '') || !/^[a-f0-9]{64}$/.test(manifestSha256 ?? ''))) throw new TypeError('invalid project snapshot configuration');
        record = { ...record, bootPath: name ? 'snapshot' : 'plain', ...(name ? { routerSnapshot: { name, manifestSha256 } } : {}) };
        await this.storage.put(key, record);
      }
      if (!await this.budget.begin(createKey)) return false;
      const fingerprint = record.resetMode === 'docker' ? this.project?.dockerProvisionerFingerprint : this.project?.provisionerFingerprint;
      record = { ...record, state: 'calling', callingAt: this.now(), machineTtlSeconds: ttl, ...(fingerprint ? { provisionerFingerprint: fingerprint } : {}) };
      await this.storage.put(key, record);
      try {
        const started = this.now();
        const result = await this.api.create({ ...record, machineSize: record.size, routerReusable: record.reusable, ...(record.resetMode ? { routerResetMode: record.resetMode } : {}), ...(record.executor !== 'direct' && this.project?.dockerAccess === true ? { routerDockerAccess: true } : {}) }, ttl);
        createMs = this.now() - started;
        sandbox = result?.sandbox;
        if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox?.id ?? '')) throw new Error('invalid sandbox');
      } catch (error) {
        if (record.bootPath === 'snapshot' && error?.service === 'boat' && error.status === 404 && error.code === 'snapshot_not_found') {
          const fallbackKey = crypto.randomUUID();
          const fallbackName = `boat-router-${(await this.budget.claimKey(fallbackKey)).slice(0, 32)}`;
          record = { ...record, state: 'snapshot_missing', fallbackKey, fallbackName };
          await this.storage.put(key, record);
          await this.finishSnapshotFallback(record, afterStart);
          return false;
        }
        // a refusal by the secondary account parks that account only. The project keeps its
        // primary starts, and no create-failure alert fires for an unfunded or full second account.
        const accountRefusal = record.account === 'secondary' && typeof this.budget.blockAccount === 'function' && error?.service === 'boat' && (limited(error) || isPlanRefusal(error) || isSizeRefusal(error));
        if (accountRefusal) {
          const delay = limited(error) ? Math.max(30_000, Math.min(900_000, (error.retrySeconds ?? 0) * 1000)) : 900_000;
          await this.budget.blockAccount('secondary', isPlanRefusal(error) ? 'plan' : limited(error) ? 'limited' : 'size', delay);
          this.logger?.(JSON.stringify({ event: 'account_refused', project: this.project?.id, account: 'secondary', status: error.status ?? null }));
          if (await this.budget.settle(createKey, 'not_created')) { await afterStart?.(record, 'not_created'); await this.discardCreate(createKey); }
          return false;
        }
        const detail = failureDetail(error);
        this.logger?.(JSON.stringify({ event: 'create_failed', project: this.project?.id, size: record.size, boot: record.bootPath ?? null, ...detail }));
        // The pool tick's log does not reach the unit's journal, so the stored last-error is where a
        // failed create names its cause.
        await this.storage.put('pool:last-error', { at: this.now(), stage: 'create', createKey, ...detail });
        if (!limited(error)) this.alert?.('create_failures', { value: 1, limit: 1, active: true });
        if (limited(error) || (error?.service === 'boat' && error.status === 503)) {
          const delay = Math.max(30_000, Math.min(900_000, (error.retrySeconds ?? 0) * 1000));
          await this.storage.put('startBackoffUntil', this.now() + delay);
        }
        if (error && isSizeRefusal(error)) await this.storage.put(`size-block:${record.size}`, { epoch, at: this.now(), status: error.status });
        if (error && !limited(error) && isPlanRefusal(error)) await this.storage.put('blocked', { epoch, at: this.now(), status: error.status });
        const refused = error?.service === 'boat' && (limited(error) || (error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status)) || error.code === 'request_not_sent');
        if (refused && await this.budget.settle(createKey, 'not_created')) { await afterStart?.(record, 'not_created'); await this.discardCreate(createKey); }
        else { await this.budget.settle(createKey, 'unknown'); await this.storage.put(key, { ...record, state: 'unknown' }); }
        return false;
      }
    }
    if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox?.id ?? '')) throw new Error('invalid sandbox');
    await afterStart?.(record, 'created');
    this.alert?.('create_failures', { value: 0, limit: 1, active: false });
    if (!await this.budget.settle(createKey, 'created')) return false;
    this.logger?.(JSON.stringify({ event: 'create', project: this.project?.id, machine_id: sandbox.id, size: record.size, job_id: record.orderJobId, run_id: record.orderRunId, source: record.orderSource, create_ms: createMs }));
    return this.storage.transaction(async tx => {
      const current = await tx.get(key);
      if (!current) return false;
      const boxKey = `box:${sandbox.id}`;
      const existing = await tx.get(boxKey);
      if (existing && existing.createKey !== createKey) throw new Error('machine identity conflict');
      if (!existing) await tx.put(boxKey, applyBoxEvent(null, 'admit', { machineId: sandbox.id, ...(current.account ? { account: current.account } : {}), pool: current.pool, originPool: current.pool, size: current.size, createKey, bootPath: current.bootPath ?? 'plain', ...(current.routerSnapshot ? { routerSnapshot: current.routerSnapshot } : {}), since: current.callingAt ?? current.at, createdAt: current.callingAt ?? current.at, queuedAt: current.queuedAt, ...(current.lane ? { lane: current.lane } : {}), setupRetry: current.setupRetry === true, generation: 0, reusable: current.reusable, ...(current.resetMode ? { resetMode: current.resetMode } : {}), jobs: 0, ...(Number.isFinite(current.machineTtlSeconds) ? { machineTtlSeconds: current.machineTtlSeconds } : {}), ...(current.provisionerFingerprint ? { provisionerFingerprint: current.provisionerFingerprint } : {}), ...(current.executor ? { executor: current.executor, golden: current.golden } : {}) }, this.now()));
      await tx.delete(key);
      return true;
    });
  }

  async pendingLeaseStarts() {
    return this.countLeaseStarts ? await this.countLeaseStarts() : 0;
  }

  async admissionEntries() {
    const entries = await records(this.storage, 'create:');
    const lanesOn = await this.lanesEnabled(this.project);
    const ranked = await Promise.all(entries.map(async item => ({ key: item.createKey, at: item.queuedAt, lane: lanesOn ? laneRank(item, this.now()) : 0, rank: this.budget.claimKey ? await this.budget.claimKey(item.createKey) : item.createKey, pending: item.state === 'pending' })));
    const cap = this.project?.caps?.concurrent;
    if (!Number.isSafeInteger(cap) || cap < 0) return ranked;
    const boxes = await records(this.storage, 'box:');
    const room = Math.max(0, cap - boxes.filter(box => box.state !== 'deleted').length - entries.filter(item => item.state !== 'pending').length - await this.pendingLeaseStarts());
    return [...ranked.filter(item => !item.pending), ...ranked.filter(item => item.pending).sort((a, b) => a.lane - b.lane || a.at - b.at || a.rank.localeCompare(b.rank)).slice(0, room)];
  }

  async admitQueued(key, { mode, env = {}, project = this.project, preparationFailed = false, beforeStart = null, afterStart = null }) {
    let item = await this.storage.get(`create:${key}`);
    if (!item) return;
    if (item.state === 'snapshot_missing') return this.finishSnapshotFallback(item, afterStart);
    if (item.accountReconciliationMissing) return;
    let claim = await this.budget.claim(key); const uncertain = claim && claim.status !== 'pending';
    const epoch = env.RESUME_EPOCH ?? '0';
    const status = await this.storage.get(`pool:status:${JSON.parse(item.pool)[1]}`);
    const snapshot = await this.storage.get('pool:snapshot'), breaker = breakerForSize(await currentBreaker(this.storage, this.now()), item.size);
    const label = JSON.parse(item.pool)[1], claimer = project.externalClaimer ?? project.localFirst;
    const localOnly = claimer?.localOnly?.includes(label);
    const probeAllowed = breakerCanProbe(breaker, this.now()) || breaker?.probe?.createKey === key;
    let recoveryVerified = false;
    if (!uncertain && !snapshot?.complete && item.snapshotRecoveryJobId) {
      const job = await this.storage.get(`gh-job:${item.snapshotRecoveryJobId}`);
      if (!job || job.status !== 'queued' || job.source !== 'webhook' || job.missing || job.pool !== item.pool) {
        const cancelled = claim?.status === 'pending' ? await this.budget.cancelPending(key) : (await this.budget.abandon(key) || !await this.budget.claim(key));
        if (cancelled) await this.discardCreate(key);
        return;
      }
      if (job?.status === 'queued' && job.source === 'webhook' && !job.missing && job.pool === item.pool && this.installation) {
        try {
          const actual = await this.api.getJob({ repo: project.repo, installation: this.installation, id: job.id }, job.id);
          const current = await this.storage.get(`gh-job:${job.id}`);
          if (actual?.id === job.id && (actual.status !== 'queued' || actual.runner_name)) {
            const cancelled = claim?.status === 'pending' ? await this.budget.cancelPending(key) : (await this.budget.abandon(key) || !await this.budget.claim(key));
            if (cancelled) await this.discardCreate(key);
            return;
          }
          if (actual?.id === job.id && actual.status === 'queued' && !actual.runner_name && current?.status === 'queued' && current.source === 'webhook' && current.observedAt === job.observedAt) {
            const hash = await this.budget.claimKey(key);
            await this.storage.put(`snapshot-recovery-proof:${hash}`, { jobId: job.id, createKey: key, until: this.now() + 15_000 });
            recoveryVerified = true;
          }
        } catch { /* Remain queued until GitHub confirms the individual job. */ }
      }
    }
    const statusReason = status?.reason && !status.reason.startsWith('ledger:') && status.reason !== 'breaker' && status.reason !== 'local_capacity' && !(recoveryVerified && status.reason === 'snapshot_incomplete') ? status.reason : null;
    const reason = localOnly ? 'local_only' : mode !== 'on' ? 'pool_off' : env.ENABLED !== 'true' ? 'disabled' : preparationFailed ? 'preparation_failed' : statusReason ?? (!snapshot?.complete && !recoveryVerified ? 'snapshot_incomplete' : breaker?.tripped && !probeAllowed ? 'breaker' : (await this.storage.get('startBackoffUntil')) > this.now() ? 'backoff' : (await this.storage.get('blocked'))?.epoch === epoch ? 'blocked' : (await this.storage.get(`size-block:${item.size}`))?.epoch === epoch ? 'size_block' : null);
    if (!uncertain && reason) { this.logger?.(JSON.stringify({ event: 'admission_refused', project: this.project?.id, reason })); await this.budget.abandon?.(key); return; }
    if (!uncertain && await this.concurrentCapReached(project)) return;
    try {
      if (!uncertain && this.budget.selectAccount) {
        if (!await this.budget.selectAccount(key, item.size)) return;
        item = await this.storage.get(`create:${key}`);
        claim = await this.budget.claim(key);
      }
      const selectedApi = this.api.forIdentity ? await this.api.forIdentity(item) : this.api;
      const limits = uncertain ? {} : await selectedApi.limits();
      if (!uncertain && (!limits.canStart || !limits.machineTypes?.some(type => type.type === item.size && type.available === true))) { this.logger?.(JSON.stringify({ event: 'admission_refused', project: this.project?.id, reason: 'provider_limits', size: item.size })); return; }
      await this.admit(key, limits, Number(project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200), epoch, beforeStart, afterStart);
    } catch (error) { await this.storage.put('pool:last-error', { at: this.now(), stage: 'create', createKey: key, ...failureDetail(error) }); }
  }

  // which queued jobs still need a box. Supply that was created or reserved for a lane covers that
  // lane's jobs first; the rest of the supply covers the remaining jobs in lane order. Without lanes this is the
  // old FIFO coverage. A release shard queued behind a pending feature create is therefore uncovered and may
  // take that create's slot (the pending create is withdrawn, never a booting or busy box).
  uncoveredByLane(jobs, supply, { lanesOn, byLane, units, pool, now }) {
    if (!lanesOn) return uncovered(jobs, supply);
    const perLane = {};
    for (const unit of units) {
      if (!unit.lane) continue;
      const count = Object.values(supplyCounts([unit], now, pool)).reduce((sum, value) => sum + value, 0);
      if (count > 0) perLane[unit.lane] = (perLane[unit.lane] ?? 0) + count;
    }
    let free = Math.max(0, supply - Object.values(perLane).reduce((sum, value) => sum + value, 0));
    const result = [];
    for (const job of [...jobs].sort(byLane)) {
      if (job.lane && perLane[job.lane] > 0) { perLane[job.lane]--; continue; }
      if (free > 0) { free--; continue; }
      result.push(job);
    }
    return result;
  }

  // lane ordering and reservation are on when the project declares lanes and the runtime switch is not off.
  async lanesEnabled(project) {
    if (!laneRules(project).length) return false;
    return (await this.storage.get(LANES_SWITCH_KEY))?.mode !== 'off';
  }

  async concurrentCapReached(project) {
    const cap = project.caps?.concurrent;
    if (!Number.isSafeInteger(cap) || cap < 0) return false;
    const [boxes, creates] = await Promise.all([records(this.storage, 'box:'), records(this.storage, 'create:')]);
    return boxes.filter(box => box.state !== 'deleted').length + creates.filter(item => item.state !== 'pending').length + await this.pendingLeaseStarts() >= cap;
  }

  async prepareSnapshotRecovery({ pools, demand, boxes, creates, locals, project, account, env, override, now, dockerSwitches = {} }) {
    if (!this.installation || !this.budget || typeof this.api.getJob !== 'function') return;
    const existing = creates.find(item => item.state === 'pending' && item.snapshotRecoveryJobId);
    if (existing) {
      await this.budget.enqueue(existing.createKey, existing.queuedAt, existing.snapshotRecoveryJobId, { pool: true, label: JSON.parse(existing.pool)[1], snapshotRecovery: true });
      return;
    }
    if (creates.length) {
      // Pre-outage, uncalled creates cannot be admitted from an incomplete
      // snapshot. Withdraw them after the hold so they cannot block recovery.
      // A provider call or uncertain claim is never withdrawn here.
      for (const create of creates) {
        if (create.state !== 'pending') continue;
        const pool = pools.find(item => item.key === create.pool && item.reason === 'snapshot_incomplete');
        const hold = pool && await this.storage.get(`pool:snapshot-hold:${pool.label}`);
        if (!Number.isFinite(hold?.since) || now - hold.since < 180_000) continue;
        const claim = await this.budget.claim(create.createKey);
        const cancelled = claim?.status === 'pending' ? await this.budget.cancelPending(create.createKey)
          : !claim && (await this.budget.abandon(create.createKey) || !await this.budget.claim(create.createKey));
        if (cancelled) await this.discardCreate(create.createKey);
      }
      return;
    }
    if (await this.concurrentCapReached(project)) return;
    const last = await this.storage.get('snapshot:recovery-last');
    if (Number.isFinite(last) && now - last < 120_000) return;
    for (const pool of pools) {
      if (pool.reason !== 'snapshot_incomplete') continue;
      const hold = await this.storage.get(`pool:snapshot-hold:${pool.label}`);
      if (!Number.isFinite(hold?.since) || now - hold.since < 180_000) continue;
      if (boxes.some(box => box.pool === pool.key && !['busy', 'deleted', 'destroying', 'purging', 'leased', 'quarantined'].includes(box.state)) || locals.some(local => env.CI_TO_MINIS !== 'false' && local.label === pool.label && localOfferActive(local, now, project.externalClaimer ?? project.localFirst))) continue;
      const job = demand.filter(item => item.pool === pool.key && item.status === 'queued' && item.source === 'webhook' && !item.missing && !(project.workflowConcurrency ?? []).some(rule => matchesWorkflowRule(item, rule))).sort(laneComparator(now, await this.lanesEnabled(project)))[0];
      if (!job || await this.storage.get(`snapshot:recovery-job:${job.id}`)) continue;
      let actual;
      try { actual = await this.api.getJob({ repo: project.repo, installation: this.installation, id: job.id }, job.id); } catch { continue; }
      if (actual?.id !== job.id || actual.status !== 'queued' || actual.runner_name) continue;
      const createKey = crypto.randomUUID(), routerCreateName = `boat-router-${(await this.budget.claimKey(createKey)).slice(0, 32)}`;
      const resetMode = labelReuse(project, account, override, pool.label, dockerSwitches);
      const record = { pool: pool.key, size: pool.size, createKey, routerCreateName, state: 'pending', at: now, queuedAt: job.queuedAt, reusable: resetMode !== null, ...(job.lane ? { lane: job.lane, lanePriority: job.lanePriority ?? null } : {}), ...(resetMode === 'docker' ? { resetMode } : {}), snapshotRecoveryJobId: job.id, ...(this.createAccount ? { account: this.createAccount } : {}) };
      const prepared = await this.storage.transaction(async tx => {
        const current = await tx.get(`gh-job:${job.id}`), lastAt = await tx.get('snapshot:recovery-last');
        if (current?.status !== 'queued' || current.source !== 'webhook' || current.missing || current.observedAt !== job.observedAt || await tx.get(`snapshot:recovery-job:${job.id}`) || (Number.isFinite(lastAt) && now - lastAt < 120_000)) return false;
        await tx.put(`create:${createKey}`, record);
        await tx.put(`snapshot:recovery-job:${job.id}`, { createKey, at: now });
        await tx.put('snapshot:recovery-last', now);
        return true;
      });
      if (prepared) await this.budget.enqueue(createKey, job.queuedAt, job.id, { pool: true, label: pool.label, snapshotRecovery: true });
      return;
    }
  }

  async tick({ mode = 'shadow', env = {}, account = {}, project = this.project, prepareOnly = false, preprepared = false, preparationFailed = false, skipAdmission = false, executor = 'jit' } = {}) {
    if (!project || !['shadow', 'on', 'drain'].includes(mode)) throw new TypeError('invalid pool mode');
    if (executor !== 'jit') throw new TypeError('invalid pool executor');
    if (mode !== 'shadow' && !(await this.storage.get('pool:migrated'))?.done) throw new Error('migration required');
    const now = this.now();
    if (mode !== 'shadow' && !preprepared) await prunePool(this.storage, now);
    const [jobs, boxes, creates, locals, snapshot, breakerRecord, blocked, backoff, override, dockerSwitches, localSwitches, offerSeen] = await Promise.all([
      records(this.storage, executor === 'direct' ? 'direct:job:' : 'gh-job:'), records(this.storage, 'box:'), records(this.storage, 'create:'),
      records(this.storage, 'local-runner:'), this.storage.get('pool:snapshot'), currentBreaker(this.storage, now),
      this.storage.get('blocked'), this.storage.get('startBackoffUntil'), this.storage.get('reuse:override'), this.storage.get(DOCKER_REUSE_KEY).then(value => value ?? {}),
      this.storage.get(LOCAL_MODE_KEY).then(value => value ?? {}), this.storage.get(LOCAL_OFFER_KEY).then(value => value ?? {}),
    ]);
    const lanesOn = await this.lanesEnabled(project);
    const byLane = laneComparator(now, lanesOn);
    const localClaimer = project.externalClaimer ?? project.localFirst;
    const localOn = label => env.CI_TO_MINIS !== 'false' && labelLocal(localClaimer, localSwitches, label) === 'on';
    const localFree = localRoom(this.getLocalCapacity?.(), now);
    const reuseFor = label => labelReuse(project, account, override, label, dockerSwitches);
    for (const box of boxes) if (!Number.isFinite(box.machineTtlSeconds)) box.machineTtlSeconds = Math.min(Number(project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200), 7200);
    let breaker = breakerRecord;
    // A crash before an account reservation can leave a probe marker. Clear
    // only a marker with no ledger claim and no associated machine.
    if (breaker?.tripped && !breaker.bySize && breaker.probe && now - breaker.probe.at >= 180_000) {
      const probe = breaker.probe, create = creates.find(item => item.createKey === probe.createKey);
      if (create?.state === 'pending' && !boxes.some(box => box.createKey === probe.createKey)) {
        try {
          const claim = await this.budget.claim(probe.createKey);
          if (!claim || (claim.status === 'pending' && await this.budget.cancelPending(probe.createKey))) await this.storage.transaction(async tx => {
            const current = await tx.get('verification:breaker');
            if (!current?.bySize && current?.probe?.createKey === probe.createKey) await tx.put('verification:breaker', { ...current, probe: null });
          });
        } catch { /* Uncertain account state stays fenced. */ }
      }
    }
    for (const [size, scoped] of Object.entries(breaker?.bySize ?? {})) {
      const probe = scoped?.probe;
      if (!probe || now - probe.at < 180_000 || boxes.some(box => box.createKey === probe.createKey)) continue;
      const create = creates.find(item => item.createKey === probe.createKey);
      if (!create || create.state !== 'pending') continue;
      try {
        const claim = await this.budget.claim(probe.createKey);
        if (!claim || (claim.status === 'pending' && await this.budget.cancelPending(probe.createKey))) await releaseSizedProbe(this.storage, size, probe.createKey);
      } catch { /* Uncertain account state stays fenced. */ }
    }
    breaker = await currentBreaker(this.storage, now);
    if (executor === 'direct' && (boxes.some(box => box.executor !== 'direct') || creates.some(create => create.executor !== 'direct'))) throw new Error('mixed executor storage');
    const complete = executor === 'direct' || snapshot?.complete === true, runners = executor === 'direct' ? [] : complete ? snapshot.runners ?? [] : [];
    if (breaker?.tripped && !breaker.probe && Number.isFinite(breaker.trippedAt) && breaker.trippedAt + BREAKER_PROBE_DELAY_MS > now) {
      const next = breaker.trippedAt + BREAKER_PROBE_DELAY_MS, alarm = await this.storage.getAlarm();
      if (alarm === null || alarm > next) await this.storage.setAlarm(next);
    }
    // Older breaker records have no failure time. Establish a conservative
    // baseline so only later job completions can clear those failures.
    for (const [size, count] of Object.entries(breaker?.counts ?? {})) {
      if (count > 0) await this.storage.transaction(async tx => {
        const key = `verification:last-failure:${size}`;
        if (!Number.isFinite(await tx.get(key))) await tx.put(key, now);
      });
    }
    if (executor !== 'direct' && !prepareOnly && mode !== 'shadow' && complete && now - (await this.storage.get('pool:orphan-sweep') ?? -Infinity) >= 600_000) {
      try { await this.sweepOrphans(snapshot, project); }
      catch { await this.storage.put('pool:last-error', { at: now, stage: 'orphan-sweep' }); }
    }
    const byName = new Map(runners.map(runner => [runner.name, runner]));
    const known = new Set([...boxes.map(box => box.runnerName), ...locals.map(local => local.name)].filter(Boolean));
    const demand = runnableDemand(jobs.filter(job => !job.missing || !complete), project.workflowConcurrency, complete, { laneCaps: lanesOn });
    // One set of reuse limits for the planner (a finishing box as supply, the young-job hold) and the per-box
    // retirement decision below, so the planner never counts a box that the next step destroys.
    const maxJobs = Math.min(account.reuse?.maxJobs ?? 60, project.reuse?.maxJobs ?? 60);
    const maxAge = Math.min(account.reuse?.maxAgeSeconds ?? 86400, project.reuse?.maxAgeSeconds ?? 86400);
    const timeouts = Object.values(project.jobs ?? {}).map(job => job.timeoutMinutes ?? 0);
    const headroom = Math.max(300, 1200 + Math.max(0, ...timeouts) * 60);
    const ttlFor = box => Number(box.machineTtlSeconds ?? project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200);
    // Fences and retargets add generations without jobs, so the cap counts both.
    const generationCapped = box => (box.jobs ?? 0) + 1 >= maxJobs || (box.resetMode === 'docker' && (box.generation ?? 0) + 1 > DOCKER_RESET_MAX_GENERATION);
    const ageAllows = box => Number.isFinite(box.createdAt) && Number.isFinite(ttlFor(box)) && timeouts.every(Number.isFinite) && now - box.createdAt < Math.min(maxAge, ttlFor(box) - headroom) * 1000;
    const jobGuard = box => {
      const associated = executor === 'direct' ? demand.filter(job => job.id === (box.lease ?? box.lastLease)) : demand.filter(job => job.runnerName && job.runnerName === box.runnerName);
      const running = associated.some(job => job.status === 'in_progress'), last = associated.find(job => job.status === 'completed');
      // A cancelled or skipped job says nothing about the box (the guard retired healthy boxes
      // after cancelled jobs). A box with no job result at all is guarded until the listing catches up.
      const neutral = Boolean(last) && ['cancelled', 'skipped'].includes(last.conclusion);
      const guarded = !box.localHoldRelease && account.waitForBusyBox?.enabled === true && ['idle', 'busy', 'finished'].includes(box.state) && !running && !neutral && (!last?.durationRecorded || last.slowBox === true || last.conclusion === 'timed_out');
      return { associated, running, last, guarded, missingResult: guarded && !last };
    };
    const willReset = box => box.resetMode === 'docker' && box.reusable && Boolean(box.baselineHash) && !box.drainOnly && reuseFor(poolLabel(box.pool)) === 'docker' && !generationCapped(box) && ageAllows(box);
    const units = [
      ...creates.map(create => ({ ...create, kind: 'create' })),
      ...boxes.filter(box => !box.drainOnly).map(box => ({ ...box, ...((box.state === 'local-held' || (box.state === 'finished' && box.localHoldRelease)) && box.reusable && box.baselineHash ? { kind: 'held-boat' } : {}), online: executor === 'direct' ? box.state === 'idle' : byName.get(box.runnerName)?.status === 'online', busy: executor === 'direct' ? box.state === 'busy' : byName.get(box.runnerName)?.busy === true,
        // GitHub's job list and runner list lag each other by seconds around a job's end: a runner that is
        // absent or not busy, or a completed job on it, means the box resets next and covers the next job.
        // A runner that is absent counts only while the absence is fresh (the job list lags the runner list by
        // seconds); a record that stays busy with no runner for longer is stale supply.
        resetPending: executor === 'jit' && complete && ['busy', 'finished'].includes(box.state) && willReset(box) && ((byName.has(box.runnerName) && byName.get(box.runnerName)?.busy !== true) || (!byName.has(box.runnerName) && !(Number.isFinite(box.runnerAbsentSince) && now - box.runnerAbsentSince >= RUNNER_GONE_GRACE_MS)) || demand.some(job => job.status === 'completed' && job.runnerName === box.runnerName)) && !jobGuard(box).guarded })),
      ...locals.filter(() => env.CI_TO_MINIS !== 'false').map(local => ({ ...local, pool: poolKey(project.repo, local.label), kind: 'local', online: byName.get(local.name)?.status === 'online', busy: byName.get(local.name)?.busy === true })),
    ];
    const labels = new Set([...project.labels, ...jobs.map(job => JSON.parse(job.pool)[1]), ...boxes.filter(box => box.pool).map(box => JSON.parse(box.pool)[1])]);
    for (const runner of runners) if (!known.has(runner.name)) for (const label of runner.labels ?? []) {
      const name = typeof label === 'string' ? label : label.name;
      if (labels.has(name)) units.push({ kind: 'foreign', pool: poolKey(project.repo, name), snapshotComplete: true, online: runner.status === 'online', busy: runner.busy === true });
    }
    const pools = [];
    const epoch = env.RESUME_EPOCH ?? '0';
    for (const label of labels) {
      let size;
      try { size = poolSize(project, label); } catch (error) { if (!(error instanceof TypeError)) throw error; }
      const sizeBlock = size ? await this.storage.get(`size-block:${size}`) : null;
      const claimer = project.externalClaimer ?? project.localFirst;
      const scopedBreaker = breakerForSize(breaker, size);
      const reason = claimer?.localOnly?.includes(label) ? 'local_only' : !size ? 'size_block' : mode === 'drain' || env.ENABLED !== 'true' || blocked?.epoch === epoch ? 'stopped' : scopedBreaker?.tripped && !breakerCanProbe(scopedBreaker, now) && !scopedBreaker.probe ? 'breaker' : sizeBlock?.epoch === epoch ? 'size_block' : backoff > now ? 'backoff' : !complete ? 'snapshot_incomplete' : null;
      pools.push({ key: poolKey(project.repo, label), label, size, reason, localFirst: localOn(label) && localFree, offerSeconds: claimer?.offerSeconds, registeredHoldSeconds: claimer?.registeredHoldSeconds });
    }
    // First tick at which each queued job of a local-first pool was offered to the minis.
    const localPools = new Set(pools.filter(pool => pool.localFirst).map(pool => pool.key));
    const localJob = job => localPools.has(job.pool) && localJobAllowed(localClaimer, job);
    const seen = Object.fromEntries(demand.filter(job => job.status === 'queued' && localJob(job)).map(job => [job.id, Number.isFinite(offerSeen[job.id]) ? offerSeen[job.id] : now]));
    if (JSON.stringify(seen) !== JSON.stringify(offerSeen)) await this.storage.put(LOCAL_OFFER_KEY, seen);
    const offerAged = job => !localJob(job) || (seen[job.id] ?? now) + ((pools.find(pool => pool.key === job.pool)?.offerSeconds ?? 30) * 1000) <= now;
    if (mode === 'shadow') return plan({ pools, jobs: demand, units, now });
    const waitEnabled = complete && mode === 'on' && [...labels].some(label => reuseFor(label) !== null);
    const pacing = await reusePacing({ account, api: this.api, budget: this.budget, now: this.now });
    const healthMode = executor === 'jit' ? await effectiveHealthMode(account, this.api, now) : 'observe';
    const baseHold = project.reuse?.idleHoldSeconds ?? account.reuse?.idleHoldSeconds ?? 120;
    // With the free day window empty every start is billed, so a longer hold only
    // trades a paid start for VM hours; `idleHoldSecondsWhenStartsPaid` (default
    // 20 min) is the whole extension, after which the box retires as normal.
    const paidHold = paidIdleHold({ pacing, baseSeconds: baseHold, configured: project.reuse?.idleHoldSecondsWhenStartsPaid ?? account.reuse?.idleHoldSecondsWhenStartsPaid });
    const nominalHold = paidHold ?? nominalReuseHold(baseHold, pacing?.startsPerHour);
    const reuseStatus = { reuseIdleHoldSeconds: nominalHold,
      reusePacingStartsPerHour: pacing?.startsPerHour ?? null, reusePacingSampledAt: pacing?.sampledAt ?? null,
      reuseDayRoomEmpty: pacing?.dayRoomEmpty ?? null, reusePaidExtraRoom: pacing?.paidExtraRoom ?? null,
      reuseHoldBasis: paidHold != null ? 'paid_starts' : !pacing ? 'unknown' : pacing.startsPerHour <= 5 ? 'low_rate' : pacing.startsPerHour >= 15 ? 'normal_rate' : 'transition' };
    const waitPools = pools.map(pool => pool.reason === 'breaker' ? { ...pool, reason: null } : pool);
    const waitUnits = account.paidOverflow?.enabled === true ? units.filter(unit => unit.kind !== 'create' || unit.state !== 'pending') : units;
    const waits = await waitClaims({ storage: this.storage, api: this.api, jobs: demand, boxes, pools: waitPools, units: waitUnits, now, account, project, env, enabled: false, logger: this.logger });
    units.push(...waits.virtual);
    const output = plan({ pools, jobs: demand, units, now });
    // GitHub can list a needs-dependent job as queued a few seconds before its parent reads completed. Hold a
    // create for each job queued in the last 20 s while a Docker-reset box of the pool is still busy: that box
    // resets next and covers the job; the next snapshot decides. A burst beyond the busy boxes still creates now.
    for (const pool of pools) {
      if (!output[pool.key]?.create || reuseFor(pool.label) !== 'docker') continue;
      const finishing = units.filter(unit => unit.pool === pool.key && unit.kind !== 'create' && unit.state === 'busy' && unit.resetPending !== true && willReset(unit)).length;
      const young = demand.filter(job => job.pool === pool.key && job.status === 'queued' && Number.isFinite(job.queuedAt) && now - job.queuedAt < 20_000).length;
      const hold = Math.min(finishing, young, output[pool.key].create);
      if (hold > 0) { output[pool.key].create -= hold; output[pool.key].youngHold = hold; }
    }
    if (waits.active.length) await this.storage.setAlarm(Math.min(...waits.active.map(c => c.until), now + 10_000));
    // A clean larger box can serve another label of the same repository. Fence
    // its old JIT runner before the normal light reset and re-registration.
    if (!preprepared && complete && mode === 'on' && waitEnabled) {
      for (const pool of pools) {
        if (!output[pool.key]?.create || pool.reason || !MACHINE_SIZES.includes(pool.size)) continue;
        if (project.dispatchOnly === true) {
          const warm = boxes.filter(box => box.baseId == null && box.pool !== pool.key && box.state === 'ready' && box.reusable && box.baselineHash && !box.drainOnly && (box.resetMode ?? 'light') === reuseFor(pool.label) && output[box.pool]?.surplus > 0 && MACHINE_SIZES.includes(box.size) && MACHINE_SIZES.indexOf(box.size) >= MACHINE_SIZES.indexOf(pool.size) && sameOrigin(box.originPool ?? box.pool, project.repo) && (box.size === pool.size || !largerDemandExpected(jobs, project, box.size, now))).sort((a,b) => MACHINE_SIZES.indexOf(a.size) - MACHINE_SIZES.indexOf(b.size) || a.since - b.since)[0];
          if (warm && await this.transition(warm.machineId, 'cross_size_handoff', { pool: pool.key, dispatchJobId: null, dispatchAt: null, ...(warm.size !== pool.size ? { crossSizeHandoffs: (warm.crossSizeHandoffs ?? 0) + 1, lastCrossSizeAt: now } : {}) })) {
            if (warm.size !== pool.size) this.logger?.(JSON.stringify({ event: 'cross_size_handoff', project: project.id, machineId: warm.machineId, from: warm.pool, to: pool.key, size: warm.size }));
            await this.storage.setAlarm(now + 1000);
            return output;
          }
          continue;
        }
        const donor = boxes.filter(box => box.baseId == null && box.pool !== pool.key && box.state === 'idle' && box.reusable && box.baselineHash && box.everOnline && !box.drainOnly && (box.resetMode ?? 'light') === reuseFor(pool.label) && output[box.pool]?.surplus > 0 && !byName.get(box.runnerName)?.busy && byName.get(box.runnerName)?.status === 'online' && MACHINE_SIZES.indexOf(box.size) >= MACHINE_SIZES.indexOf(pool.size) && MACHINE_SIZES.includes(box.size) && sameOrigin(box.originPool ?? box.pool, project.repo) && (box.size === pool.size || !largerDemandExpected(jobs, project, box.size, now))).sort((a,b) => MACHINE_SIZES.indexOf(a.size) - MACHINE_SIZES.indexOf(b.size) || a.since - b.since)[0];
        if (!donor) continue;
        const retiring = await this.transition(donor.machineId, 'retarget', { afterFence: 'finished', retargetPool: pool.key });
        if (retiring && await this.fenceRunner(retiring)) { if (donor.size !== pool.size) this.logger?.(JSON.stringify({ event: 'cross_size_handoff', project: project.id, machineId: donor.machineId, from: donor.pool, to: pool.key, size: donor.size })); await this.storage.setAlarm(now + 1000); return output; }
      }
    }

    for (const pool of pools) {
      const idle = boxes.filter(box => box.pool === pool.key && ['ready', 'idle', 'local-held'].includes(box.state) && !byName.get(box.runnerName)?.busy);
      const overdue = idle.filter(box => {
        const since = box.state === 'ready' ? box.since : box.onlineAt ?? box.since;
        const hold = reuseHold({ box: box.state === 'ready' ? { ...box, onlineAt: since } : box, baseSeconds: baseHold, nominalSeconds: nominalHold, now, account, project, env, enabled: waitEnabled });
        return Number.isFinite(since) && now - since > hold * 1000;
      });
      let status = { ...output[pool.key], ...reuseStatus, idleBoxes: idle.length, idleBoxesOverHold: overdue.length, idleBoxSampledAt: now };
      if (preprepared && !output[pool.key].reason) {
        const previous = await this.storage.get(`pool:status:${pool.label}`);
        if (previous?.reason?.startsWith('ledger:')) status = { ...status, reason: previous.reason };
      }
      await this.storage.put(`pool:status:${pool.label}`, status);
      await observeRouterStall(this.storage, { project: project.id, pool: pool.key, demand: status.D, boxes, creates, now, enabled: mode === 'on' && env.ENABLED === 'true', logger: this.logger });
      await this.storage.transaction(async tx => {
        const key = `pool:snapshot-hold:${pool.label}`, hold = await tx.get(key);
        if (complete) { if (hold) await tx.delete(key); return; }
        if (mode !== 'on' || env.ENABLED !== 'true') return;
        if (!hold) await tx.put(key, { since: now, alerted: false });
        else if (!hold.alerted && now - hold.since > 300_000) {
          await this.emit?.('alert_snapshot_incomplete', null, { pool: pool.key }, tx);
          await tx.put(key, { ...hold, alerted: true });
        }
      });
    }
    // Withdraw in one transaction so an incomplete project never holds the
    // head of another project's account queue.
    if (!complete && this.budget?.ledger?.withdrawPoolWaiters) await this.budget.ledger.withdrawPoolWaiters(this.budget.project);
    // Avoid per-create work while the next scan batch is pending.
    if (prepareOnly && !complete) {
      if (mode === 'on' && env.ENABLED === 'true' && !preparationFailed) await this.prepareSnapshotRecovery({ pools, demand, boxes, creates, locals, project, account, env, override, now, dockerSwitches });
      return output;
    }
    // A job that landed while the retirement was in flight should take the box
    // it was retiring: the runner is still live until the fence, so canceling
    // the retirement is cheaper than paying a start for that job.
    if (!prepareOnly && complete) {
      for (const box of boxes.filter(item => item.state === 'retiring' && item.retirementReason === 'idle_hold_expired' && item.runnerFenced !== true && item.reusable === true && !item.afterFence && !item.retargetPool)) {
        if (!(output[box.pool]?.create > 0) || !(await this.queuedCount(box))) continue;
        if (await this.transition(box.machineId, 'retire_cancel', { retirementReason: null, afterFence: null, retargetPool: null })) {
          output[box.pool].create = Math.max(0, output[box.pool].create - 1);
          this.logger?.(JSON.stringify({ event: 'retire_cancel', project: this.project?.id, machineId: box.machineId, pool: box.pool }));
        }
      }
    }
    const cap = project.caps?.concurrent ?? Infinity;
    let room = Math.max(0, cap - boxes.filter(box => box.state !== 'deleted').length - creates.length - await this.pendingLeaseStarts());
    const candidates = [];
    for (const pool of pools) {
      const result = output[pool.key];
      const uncalled = creates.filter(item => item.pool === pool.key && item.state === 'pending').sort((a, b) => b.at - a.at);
      const others = Math.max(0, result.S - uncalled.length);
      let excessPending = Math.max(0, uncalled.length - Math.max(0, result.Dboat - others));
      let surplus = result.surplus;
      for (const create of uncalled) {
        if (!excessPending) break;
        const claim = await this.budget.claim(create.createKey);
        const cancelled = claim ? await this.budget.cancelPending(create.createKey) : (await this.budget.abandon(create.createKey) || !await this.budget.claim(create.createKey));
        if (cancelled) { await this.discardCreate(create.createKey); excessPending--; surplus = Math.max(0, surplus - 1); room++; }
      }
      if (!prepareOnly && surplus && complete) {
        // A webhook can record a job after this tick read its demand, so a
        // retirement compares the pool's fresh queued count with that read: a
        // job the snapshot did not see keeps the box that would have covered it.
        const queuedSnapshot = jobs.filter(job => job.pool === pool.key && job.status === 'queued' && !job.missing).length;
        for (const box of boxes.filter(item => item.pool === pool.key && item.state === 'idle').sort((a, b) => a.since - b.since)) {
          if (!surplus) break;
          const hold = reuseHold({ box, baseSeconds: baseHold, nominalSeconds: nominalHold, now, account, project, env, enabled: waitEnabled });
          if (now - (box.onlineAt ?? box.since) < hold * 1000 || byName.get(box.runnerName)?.busy) continue;
          const retired = executor === 'direct'
            ? ((await this.queuedCount(box)) > queuedSnapshot ? false : await this.transition(box.machineId, 'retire_direct', { runnerFenced: true, retirementReason: 'idle_hold_expired' }))
            : await this.retire(box.machineId, 'idle_hold_expired', { queuedSnapshot });
          if (!retired) break;
          surplus--;
        }
      }
      result.surplus = surplus;
      if (!preparationFailed && result.create > 0) {
        const aged = demand.filter(job => job.pool === pool.key && job.status === 'queued' && offerAged(job));
        const held = waits.active.filter(claim => claim.pool === pool.key);
        const unheld = aged.filter(job => !held.some(claim => claim.jobId === job.id));
        for (const job of this.uncoveredByLane(unheld, Math.max(0, result.S - held.length), { lanesOn, byLane, units: units.filter(unit => unit.pool === pool.key), pool, now }).slice(0, result.create)) candidates.push({ pool, job });
      }
    }
    // Free only the slots needed by queued work in other pools. The regular
    // warm hold remains in force for compatible boxes and without pressure.
    if (executor !== 'direct' && complete && !prepareOnly && mode === 'on' && room <= 0 && candidates.length) {
      const releasing = boxes.filter(box => ['retiring', 'destroying', 'purging'].includes(box.state)).length;
      let needed = Math.max(0, candidates.length - releasing);
      const candidatePools = new Set(candidates.map(candidate => candidate.pool.key));
      for (const box of boxes.filter(item => item.state === 'idle' && !candidatePools.has(item.pool)).sort((a, b) => a.since - b.since)) {
        if (!needed) break;
        if (!output[box.pool]?.surplus || now - (box.onlineAt ?? box.since) < 60_000 || byName.get(box.runnerName)?.busy) continue;
        if (await this.retire(box.machineId, 'incompatible_queue')) { needed--; output[box.pool].surplus--; }
      }
      for (const box of boxes.filter(item => item.state === 'local-held' && !candidatePools.has(item.pool)).sort((a, b) => a.since - b.since)) {
        if (!needed) break;
        if (!output[box.pool]?.surplus || now - (box.onlineAt ?? box.since) < 60_000) continue;
        if (await this.transition(box.machineId, 'retire_held', { retirementReason: 'incompatible_queue' })) { needed--; output[box.pool].surplus--; }
      }
    }
    candidates.sort((a, b) => byLane(a.job, b.job) || a.pool.key.localeCompare(b.pool.key));
    // a pending create for a job that sorts after this one gives up its slot (the old rule
    // compared queue times only; with lanes a release job replaces a younger or older feature create).
    // Shards of one run share a queue time, so a create of the candidate's own run is never withdrawn
    // (review R1 F1: the loop cancelled and recreated such a create on every tick).
    const replaceable = (await records(this.storage, 'create:')).filter(item => item.state === 'pending').sort((a, b) => byLane(b, a));
    const sameRun = (job, item) => Number.isSafeInteger(job.runId) && item.orderRunId === job.runId;
    const reserved = lanesOn ? reservedByLane(project) : {};
    const laneUsed = lanesOn ? laneUsage(boxes, creates, jobs) : {};
    // reserved slots on loan to the other lanes while the reserved lane is quiet. Decided once per
    // tick from the job records; the moment a release shard is queued or running, `lend` is empty again.
    const lend = lanesOn ? laneLending(project, jobs, now).lend : {};
    const preparedProbes = new Set();
    for (const { pool, job } of preprepared ? [] : candidates) {
      while (room <= 0) {
        const later = replaceable.find(item => !sameRun(job, item) && createYieldsTo(job, item, byLane));
        if (!later) break;
        replaceable.splice(replaceable.indexOf(later), 1);
        const claim = await this.budget.claim(later.createKey);
        const cancelled = claim?.status === 'pending' ? await this.budget.cancelPending(later.createKey)
          : !claim && (await this.budget.abandon(later.createKey) || !await this.budget.claim(later.createKey));
        if (!cancelled) continue;
        await this.discardCreate(later.createKey);
        if (lanesOn) { const key = later.lane ?? 'none'; laneUsed[key] = Math.max(0, (laneUsed[key] ?? 0) - 1); }
        room++;
      }
      const scopedBreaker = breakerForSize(breaker, pool.size);
      if (scopedBreaker?.tripped && (scopedBreaker.probe || preparedProbes.has(pool.size))) continue;
      if (room <= 0) break;
      // Reserved slots: a job outside a reserved lane leaves the reserved slots alone and waits for a shared
      // one; a later candidate of the reserved lane may still start this tick.
      if (lanesOn && !laneRoom({ lane: job.lane ?? null, used: laneUsed, cap, reserved, lend })) {
        this.logger?.(JSON.stringify({ event: 'lane_reserved_wait', project: project.id, job_id: job.id, lane: job.lane ?? null, used: laneUsed, reserved, lend }));
        continue;
      }
      // A non-reserved job that fits only because of the loan takes a reserved slot: say so.
      if (lanesOn && !(job.lane && reserved[job.lane] !== undefined) && !laneRoom({ lane: job.lane ?? null, used: laneUsed, cap, reserved })) {
        this.logger?.(JSON.stringify({ event: 'lane_borrow', project: project.id, job_id: job.id, lane: job.lane ?? null, used: laneUsed, reserved, lend, borrowed: borrowedSlots({ used: laneUsed, cap, reserved }) + 1 }));
      }
      const resetMode = reuseFor(pool.label);
      const laneOptions = { orderJobId: job.id, orderRunId: job.runId, orderSource: job.source, ...(lanesOn && job.lane ? { lane: job.lane, lanePriority: lanePriorityOf(job) } : {}) };
      await this.prepare(pool.key, pool.size, 1, job.queuedAt, resetMode !== null, executor === 'direct' ? { executor, prefix: 'direct-', golden: job.golden, ...laneOptions } : resetMode === 'docker' ? { resetMode, ...laneOptions } : laneOptions);
      if (scopedBreaker?.tripped) preparedProbes.add(pool.size);
      if (lanesOn) { const key = job.lane ?? 'none'; laneUsed[key] = (laneUsed[key] ?? 0) + 1; }
      room--;
    }
    const pending = await records(this.storage, 'create:');
    for (const item of pending) {
      if (item.state !== 'pending' || item.executor === 'direct') continue;
      const resetMode = reuseFor(poolLabel(item.pool));
      if (item.reusable === (resetMode !== null) && (item.resetMode ?? null) === (resetMode === 'docker' ? 'docker' : null)) continue;
      const claim = await this.budget.claim(item.createKey);
      if (claim && claim.status !== 'pending') continue;
      item.reusable = resetMode !== null;
      if (resetMode === 'docker') item.resetMode = 'docker'; else delete item.resetMode;
      await this.storage.put(`create:${item.createKey}`, item);
    }
    const ranks = new Map(await Promise.all(pending.map(async item => [item.createKey, this.budget.claimKey ? await this.budget.claimKey(item.createKey) : item.createKey])));
    pending.sort((a, b) => byLane(a, b) || ranks.get(a.createKey).localeCompare(ranks.get(b.createKey)));
    for (const item of pending) {
      if (item.state !== 'pending' || !output[item.pool]?.reason) continue;
      if (!complete) continue;
      const claim = await this.budget.claim(item.createKey);
      if (!claim || claim.status === 'pending') await this.budget.abandon?.(item.createKey);
    }
    if (prepareOnly) {
      const eligible = new Set((await this.admissionEntries()).map(item => item.key));
      const probeEnqueued = new Set();
      for (const item of pending) {
        if (item.state !== 'pending' || !eligible.has(item.createKey) || output[item.pool]?.reason) continue;
        const scopedBreaker = breakerForSize(breaker, item.size);
        if (scopedBreaker?.tripped && (probeEnqueued.has(item.size) || (scopedBreaker.probe && scopedBreaker.probe.createKey !== item.createKey))) continue;
        await this.budget.enqueue(item.createKey, item.queuedAt, undefined, { pool: true, label: JSON.parse(item.pool)[1] });
        if (scopedBreaker?.tripped) probeEnqueued.add(item.size);
      }
      return output;
    }
    let limits;
    for (const item of skipAdmission ? [] : pending) {
      if (item.state === 'snapshot_missing') { await this.finishSnapshotFallback(item); continue; }
      const claim = await this.budget.claim(item.createKey);
      const uncertain = claim && claim.status !== 'pending';
      if (!uncertain && mode === 'drain') {
        const cancelled = claim ? await this.budget.cancelPending(item.createKey) : (await this.budget.abandon(item.createKey) || !await this.budget.claim(item.createKey));
        if (cancelled) await this.discardCreate(item.createKey);
        continue;
      }
      if (!uncertain && output[item.pool]?.reason) continue;
      if (!uncertain && preparationFailed) continue;
      if (!uncertain && await this.concurrentCapReached(project)) continue;
      if (!uncertain && ((await this.storage.get('startBackoffUntil')) > now || (await this.storage.get('blocked'))?.epoch === epoch || (await this.storage.get(`size-block:${item.size}`))?.epoch === epoch)) continue;
      if (!uncertain && !limits) {
        try { limits = await this.api.limits(); }
        catch { await this.storage.put('pool:last-error', { at: now, stage: 'limits' }); continue; }
      }
      if (!uncertain && (!limits.canStart || !limits.machineTypes?.some(type => type.type === item.size && type.available === true))) {
        const label = JSON.parse(item.pool)[1], key = `pool:status:${label}`, status = await this.storage.get(key);
        if (status) await this.storage.put(key, { ...status, reason: limits.canStart ? 'size_block' : 'backoff' });
        continue;
      }
      try { await this.admit(item.createKey, limits ?? {}, Number(project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200), epoch); }
      catch (error) { await this.storage.put('pool:last-error', { at: now, stage: 'create', createKey: item.createKey, ...failureDetail(error) }); }
    }
    // Release no more warm runners than aged demand can use. Otherwise a
    // younger GitHub job could take an extra runner before its offer expires.
    const releaseBudget = new Map(pools.map(pool => {
      const aged = demand.filter(job => job.pool === pool.key && job.status === 'queued').length;
      const other = Object.values(supplyCounts(units.filter(unit => unit.pool === pool.key && (unit.kind !== 'held-boat' || (unit.state === 'finished' && unit.localHoldRelease))), now, pool)).reduce((sum, count) => sum + count, 0);
      return [pool.key, Math.max(0, aged - other)];
    }));
    const fenceBudget = new Map(pools.map(pool => {
      const local = env.CI_TO_MINIS === 'false' ? 0 : locals.filter(item => item.label === pool.label && item.state === 'started' && localOfferActive(item, now, pool)).length;
      const queued = demand.filter(job => job.pool === pool.key && job.status === 'queued').length;
      const fenced = boxes.filter(box => box.pool === pool.key && ['local-fencing', 'local-held'].includes(box.state)).length;
      return [pool.key, Math.max(0, Math.min(local, queued) - fenced)];
    }));
    for (const box of boxes) {
      if (typeof box.pool === 'string' && ['idle', 'local-fencing', 'local-held', 'ready'].includes(box.state)) {
        const readySurplus = complete && (output[box.pool]?.surplus ?? 0) > 0;
        const readyHold = reuseHold({ box: { ...box, onlineAt: box.since }, baseSeconds: baseHold, nominalSeconds: nominalHold, now, account, project, env, enabled: waitEnabled });
        if (project.dispatchOnly === true && box.state === 'ready' && (readySurplus || !demand.some(job => job.pool === box.pool && job.status === 'queued')) && Number.isFinite(box.since) && now - box.since >= readyHold * 1000) {
          if (await this.transition(box.machineId, 'retire_ready', { retirementReason: 'idle_hold_expired' }) && readySurplus) output[box.pool].surplus--;
          continue;
        }
        if (project.dispatchOnly === true && complete && box.state === 'idle' && !byName.get(box.runnerName)?.busy) {
          const target = jobs.find(job => job.id === box.dispatchJobId);
          const unreserved = !Number.isFinite(box.dispatchAt) || !Number.isSafeInteger(box.dispatchJobId);
          const expired = reservationExpired(box, now);
          const takenElsewhere = target && ['in_progress', 'completed'].includes(target.status) && target.runnerName !== box.runnerName;
          // a matrix shard reservation moves to another queued shard of its run and keeps the runner.
          const kept = (expired || takenElsewhere) && !unreserved && mode === 'on' && !box.drainOnly && ageAllows(box) && await this.retargetMatrixReservation(box.machineId, 'idle');
          if (!kept && (unreserved || expired || takenElsewhere)) {
            await this.transition(box.machineId, expired ? 'reservation_timeout' : 'fence_local', { ...(expired ? { reservationExpiredJobId: box.dispatchJobId } : {}) });
            continue;
          }
        }
        if (project.dispatchOnly !== true && complete && mode === 'on' && box.state === 'idle' && fenceBudget.get(box.pool) > 0 && !byName.get(box.runnerName)?.busy) {
          if (await this.transition(box.machineId, 'fence_local')) fenceBudget.set(box.pool, fenceBudget.get(box.pool) - 1);
          continue;
        }
        if (box.state === 'local-fencing') {
          try { await this.api.removeRunner(box); }
          catch (error) {
            if (error.status === 422) await this.transition(box.machineId, 'local_fence_busy');
            if (error.status !== 404) continue;
          }
          await this.transition(box.machineId, 'local_fenced', { runnerFenced: true });
          continue;
        }
        if (box.state === 'local-held') {
          const ttl = Number(box.machineTtlSeconds);
          const maxAge = Math.min(account.reuse?.maxAgeSeconds ?? 86400, project.reuse?.maxAgeSeconds ?? 86400);
          const expired = !Number.isFinite(box.createdAt) || !Number.isFinite(ttl) || !Number.isFinite(maxAge) || now - box.createdAt >= Math.min(ttl, maxAge) * 1000;
          const hold = reuseHold({ box, baseSeconds: baseHold, nominalSeconds: nominalHold, now, account, project, env, enabled: waitEnabled });
          const idleExpired = !demand.some(job => job.pool === box.pool && job.status === 'queued') && now - (box.onlineAt ?? box.since) >= hold * 1000;
          if (mode === 'drain' || box.drainOnly || override === 'off' || !box.reusable || !box.baselineHash || expired || idleExpired) await this.transition(box.machineId, 'retire_held', { retirementReason: expired ? 'ttl_expired' : idleExpired ? 'idle_hold_expired' : 'reuse_ineligible' });
          else if (releaseBudget.get(box.pool) > 0) {
            await this.transition(box.machineId, 'release_held', { localHoldRelease: true });
            releaseBudget.set(box.pool, releaseBudget.get(box.pool) - 1);
          }
          continue;
        }
      }
      if (mode === 'drain' && ['booting', 'baseline', 'ready', 'resetting'].includes(box.state) && !box.runnerId) {
        await this.transition(box.machineId, 'drain', { runnerFenced: true, retirementReason: 'pool_drain' }, { from: box.state });
        continue;
      }
      if (complete && (mode === 'drain' || box.drainOnly) && box.state === 'idle' && !byName.get(box.runnerName)?.busy) { if (executor === 'direct') await this.transition(box.machineId, 'retire_direct', { runnerFenced: true, retirementReason: 'pool_drain' }); else await this.retire(box.machineId, 'pool_drain'); continue; }
      if (complete && override === 'off' && box.state === 'idle' && (box.jobs ?? 0) > 0) { if (executor === 'direct') await this.transition(box.machineId, 'retire_direct', { runnerFenced: true, retirementReason: 'reuse_disabled' }); else await this.retire(box.machineId, 'reuse_disabled'); continue; }
      const ttl = ttlFor(box);
      // Drain an over-budget fleet only after jobs finish, never kill a busy
      // runner. Keep the oldest boxes for warm reuse inside the new slot cap.
      const budgetKeepers = account.poolPacing?.slotBudget === true ? boxes.filter(item => item.state !== 'deleted').sort((a, b) => (a.createdAt ?? a.since) - (b.createdAt ?? b.since) || a.machineId.localeCompare(b.machineId)).slice(0, project.caps.concurrent) : null;
      const withinBudget = !budgetKeepers || budgetKeepers.some(item => item.machineId === box.machineId);
      if (complete && !withinBudget && box.state === 'idle' && !byName.get(box.runnerName)?.busy) { await this.retire(box.machineId, 'live_budget'); continue; }
      const reuseEnabled = withinBudget && !box.drainOnly && mode !== 'drain' && reuseFor(poolLabel(box.pool)) === (box.resetMode ?? 'light') && !generationCapped(box) && ageAllows(box);
      try {
        const { associated, last, guarded, missingResult } = jobGuard(box);
        if (executor === 'jit') {
        for (const job of associated.filter(job => job.status === 'completed' && job.conclusion === 'success' && Number.isSafeInteger(job.id) && Number.isFinite(job.completedAt) && job.completedAt <= now).sort((a, b) => a.completedAt - b.completedAt)) {
          await this.verificationOutcome(box, 'job_completed', true, null, { jobId: job.id, completedAt: job.completedAt });
        }
        }
        // Tombstones may still provide late job-success evidence, but have no
        // next lifecycle step. Don't point-read each deleted box twice per tick.
        if (box.state === 'deleted') continue;
        const retirementReason = !box.reusable ? 'created_without_reuse' : !box.baselineHash ? 'baseline_missing' : guarded ? (last?.slowBox || last?.conclusion === 'timed_out' ? 'slow_job' : 'missing_job_result') : override === 'off' || (box.resetMode === 'docker' && reuseFor(poolLabel(box.pool)) !== 'docker') ? 'reuse_disabled' : generationCapped(box) ? 'generation_limit' : !reuseEnabled ? 'reuse_ineligible' : null;
        // Jobs still offered to the minis are not reserved by a ready box.
        const offered = new Set(demand.filter(job => job.status === 'queued' && !offerAged(job)).map(job => job.id));
        const view = { complete, at: snapshot?.at, runners, jobs: demand }, options = { reuseEnabled: reuseEnabled && !guarded, retirementReason, healthMode, reuseHealthMode: executor === 'jit' ? healthMode : 'observe', missingResult: missingResult && reuseEnabled, ttlSeconds: ttl, offered, ...(executor === 'direct' ? { executor } : {}) };
        await this.stepBox(box.machineId, view, options);
        const next = await this.storage.get(`box:${box.machineId}`);
        const localPool = pools.find(pool => pool.key === box.pool);
        const eligibleOverflow = demand.some(job => job.pool === box.pool && job.status === 'queued' && offerAged(job));
        if (['booting', 'baseline', 'resetting'].includes(box.state) && next?.state === 'ready' && output[box.pool]?.reason !== 'local_capacity' && (!localPool?.localFirst || eligibleOverflow)) await this.stepBox(box.machineId, view, options);
      }
      catch { await this.storage.put('pool:last-error', { at: now, stage: 'box', machineId: box.machineId }); }
    }
    if (executor === 'jit' && complete && mode === 'on' && project.setupWatchdog?.enabled === true && this.installation) {
      try {
        const watchdog = new SetupWatchdog({ storage: this.storage, api: this.api, project, installation: this.installation, now: this.now, logger: this.logger, fleet: this });
        await watchdog.inspect(await records(this.storage, 'box:'), demand);
        await watchdog.recover();
      } catch { await this.storage.put('pool:last-error', { at: now, stage: 'setup-watchdog' }); }
    }
    return output;
  }

  async sweepOrphans(snapshot, project) {
    if (snapshot?.complete !== true || !this.budget?.ledger?.storage) return;
    const [sandboxes, ledger, creates, boxes, jobs] = await Promise.all([
      this.api.listSandboxes(), this.budget.ledger.storage.get(this.budget.ledger.key), records(this.storage, 'create:'),
      records(this.storage, 'box:'), records(this.storage, 'gh-job:'),
    ]);
    const indexes = []; let cursor = '';
    for (;;) {
      const page = await this.storage.list({ prefix: 'runner:', startAfter: cursor, limit: 128 });
      indexes.push(...page);
      if (page.size < 128) break;
      cursor = [...page.keys()].at(-1);
    }
    const entries = Object.entries(ledger?.claims ?? {});
    const claims = new Set(entries.filter(([key, claim]) => claim.project === project.id && ['calling', 'unknown', 'created'].includes(claim.status) && entries.filter(([other]) => other.slice(0, 32) === key.slice(0, 32)).length === 1).map(([key]) => `boat-router-${key.slice(0, 32)}`));
    const knownNames = new Set(creates.map(create => create.routerCreateName));
    const knownIds = new Set(boxes.map(box => box.machineId));
    const duplicates = new Set(sandboxes.filter((box, i) => sandboxes.findIndex(other => other.name === box.name) !== i).map(box => box.name));
    for (const sandbox of sandboxes) {
      if (!claims.has(sandbox.name) || knownNames.has(sandbox.name) || knownIds.has(sandbox.id) || duplicates.has(sandbox.name) || !/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox.id ?? '')) continue;
      const aliases = [...indexes].filter(([, value]) => value.machineId === sandbox.id).map(([key]) => key.slice(7));
      const prefix = `boat-${project.id}-${sandbox.id}-g`;
      const runners = (snapshot.runners ?? []).filter(runner => aliases.includes(runner.name) || runner.name?.startsWith(prefix));
      const running = jobs.some(job => job.status === 'in_progress' && (aliases.includes(job.runnerName) || job.runnerName?.startsWith(prefix)));
      const runner = runners.length === 1 ? runners[0] : null;
      await this.storage.transaction(async tx => {
        if (await tx.get(`box:${sandbox.id}`)) return;
        await tx.put(`box:${sandbox.id}`, applyBoxEvent(null, 'adopt_orphan', { machineId: sandbox.id, ...(this.createAccount ? { account: this.createAccount } : {}), pool: null, drainOnly: true, orphan: true, aliases, noRunnerKnown: !running && runners.length === 0, runnerId: runner?.id ?? null, runnerName: runner?.name ?? null, repo: project.repo, installation: this.installation, reusable: false }, this.now()));
        await tx.put(`pool:drain-only:${sandbox.id}`, { at: this.now(), reason: 'orphan' });
      });
    }
    // A create whose provider call ended without a definite answer keeps its record but loses its
    // claim, and no admission path ever revisits a record that is not pending: the record would hold
    // one of the project's concurrency slots for good. Once the account lists no sandbox under the
    // create's name and the five-minute grace an uncertain claim gets has passed, the create is gone,
    // so the record goes too and the slot returns to the pool.
    const liveClaims = new Set(entries.filter(([, claim]) => claim.project === project.id).map(([key]) => `boat-router-${key.slice(0, 32)}`));
    const listed = new Set(sandboxes.map(box => box.name));
    for (const create of creates) {
      if (create.state === 'pending' || create.state === 'snapshot_missing') continue;
      if (listed.has(create.routerCreateName) || liveClaims.has(create.routerCreateName)) continue;
      const since = create.callingAt ?? create.at;
      if (!Number.isFinite(since) || this.now() - since < 300_000) continue;
      await this.discardCreate(create.createKey);
      this.logger?.(JSON.stringify({ event: 'discard_orphan_create', project: project.id, createKey: create.createKey, state: create.state, age_ms: this.now() - since }));
    }
    await this.storage.put('pool:orphan-sweep', this.now());
  }

  async recordResetOutcome(box, ok) {
    await this.storage.transaction(async tx => {
      const now = this.now();
      const previous = await tx.get('verification:reset-outcomes') ?? [];
      if (previous.some(item => item.machineId === box.machineId && item.generation === box.generation)) return;
      const recent = previous.filter(item => Number.isFinite(item.at) && item.at >= now - 86_400_000);
      recent.push({ at: now, machineId: box.machineId, generation: box.generation, ok });
      await tx.put('verification:reset-outcomes', recent.slice(-2000));
    });
  }

  async verificationOutcome(box, kind, ok, detail, evidence = {}) {
    const key = evidence.jobId ? `verification:attempt:job-success:${evidence.jobId}` : `verification:attempt:${ok ? 'online-success' : 'failure'}:${box.machineId}:${box.generation ?? 0}`;
    // Only memoize confirmed job-success markers, never the breaker state.
    // Expire no later than prunePool can delete a marker.
    const seen = evidence.jobId ? this.jobSuccessSeen ??= new Map() : null;
    if (seen?.get(key) > this.now()) return;
    let recordedAt;
    const change = await this.storage.transaction(async tx => {
      const existing = await tx.get(key);
      recordedAt = existing ? existing.at : this.now();
      if (existing) return;
      await tx.put(key, { at: recordedAt, kind, ...(box.size ? { size: box.size } : {}), ...(Number.isFinite(box.createdAt) ? { createdAt: box.createdAt } : {}), ...(detail ? { phase: box.state, message: JSON.stringify(detail) } : {}) });
      this.logger?.(JSON.stringify({ event: 'verification_result', project: this.project?.id, machine_id: box.machineId, kind, phase: box.state, ok, ...(detail ? { detail } : {}) }));
      if ((box.generation ?? 0) > 0 && !evidence.jobId) return;
      if (evidence.jobId && (!Number.isFinite(evidence.completedAt) || evidence.completedAt > this.now())) return;
      const threshold = Number(this.getEnv?.().VERIFICATION_FAILURE_THRESHOLD ?? 3);
      const change = await recordSizedBreakerOutcome(tx, { box, ok, at: evidence.jobId ? evidence.completedAt : this.now(), now: this.now(), threshold });
      if (change.opened) { const count = change.breaker.counts[box.size]; this.logger?.(JSON.stringify({ event: 'verification_breaker_trip', project: this.project?.id, size: box.size, failures: count })); await this.emit?.('alert_verification_breaker', null, { size: box.size, failures: count }, tx); }
      return change;
    });
    if (seen && Number.isFinite(recordedAt)) {
      if (seen.size >= 4096) seen.delete(seen.keys().next().value);
      seen.set(key, recordedAt + RETENTION);
    }
    if (change?.opened) this.alert?.('breaker_open', { value: 1, limit: 1, active: true });
    if (change?.cleared && !(await this.storage.get('verification:breaker'))?.tripped) this.alert?.('breaker_open', { value: 0, limit: 1, active: false });
  }

  // The only writer of a box's state: `event` names an edge of the box-state table; null means
  // the box was no longer in a source state of that edge and nothing was written.
  async transition(machineId, event, changes = {}, options = {}) {
    return this.storage.transaction(async tx => {
      const key = `box:${machineId}`, box = await tx.get(key);
      if (!box) return null;
      return applyTransition(tx, key, event, changes, this.now(), options);
    });
  }

  async stuckAlert(box, reason) {
    this.logger?.(JSON.stringify({ event: 'box_stuck', project: this.project?.id, machine_id: box.machineId, state: box.state, reason, since: box.since }));
    await this.emit?.('alert_box_stuck', null, { machine_id: box.machineId, phase: box.state, status: reason });
  }

  // A ready box is warm but disconnected. Reserve one runnable job before
  // registering its JIT runner. The registration may receive equivalent work;
  // a different queued job is then available to the next reservation.
  async reserveReady(machineId, offered = new Set()) {
    const before = await this.storage.get(`box:${machineId}`);
    const currentSnapshot = await this.storage.get('pool:snapshot');
    let verified = null;
    if (before?.state === 'ready' && !currentSnapshot?.complete && this.installation && typeof this.api.getJob === 'function') {
      const label = JSON.parse(before.pool)[1], hold = await this.storage.get(`pool:snapshot-hold:${label}`);
      if (!Number.isFinite(hold?.since) || this.now() - hold.since < 180_000) return null;
      const last = await this.storage.get('dispatch:snapshot-recovery-last');
      if (Number.isFinite(last) && this.now() - last < 120_000) return null;
      const existingLocals = await records(this.storage, 'local-runner:'), existingBoxes = await records(this.storage, 'box:');
      const occupied = new Set([
        ...existingLocals.filter(local => this.getEnv?.()?.CI_TO_MINIS !== 'false' && localOfferActive(local, this.now(), this.project.externalClaimer ?? this.project.localFirst)).map(local => local.jobId),
        ...existingBoxes.filter(box => box.machineId !== machineId && reservationActive(box, this.now())).map(box => box.dispatchJobId),
      ]);
      const candidates = (await records(this.storage, 'gh-job:')).filter(job => job.pool === before.pool && job.status === 'queued' && job.source === 'webhook' && !job.missing && !occupied.has(job.id) && !(this.project.workflowConcurrency ?? []).some(rule => matchesWorkflowRule(job, rule))).sort(laneComparator(this.now(), await this.lanesEnabled(this.project)));
      for (const job of candidates.slice(0, 10)) {
        try {
          const actual = await this.api.getJob({ repo: this.project.repo, installation: this.installation, id: job.id }, job.id);
          if (actual?.id === job.id && actual.status === 'queued' && !actual.runner_name) { verified = { id: job.id, observedAt: job.observedAt }; break; }
        } catch { /* Do not register without a confirmed queued job. */ }
      }
    }
    const evidence = placementEvidence(this.getLocalCapacity?.(), this.now(), this.getEnv?.()?.CI_TO_MINIS !== 'false');
    const lanesOn = await this.lanesEnabled(this.project);
    const reserveOrder = laneComparator(this.now(), lanesOn);
    const result = await this.storage.transaction(async tx => {
      const key = `box:${machineId}`, box = await tx.get(key);
      if (!box || box.state !== 'ready') return null;
      const snapshot = await tx.get('pool:snapshot');
      if (!snapshot?.complete && !verified) return null;
      const recoveryAt = !snapshot?.complete ? await tx.get('dispatch:snapshot-recovery-last') : null;
      if (Number.isFinite(recoveryAt) && this.now() - recoveryAt < 120_000) return null;
      const [jobs, locals, boxes] = await Promise.all([
        records(tx, 'gh-job:'), records(tx, 'local-runner:'), records(tx, 'box:')
      ]);
      const occupied = new Set([
        ...locals.filter(local => this.getEnv?.()?.CI_TO_MINIS !== 'false' && localOfferActive(local, this.now(), this.project.externalClaimer ?? this.project.localFirst)).map(local => local.jobId),
        ...boxes.filter(other => other.machineId !== machineId && reservationActive(other, this.now())).map(other => other.dispatchJobId),
      ]);
      const eligible = snapshot?.complete ? runnableDemand(jobs.filter(item => !item.missing), this.project.workflowConcurrency, true, { laneCaps: lanesOn }) : jobs.filter(item => item.id === verified.id && item.source === 'webhook' && item.observedAt === verified.observedAt && !item.missing);
      const job = eligible
        .filter(item => item.pool === box.pool && item.status === 'queued' && !occupied.has(item.id) && !offered.has(item.id))
        .sort(reserveOrder)[0];
      if (!job) return null;
      if (box.slowHost === true && slowBoxYields(box, job, boxes, this.now())) return null;
      const reserved = applyBoxEvent(box, 'reserve', { dispatchJobId: job.id, dispatchAt: this.now(), dispatchSource: job.source ?? null, dispatchRunId: job.runId ?? null, ...(job.lane ? { lane: job.lane } : {}) }, this.now());
      await tx.put(key, reserved);
      const queuedEvidence = await tx.get(`placement-queue:${job.id}`) ?? null;
      const placement = { at: this.now(), jobId: job.id, machineId, generation: box.generation ?? 0, boxCreatedAt: box.createdAt ?? null, bootDoneObservedAt: box.bootDoneObservedAt ?? null, boxReadyAt: box.timing?.ready ?? null, ...evidence, queuedEvidence };
      await tx.put(`placement:${job.id}`, placement);
      if (!snapshot?.complete) await tx.put('dispatch:snapshot-recovery-last', this.now());
      return reserved;
    });
    if (result) this.logger?.(JSON.stringify({ event: 'boat_job_reserved', project: this.project?.id, job_id: result.dispatchJobId, run_id: result.dispatchRunId, source: result.dispatchSource, machine_id: machineId, ...(result.lane ? { lane: result.lane } : {}), ...evidence }));
    return result;
  }

  // GitHub starts the held shards of a max-parallel matrix run in its own order and gives each one to any
  // idle runner with the label, so a reservation for such a shard stands for one slot of the run, not for one shard.
  // When the reserved shard is still held or started on another runner, the reservation moves to another queued,
  // unreserved shard of the same run (runnable shards first) and the runner stays registered; the box then takes
  // whichever shard GitHub starts next. Returns null (the caller fences as before) for a job outside every
  // `workflowConcurrency` rule, an incomplete snapshot, or a run with no free queued shard left.
  async retargetMatrixReservation(machineId, from) {
    const rules = (this.project?.workflowConcurrency ?? []).filter(rule => Number.isSafeInteger(rule?.maxParallel) && rule.maxParallel > 0);
    if (!rules.length) return null;
    try {
      const lanesOn = await this.lanesEnabled(this.project);
      const result = await this.storage.transaction(async tx => {
        const now = this.now(), key = `box:${machineId}`, box = await tx.get(key);
        if (box?.state !== from || !Number.isSafeInteger(box.dispatchJobId) || (await tx.get('pool:snapshot'))?.complete !== true) return null;
        const [jobs, locals, boxes] = await Promise.all([records(tx, 'gh-job:'), records(tx, 'local-runner:'), records(tx, 'box:')]);
        const target = jobs.find(job => job.id === box.dispatchJobId);
        const rule = target && Number.isSafeInteger(target.runId) ? rules.find(rule => matchesWorkflowRule(target, rule)) : null;
        if (!rule) return null;
        const occupied = new Set([
          ...locals.filter(local => this.getEnv?.()?.CI_TO_MINIS !== 'false' && localOfferActive(local, now, this.project.externalClaimer ?? this.project.localFirst)).map(local => local.jobId),
          ...boxes.filter(other => other.machineId !== machineId && reservationActive(other, now)).map(other => other.dispatchJobId),
        ]);
        const runnable = new Set(runnableDemand(jobs.filter(job => !job.missing), this.project.workflowConcurrency, true, { laneCaps: lanesOn }).filter(job => job.status === 'queued').map(job => job.id));
        const next = jobs.filter(job => job.pool === box.pool && job.runId === target.runId && job.status === 'queued' && !job.missing && matchesWorkflowRule(job, rule) && !occupied.has(job.id))
          .sort((a, b) => Number(runnable.has(b.id)) - Number(runnable.has(a.id)) || a.queuedAt - b.queuedAt || a.id - b.id)[0];
        if (!next) return null;
        const moved = applyBoxEvent(box, 'matrix_retarget', { dispatchJobId: next.id, dispatchAt: now, matrixRetargets: (box.matrixRetargets ?? 0) + 1 }, now);
        if (!moved) return null;
        await tx.put(key, moved);
        // The job-start hook reads `placement:<dispatchJobId>`; carry the box's placement evidence to the new shard.
        const placement = await tx.get(`placement:${box.dispatchJobId}`);
        if (placement && !await tx.get(`placement:${next.id}`)) await tx.put(`placement:${next.id}`, { ...placement, jobId: next.id, retargetedFrom: box.dispatchJobId, retargetedAt: now });
        return { moved, previous: box.dispatchJobId, runnable: runnable.has(next.id) };
      });
      if (result) this.logger?.(JSON.stringify({ event: 'matrix_reservation_retarget', project: this.project?.id, machine_id: machineId, from_job_id: result.previous, job_id: result.moved.dispatchJobId, runnable: result.runnable, state: from }));
      return result?.moved ?? null;
    } catch { return null; }
  }

  async failedBoot(box, reason, observed) {
    let diagnostic = { providerErrorCategory: 'unknown', captureStatus: 'unavailable', setupOutput: [], retryEligible: false };
    if (typeof this.api.setupDiagnostics === 'function') {
      try { diagnostic = await this.api.setupDiagnostics(box, observed); } catch { /* A failed capture must not block cleanup. */ }
    }
    const providerLimited = diagnostic.providerErrorCategory === 'rate_limited';
    if (providerLimited) await this.storage.put('startBackoffUntil', this.now() + 60_000);
    else await this.verificationOutcome(box, reason, false, diagnostic);
    let retry = null;
    if ((box.bootPath === 'snapshot' || (!box.setupRetry && !providerLimited && diagnostic.retryEligible === true)) && box.createKey && this.budget && box.pool && box.size) {
      const createKey = crypto.randomUUID();
      const routerCreateName = `boat-router-${(await this.budget.claimKey(createKey)).slice(0, 32)}`;
      retry = { pool: box.pool, size: box.size, createKey, routerCreateName, state: 'pending', at: this.now(), queuedAt: box.queuedAt ?? box.createdAt ?? this.now(), reusable: box.reusable === true, setupRetry: true, ...(box.bootPath === 'snapshot' ? { bootPath: 'plain_fallback', fallbackOf: box.createKey, fallbackAfterMachineId: box.machineId } : {}), ...(box.account ? { account: box.account } : this.createAccount ? { account: this.createAccount } : {}) };
    }
    const next = await this.storage.transaction(async tx => {
      const updated = await applyTransition(tx, `box:${box.machineId}`, providerLimited ? 'boot_failed' : reason === 'boot_timeout' ? 'boot_timeout' : 'boot_failed', { failureReason: providerLimited ? 'provider_limited' : reason, setupDiagnostic: diagnostic, ...(retry ? { retryCreateKey: retry.createKey } : {}) }, this.now());
      if (!updated) return null;
      if (providerLimited) await releaseSizedProbeInTransaction(tx, box.size, box.createKey);
      if (retry) await tx.put(`create:${retry.createKey}`, retry);
      return updated;
    });
    if (next && retry) await this.budget.enqueue(retry.createKey, retry.queuedAt, undefined, { pool: true });
    return next;
  }

  async stepBox(machineId, snapshot = {}, options = {}) {
    let box = await this.storage.get(`box:${machineId}`);
    if (!box) return;
    if (box.executor === 'direct' && options.executor !== 'direct') throw new Error('direct box requires direct executor');
    if (options.executor === 'direct' && box.executor !== 'direct') throw new Error('direct executor requires direct box');
    if (options.executor !== 'direct' && snapshot.complete === true && ['idle', 'busy'].includes(box.state)) {
      const runner = (snapshot.runners ?? []).find(item => item.name === box.runnerName);
      const inProgress = (snapshot.jobs ?? []).some(job => job.status === 'in_progress' && job.runnerName === box.runnerName);
      const completed = (snapshot.jobs ?? []).some(job => job.status === 'completed' && job.runnerName === box.runnerName);
      if (box.state === 'idle' && (runner?.busy || inProgress)) {
        if (!box.everOnline) await this.verificationOutcome(box, 'online', true);
        return this.transition(machineId, 'job_started', { online: runner?.status === 'online', everOnline: true });
      }
      if (box.state === 'idle' && completed && !inProgress) {
        if (!runner) box = await this.transition(machineId, 'job_finished', { runnerFenced: true, jobs: (box.jobs ?? 0) + 1 });
        else {
          const retiring = await this.transition(machineId, 'fence_after_job', { afterFence: 'finished' });
          if (retiring) await this.fenceRunner(retiring);
          return;
        }
      } else if (box.state === 'idle') {
        const online = runner?.status === 'online';
        if (online && !box.everOnline) await this.verificationOutcome(box, 'online', true);
        box = await this.transition(machineId, 'observe', { online, onlineAt: online ? box.onlineAt ?? this.now() : box.onlineAt, everOnline: box.everOnline || online, offlineSince: online ? null : box.offlineSince ?? (box.everOnline ? this.now() : box.startedAt ?? box.since) });
      } else if (!runner && !inProgress) {
        box = await this.transition(machineId, 'runner_gone', { runnerFenced: true, jobs: (box.jobs ?? 0) + 1 });
      } else if (!inProgress && (completed || (!runner?.busy && snapshot.at !== box.lastIdleSnapshotAt))) {
        const idleSnapshots = (box.idleSnapshots ?? 0) + 1;
        if (completed || idleSnapshots >= 2) {
          const retiring = await this.transition(machineId, 'fence_after_job', { afterFence: 'finished' });
          if (retiring) await this.fenceRunner(retiring);
          return;
        }
        box = await this.transition(machineId, 'busy_observed', { idleSnapshots, lastIdleSnapshotAt: snapshot.at });
      } else if (runner?.busy || inProgress) {
        box = await this.transition(machineId, 'busy_observed', { idleSnapshots: 0, runnerAbsentSince: runner ? null : box.runnerAbsentSince ?? this.now() });
      }
    }
    if (box.state !== 'booting' && await this.deadline(machineId, { ...options, snapshotComplete: snapshot.complete === true, snapshot })) return;
    box = await this.storage.get(`box:${machineId}`);
    if (box.state === 'busy' && Number.isFinite(box.createdAt) && Number.isFinite(options.ttlSeconds) && this.now() >= box.createdAt + options.ttlSeconds * 1000) {
      await this.transition(machineId, 'ttl_expired', { retirementReason: 'ttl_expired' });
      return this.destroy(machineId, { ttlExpired: true });
    }
    if (box.state === 'booting') {
      let result;
      try { result = await this.api.sandbox(box); }
      catch (error) {
        if (limited(error)) {
          await this.storage.put('startBackoffUntil', this.now() + Math.max(30_000, Math.min(900_000, (error.retrySeconds ?? 0) * 1000)));
          if (!Number.isFinite(box.bootLimitedAt)) await this.transition(machineId, 'boot_limited', { bootLimitedAt: this.now() });
          return;
        }
        if (!Number.isFinite(box.bootLimitedAt) && boxDeadline(box, this.now(), options) === 'boot_timeout') return this.failedBoot(box, 'boot_timeout', null);
        throw error;
      }
      if (Number.isFinite(box.bootLimitedAt)) {
        box = await this.transition(machineId, 'boot_resumed', { bootPausedMs: (box.bootPausedMs ?? 0) + Math.max(0, this.now() - box.bootLimitedAt), bootLimitedAt: null });
        if (!box) return;
      }
      if (result?.sandbox?.setupStatus === 'failed' || ['error', 'cancelled', 'archived', 'stopped'].includes(result?.sandbox?.state)) {
        return this.failedBoot(box, 'boot_failed', result);
      }
      if (result?.sandbox?.setupStatus !== 'done' || !['ready', 'idle', 'running'].includes(result?.sandbox?.state)) {
        if (boxDeadline(box, this.now(), options) === 'boot_timeout') return this.failedBoot(box, 'boot_timeout', result);
        return;
      }
      if (!box.reusable) return this.transition(machineId, 'boot_done', { bootDoneObservedAt: this.now() });
      box = await this.transition(machineId, 'baseline_start', { processId: null, bootDoneObservedAt: this.now() });
      if (!box) return;
      try {
        const result = box.resetMode === 'docker' ? await this.api.dockerBaseline(box) : await this.api.refresh(box, 'baseline', 0);
        if (!Number.isSafeInteger(result?.processId) || result.processId < 1) throw new Error('missing process');
        return this.transition(machineId, 'baseline_submitted', { processId: result.processId });
      } catch (error) { await this.verificationOutcome(box, 'baseline_failed', false, { step: 'submit baseline command', status: Number.isInteger(error?.status) ? error.status : null, code: error?.code ?? null }); return this.transition(machineId, 'baseline_failed', { failureReason: 'baseline_failed' }); }
    }
    if (box.state === 'baseline' && box.processId) {
      const result = box.resetMode === 'docker' ? await this.api.dockerBaselineResult(box, box.processId) : await this.api.refreshResult(box, box.processId, 0);
      if (result === null) return;
      if (result?.ok !== true || !/^[a-f0-9]{64}$/.test(result.baselineHash ?? '')) { await this.verificationOutcome(box, 'baseline_failed', false, box.resetMode === 'docker' ? { step: result?.step ?? 'baseline', exitCode: result?.exitCode ?? null, output: result?.output ?? '' } : { step: 'baseline', failed: result?.failed ?? null, diagnostic: result?.diagnostic ?? null }); return this.transition(machineId, 'baseline_failed', { failureReason: 'baseline_failed' }); }
      return this.transition(machineId, 'baseline_done', { baselineHash: result.baselineHash, generation: 0, ...(result.summary ? { baselineSummary: result.summary } : {}), ...(result.lazySettleSeconds !== undefined ? { baselineLazySettleSeconds: result.lazySettleSeconds } : {}) });
    }
    if (box.state === 'ready') {
      if (options.executor === 'direct') return this.transition(machineId, 'direct_online', { executor: 'direct', online: true, onlineAt: this.now(), everOnline: true });
      const timeouts = Object.values(this.project?.jobs ?? {}).map(job => job.timeoutMinutes ?? 0);
      const headroom = Math.max(300, 1200 + Math.max(0, ...timeouts) * 60);
      if (Number.isFinite(options.ttlSeconds) && Number.isFinite(box.createdAt) && timeouts.every(Number.isFinite) && this.now() - box.createdAt >= (options.ttlSeconds - headroom) * 1000) return this.transition(machineId, 'retire_ready', { retirementReason: 'ttl_headroom' });
      if (box.generation > 0 && box.resetMode === 'docker' && options.reuseEnabled !== true) return this.transition(machineId, 'retire_ready', { retirementReason: options.retirementReason ?? 'reuse_disabled' });
      // A reused box marked slow or failed by an earlier check (observe mode, or before this build) leaves service here
      // instead of serving another job .
      if ((box.generation ?? 0) > 0 && options.reuseHealthMode === 'enforce' && box.resetMode !== 'docker' && (box.slowHost === true || box.lastResetSummary?.health?.failed === true)) {
        this.logger?.(JSON.stringify({ event: 'reset_health_retire', project: this.project?.id, machine_id: box.machineId, generation: box.generation, reason: 'marked' }));
        return this.transition(machineId, 'retire_ready', { retirementReason: 'health_check' });
      }
      // Fresh-box health probe: once, before the first job. Enforce retires a failing box; observe and
      // any probe error keep it. A probe that cannot measure never retires a box.
      if ((box.generation ?? 0) === 0 && box.freshHealth === undefined && box.baselineHash && box.resetMode !== 'docker' && options.executor !== 'direct' && options.healthMode && typeof this.api.healthProbe === 'function') {
        let health = null;
        try { health = await this.api.healthProbe(box); } catch { health = null; }
        const failed = health?.measured === true && health.failed === true;
        if (failed) this.logger?.(JSON.stringify({ event: options.healthMode === 'enforce' ? 'fresh_health_retire' : 'fresh_health_observed_failure', project: this.project?.id, machine_id: box.machineId, health }));
        if (failed && options.healthMode === 'enforce') return this.transition(machineId, 'retire_ready', { retirementReason: 'health_check', freshHealth: health, ...healthFields(health) });
        box = await this.transition(machineId, 'fresh_health', { freshHealth: health ?? { measured: false }, ...healthFields(health) });
        if (!box) return;
      }
      if (this.project?.dispatchOnly === true) {
        box = await this.reserveReady(machineId, options.offered);
        if (!box) return;
      }
      let [repo, label] = JSON.parse(box.pool); const project = this.project?.id;
      if (!project || !this.installation) throw new Error('project identity missing');
      if (box.generation > 0) {
        let valid = repo === this.project.repo;
        try { const [originRepo] = JSON.parse(box.originPool); valid &&= originRepo === repo && (box.pool === box.originPool || (MACHINE_SIZES.includes(box.size) && MACHINE_SIZES.indexOf(box.size) >= MACHINE_SIZES.indexOf(poolSize(this.project, label)))); } catch { valid = false; }
        if (!valid) return this.transition(machineId, 'retire_ready', { failureReason: 'pool_mismatch' });
      }
      let labels = [label];
      if (box.generation > 0 && box.originPool && box.originPool !== box.pool && MACHINE_SIZES.indexOf(box.size) > MACHINE_SIZES.indexOf(poolSize(this.project, label))) {
        const [, originLabel] = JSON.parse(box.originPool);
        const snapshot = await this.storage.get('pool:snapshot');
        const jobs = await records(this.storage, 'gh-job:');
        if (!snapshot?.complete || largerDemandExpected(jobs, this.project, box.size, this.now())) {
          box = await this.transition(machineId, 'return_to_origin', { pool: box.originPool, ...(this.project?.dispatchOnly === true ? { dispatchJobId: null, dispatchAt: null } : {}) });
          if (!box) return;
          if (this.project?.dispatchOnly === true) return;
          [repo, label] = JSON.parse(box.pool); labels = [label];
        } else if (originLabel !== label) labels.push(originLabel);
      }
      // Every Boat runner of the tenant also carries the project's Boat labels, so a job
      // whose runs-on names a pool label plus a Boat label can land here and never on a mini runner.
      for (const extra of this.project?.boatLabels ?? []) if (!labels.includes(extra)) labels.push(extra);
      const runnerName = `boat-${project}-${machineId}-g${box.generation}`;
      box = await this.transition(machineId, 'register', { repo, installation: this.installation, label, labels, runnerName, runnerIdentity: runnerName, boxGeneration: true, routerReusable: box.reusable, ...(box.resetMode ? { routerResetMode: box.resetMode } : {}), runnerId: null, registrationRejected: false });
      if (!box) return;
      try {
        const configureAt = this.now();
        await this.api.configure(box, async runnerId => {
          await this.storage.transaction(async tx => {
            const current = await tx.get(`box:${machineId}`);
            if (current?.state !== 'registering' || current.runnerName !== runnerName) throw new Error('registration lost');
            await tx.put(`box:${machineId}`, applyBoxEvent(current, 'runner_registered', { runnerId, runnerRegisteredAt: this.now() }, this.now()));
            await tx.put(`runner:${runnerName}`, { kind: 'boat', machineId, generation: box.generation });
          });
        });
        const configureMs = this.now() - configureAt;
        box = await this.storage.get(`box:${machineId}`);
        if (!box?.runnerId) throw new Error('runner missing');
        if (this.project?.dispatchOnly === true) {
          const target = await this.storage.get(`gh-job:${box.dispatchJobId}`);
          const lost = reservationExpired(box, this.now()) ? 'reservation_timeout' : !target || target.status !== 'queued' ? 'fence_local' : null;
          // a matrix shard reservation moves to another queued shard of its run; the runner still starts.
          if (lost && !await this.retargetMatrixReservation(machineId, 'registering')) return this.transition(machineId, lost, lost === 'reservation_timeout' ? { reservationExpiredJobId: box.dispatchJobId } : {});
        }
        const startAt = this.now();
        const result = await this.api.start(box);
        if (result?.success === false) throw new Error('start failed');
        this.logger?.(JSON.stringify({ event: 'boat_runner_started', project, machine_id: machineId, job_id: box.dispatchJobId, run_id: box.dispatchRunId, source: box.dispatchSource, configure_ms: configureMs, start_ms: this.now() - startAt }));
        return this.transition(machineId, 'start', { startedAt: this.now(), online: false, everOnline: false, onlineAt: null, offlineSince: null });
      } catch (error) {
        const detail = box.generation > 0 ? { step: 're-register runner', exitCode: null, output: '', service: ['boat', 'github'].includes(error?.service) ? error.service : null, status: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : null } : undefined;
        await this.verificationOutcome(box, 'registration_uncertain', false, detail);
        const current = await this.storage.get(`box:${machineId}`);
        return this.transition(machineId, 'registration_failed', { failureReason: 'registration_uncertain', registrationRejected: registrationRejected(error, current) });
      }
    }
    if (box.state === 'finished') {
      const expectedFingerprint = box.resetMode === 'docker' ? this.project?.dockerProvisionerFingerprint : this.project?.provisionerFingerprint;
      if (expectedFingerprint && box.provisionerFingerprint !== expectedFingerprint) return this.transition(machineId, 'retire_finished', { retirementReason: 'provisioner_changed' });
      // GitHub lists a job's completion a few seconds after its runner leaves. A reusable box with no job
      // result yet waits for the listing before it is retired as `missing_job_result` (report B, box 519).
      if (options.missingResult === true && box.reusable && box.baselineHash && this.now() - box.since < MISSING_RESULT_GRACE_MS) return this.transition(machineId, 'await_result', { awaitingResultSince: box.awaitingResultSince ?? this.now() });
      if (!box.reusable || options.reuseEnabled !== true || !box.baselineHash) return this.transition(machineId, 'retire_finished', { retirementReason: options.retirementReason ?? 'reuse_ineligible' });
      const generation = box.generation + 1;
      box = await this.transition(machineId, 'reset_start', { generation, processId: null, localHoldRelease: false, awaitingResultSince: null });
      try {
        const result = box.resetMode === 'docker' ? await this.api.dockerReset(box, generation) : await this.api.lightReset({ ...box, minimumDiskKiB: this.project?.reuse?.diskFloorKiB?.[box.size], minimumHomeDiskKiB: this.project?.reuse?.homeDiskFloorKiB?.[box.size], healthMode: options.reuseHealthMode === 'enforce' ? 'enforce' : 'observe' }, generation);
        if (!Number.isSafeInteger(result?.processId) || result.processId < 1) throw new Error('missing process');
        return this.transition(machineId, 'reset_submitted', { processId: result.processId });
      } catch { await this.recordResetOutcome(box, false); await this.verificationOutcome(box, 'reset_failed', false, { step: 'submit reset command', exitCode: null, output: '' }); return this.transition(machineId, 'reset_failed', { failureReason: 'reset_failed' }); }
    }
    if (box.state === 'resetting' && box.processId) {
      let result;
      try { result = box.resetMode === 'docker' ? await this.api.dockerResetResult(box, box.processId, box.generation) : await this.api.lightResetResult(box, box.processId, box.generation); }
      catch { result = { ok: false, step: 'read reset result', exitCode: null, output: '' }; }
      if (result === null) return;
      if (result?.ok !== true) {
        if (result?.guard === 'disk') return this.transition(machineId, 'reset_failed', { retirementReason: 'disk_floor' });
        // A slow or crowded box is retired, not reused. It is not a reset fault, so it stays out of the
        // verification breaker and the reset success rate, like the disk floor.
        if (result?.guard === 'health') {
          this.logger?.(JSON.stringify({ event: 'reset_health_retire', project: this.project?.id, machine_id: box.machineId, generation: box.generation, ...(result.health ? { health: result.health } : {}) }));
          return this.transition(machineId, 'reset_failed', { retirementReason: 'health_check', ...(result.health ? { resetHealth: result.health, ...healthFields(result.health) } : {}) });
        }
        let kernel = null;
        if (result?.exitCode === 137 && box.resetMode !== 'docker' && typeof this.api.lightResetDiagnostics === 'function') {
          try { kernel = await this.api.lightResetDiagnostics(box); } catch { /* Keep failure handling independent of diagnostics. */ }
        }
        await this.recordResetOutcome(box, false);
        await this.verificationOutcome(box, 'reset_failed', false, { step: result?.step ?? 'read reset result', exitCode: result?.exitCode ?? null, output: result?.output ?? '', ...(result?.reason ? { reason: result.reason } : {}), ...(result?.details ? { details: result.details } : {}), ...(kernel ? { kernel } : {}) });
        return this.transition(machineId, 'reset_failed', { failureReason: 'reset_failed', ...(result?.step ? { resetFailedStep: result.step } : {}) });
      }
      await this.recordResetOutcome(box, true);
      if (result.summary?.health?.failed === true) this.logger?.(JSON.stringify({ event: 'reset_health_observed_failure', project: this.project?.id, machine_id: box.machineId, generation: box.generation, health: result.summary.health }));
      this.logger?.(JSON.stringify({ event: 'verification_result', project: this.project?.id, machine_id: box.machineId, kind: 'reset', phase: box.state, ok: true, ...(result.summary ? { summary: result.summary } : {}) }));
      return this.transition(machineId, 'reset_done', { runnerId: null, runnerName: null, runnerIdentity: null, runnerFenced: false, ...(result.summary ? { lastResetSummary: result.summary, ...healthFields(result.summary.health) } : {}) });
    }
    if (box.state === 'quarantined' && snapshot.complete === true) {
      if (await rejectedRegistrationAbsent(this.storage, box, snapshot, this.now())) {
        this.logger?.(JSON.stringify({ event: 'registration_rejection_released', project: this.project?.id, machine_id: machineId, generation: box.generation }));
        return this.transition(machineId, 'quarantine_release', { runnerFenced: true, retirementReason: 'registration_rejected' });
      }
      const prefix = box.orphan ? `boat-${this.project?.id}-${box.machineId}-g` : null;
      const matching = (snapshot.runners ?? []).filter(item => item.name === box.runnerName || (box.runnerId && item.id === box.runnerId) || (box.orphan && ((box.aliases ?? []).includes(item.name) || item.name?.startsWith(prefix))));
      if (matching.length > 1) return;
      const runner = matching[0];
      if (runner?.busy) return this.transition(machineId, 'job_started', { runnerId: runner.id, runnerName: runner.name, repo: box.repo ?? this.project?.repo, installation: box.installation ?? this.installation, everOnline: true });
      if (runner && Number.isSafeInteger(runner.id)) {
        const retiring = await this.transition(machineId, 'quarantine_runner_found', { runnerId: runner.id, runnerName: runner.name, repo: box.repo ?? this.project?.repo, installation: box.installation ?? this.installation });
        if (retiring) return this.fenceRunner(retiring);
      }
      if (box.runnerId) {
        const retiring = await this.transition(machineId, 'quarantine_runner_found', { repo: box.repo ?? this.project?.repo, installation: box.installation ?? this.installation });
        if (retiring) return this.fenceRunner(retiring);
      }
      // A missing sandbox cannot provide capacity or require Boat cleanup. Keep
      // ambiguous API failures quarantined until the provider confirms absence.
      if (typeof this.api.sandbox === 'function') {
        try { await this.api.sandbox(box); }
        catch (error) {
          if (error?.status === 404) return this.transition(machineId, 'sandbox_missing', { failureReason: 'sandbox_missing' });
        }
      }
      const running = box.orphan && (snapshot.jobs ?? []).some(job => job.status === 'in_progress' && ((box.aliases ?? []).includes(job.runnerName) || job.runnerName?.startsWith(prefix)));
      if (box.drainOnly && (box.orphan ? !running : box.noRunnerKnown) && !runner) return this.transition(machineId, 'quarantine_release', { runnerFenced: true });
    }
    if (box.state === 'retiring') return this.fenceRunner(box);
    if (box.state === 'destroying') return this.destroy(machineId, { ttlExpired: Number.isFinite(box.createdAt) && Number.isFinite(options.ttlSeconds) && this.now() >= box.createdAt + options.ttlSeconds * 1000 });
    if (box.state === 'unregister') {
      try { await this.api.removeRunner(box); } catch (error) { if (error.status !== 404) return; }
      return this.transition(machineId, 'unregistered', { runnerFenced: true });
    }
    if (box.state === 'purging') {
      if (!box.operationId) return this.transition(machineId, 'purged');
      const result = await this.api.deletion(box);
      if (result?.operation?.status === 'completed') return this.transition(machineId, 'purged');
      // After the purge deadline the sandbox read decides on its own: a 404 ends the record.
      if (box.runnerFenced === true && (result?.operation?.id === box.operationId || Number.isFinite(box.stuckAlertedAt)) && typeof this.api.sandbox === 'function') {
        try { await this.api.sandbox(box); }
        catch (error) {
          if (error?.status === 404) return this.transition(machineId, 'purged', { deletedBy: 'sandbox_404', deletionOperationId: box.operationId, deletionOperationStatus: result?.operation?.status ?? null });
        }
      }
    }
  }

  async deadline(machineId, options = {}) {
    const box = await this.storage.get(`box:${machineId}`);
    if (!box) return null;
    const reason = boxDeadline(box, this.now(), options);
    if (!reason) return null;
    if (reason === 'offline_timeout' && options.snapshotComplete !== true) return null;
    if (reason === 'quarantine_timeout') {
      if (options.snapshotComplete !== true) return null;
      const snapshot = options.snapshot ?? {};
      const prefix = box.orphan ? `boat-${this.project?.id}-${box.machineId}-g` : null;
      const matches = name => Boolean(name && (name === box.runnerName || (box.orphan && ((box.aliases ?? []).includes(name) || name.startsWith(prefix)))));
      if ((snapshot.runners ?? []).some(runner => (matches(runner.name) || (box.runnerId && runner.id === box.runnerId)) && runner.busy === true) || (snapshot.jobs ?? []).some(job => job.status === 'in_progress' && (matches(job.runnerName) || (box.runnerId && job.runnerId === box.runnerId)))) return null;
    }
    if (reason === 'reset_timeout') await this.recordResetOutcome(box, false);
    if (['baseline_timeout', 'registration_timeout', 'reset_timeout'].includes(reason)) await this.verificationOutcome(box, reason, false);
    switch (reason) {
      case 'offline_timeout': {
        const removed = await this.retire(machineId, 'offline_timeout');
        if (removed && !box.everOnline) await this.verificationOutcome(box, reason, false);
        break;
      }
      case 'registration_timeout': case 'baseline_timeout': case 'reset_timeout':
        await this.transition(machineId, reason, { failureReason: reason });
        break;
      case 'reuse_off':
        await this.transition(machineId, 'reuse_off', { failureReason: null });
        break;
      case 'quarantine_timeout':
        // The runner never became certain. The box leaves through `destroying`; a registered runner that
        // is never fenced holds it there until `destroy_timeout` forces the provider delete.
        if (await this.transition(machineId, 'quarantine_timeout', { failureReason: reason })) await this.stuckAlert(box, reason);
        break;
      case 'destroy_timeout':
        if (await this.transition(machineId, 'destroy_timeout', { forceDestroy: true, stuckAlertedAt: this.now() })) await this.stuckAlert(box, reason);
        break;
      case 'retire_timeout': case 'unregister_timeout': case 'purge_timeout':
        if (await this.transition(machineId, reason, { stuckAlertedAt: this.now() })) await this.stuckAlert(box, reason);
        break;
      default:
        throw new Error(`unhandled box deadline ${reason}`);
    }
    return reason;
  }

  // A webhook can record a queued job after the tick's demand snapshot, so the
  // last word before a box leaves is a fresh read of its pool's queued records.
  async queuedCount(box) {
    const prefix = box.executor === 'direct' ? 'direct:job:' : 'gh-job:';
    return (await records(this.storage, prefix)).filter(job => job.pool === box.pool && job.status === 'queued' && !job.missing).length;
  }

  async retire(machineId, retirementReason = null, { queuedSnapshot = null } = {}) {
    const box = await this.transition(machineId, 'retire_idle', { retirementReason });
    if (!box) return false;
    // A job that landed after the snapshot keeps a box whose runner is still
    // live; canceling the retirement is cheaper than paying a start for it.
    if (retirementReason === 'idle_hold_expired' && Number.isSafeInteger(queuedSnapshot) && box.reusable === true && box.runnerFenced !== true && !box.afterFence && (await this.queuedCount(box)) > queuedSnapshot) {
      if (await this.transition(machineId, 'retire_cancel', { retirementReason: null, afterFence: null, retargetPool: null })) {
        this.logger?.(JSON.stringify({ event: 'retire_cancel', project: this.project?.id, machineId, pool: box.pool }));
        return false;
      }
    }
    return this.fenceRunner(box);
  }

  async fenceRunner(box) {
    if (!Number.isSafeInteger(box.runnerId) || box.runnerId < 1) return false;
    try { await this.api.removeRunner(box); }
    catch (error) {
      if (error.status === 422) {
        await this.transition(box.machineId, 'fence_busy', { afterFence: null, retirementReason: null, retargetPool: null });
        return false;
      }
      if (error.status !== 404) return false;
    }
    return Boolean(await this.transition(box.machineId, box.afterFence === 'finished' ? 'fenced_finished' : 'fenced_destroy', { runnerFenced: true, afterFence: null, ...(box.retargetPool ? { pool: box.retargetPool, retargetPool: null, localHoldRelease: true } : {}), ...(box.afterFence === 'finished' && !box.retargetPool ? { jobs: (box.jobs ?? 0) + 1 } : {}) }));
  }

  async destroy(machineId, { ttlExpired = false } = {}) {
    const box = await this.storage.get(`box:${machineId}`);
    const forced = ttlExpired || box?.forceDestroy === true;
    if (!box || box.state !== 'destroying' || box.machineId !== machineId || box.runnerId && !box.runnerFenced && !forced) return false;
    let operation;
    try { operation = await this.api.destroy(box); }
    catch (error) { if (error.status !== 404) throw error; }
    if (operation && typeof operation.operation?.id !== 'string') return false;
    await this.transition(machineId, box.runnerId && !box.runnerFenced ? 'destroy_unregister' : 'destroy_requested', { operationId: operation?.operation?.id ?? null });
    return true;
  }
}
