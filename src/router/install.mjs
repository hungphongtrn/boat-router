import { safeLogger } from '../redact.mjs';
import { accounts, projects as projectDefinitions } from '../../config/installation.mjs';
import { createHash } from 'node:crypto';
import { reuseBootstrap } from '../refresh.mjs';
import { dockerBootstrap } from '../bootstrap.mjs';
import { DOCKER_RESET_PROGRAM_SHA256 } from './docker-reset.mjs';
import { attachLane } from './lanes.mjs';
import { Router } from './core.mjs';
import { SharedBudget } from './shared-budget.mjs';
import { PoolFleet } from './pool-fleet.mjs';
import { BoxFleet, placementEvidence } from './box-fleet.mjs';
import { migrateProject } from './pool-migrate.mjs';
import { observe, reconcile, snapshotResumeAt } from './pool-observations.mjs';
import { records } from './pool-records.mjs';
import { BUILD_COMMIT } from '../build.mjs';
import { AlertHooks, queueWaitMinutes } from './alert-hooks.mjs';
import { APIs } from '../apis.mjs';
import { AccountLedger } from './ledger.mjs';
import { accountApi, cutoverBudget, externalCutoverLedger, tagCutoverRecords } from './account-cutover.mjs';

export function accountProject(config, account) {
  if (!account.projectAccounts?.includes(config.id)) return config;
  const cap = account.projects?.[config.id]?.poolConcurrent;
  const hold = account.projects?.[config.id]?.idleHoldSeconds;
  const workflowConcurrency = account.projects?.[config.id]?.workflowConcurrency;
  if (workflowConcurrency !== undefined && (!Array.isArray(workflowConcurrency) || workflowConcurrency.some(rule => !rule || ((typeof rule.workflow !== "string" || !rule.workflow) && (typeof rule.workflowPath !== "string" || !rule.workflowPath)) || typeof rule.jobPrefix !== "string" || !rule.jobPrefix || !Number.isSafeInteger(rule.maxParallel) || rule.maxParallel < 1))) throw new TypeError("invalid workflow concurrency");
  if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0)) throw new TypeError('invalid account project pool cap');
  if (hold !== undefined && (!Number.isSafeInteger(hold) || hold < 0)) throw new TypeError('invalid account project idle hold');
  return { ...config, ...(workflowConcurrency === undefined ? {} : { workflowConcurrency }), account: account.id, ...(cap === undefined ? {} : { caps: { ...config.caps, concurrent: cap } }), ...(hold === undefined ? {} : { reuse: { ...config.reuse, idleHoldSeconds: hold } }) };
}

export function recentLimits(read, now = Date.now, maxAgeMs = 5000) {
  let last = null;
  return async () => {
    if (last && now() - last.at < maxAgeMs && now() >= last.at) return structuredClone(last.value);
    const value = await read();
    last = { at: now(), value };
    return structuredClone(value);
  };
}

// One provider read serves all tenants of an account. Preserve the read's
// start time so later claims are not mistaken for provider-observed starts.
export function cachedLimits(read, now = Date.now) {
  let cached, expires = 0, pending;
  return async () => {
    if (pending) return pending;
    if (now() < expires) throw cached.error;
    const at = now();
    pending = (async () => {
      try {
        const value = { ...await read(), observedAt: at };
        expires = 0;
        return structuredClone(value);
      } catch (error) {
        const retryMs = Number.isFinite(error?.retrySeconds) ? Math.max(0, Math.min(900000, error.retrySeconds * 1000)) : 0;
        cached = { error }; expires = now() + Math.max(30000, retryMs);
        throw error;
      } finally { pending = null; }
    })();
    return pending;
  };
}

// This opt-in path remains experimental. Production defaults keep the legacy
// controller; all new projects share one ledger in this Durable Object.
export function installRouter(storage, getEnv, { api, now = Date.now, logger = console.log, waitUntil = () => {}, alertConfigs, alertFetcher }) {
  logger = safeLogger(logger);
  const wallet = getEnv().BOAT_WALLET;
  const selected = accounts.find(candidate => candidate.id === wallet);
  if (!selected) throw new TypeError('unknown router account');
  const provider = getEnv().BOAT_PROVIDER_WALLET;
  if (typeof provider !== 'string' || !provider.trim() || provider.trim() !== provider || provider === selected.id) throw new TypeError('invalid router provider wallet');
  let externalClients = {};
  try { externalClients = JSON.parse(getEnv().EXTERNAL_LEASE_CLIENTS ?? '{}'); } catch {}
  if (!externalClients || Array.isArray(externalClients) || typeof externalClients !== 'object') externalClients = {};
  // A client credential rotates through its own secret: EXTERNAL_LEASE_TOKEN_HASHES
  // maps a client name to the SHA-256 hex of its current token and replaces the
  // tokenHash inside EXTERNAL_LEASE_CLIENTS, whose other fields stay as installed.
  let tokenHashes = {};
  try { tokenHashes = JSON.parse(getEnv().EXTERNAL_LEASE_TOKEN_HASHES ?? '{}'); } catch {}
  if (tokenHashes && !Array.isArray(tokenHashes) && typeof tokenHashes === 'object') {
    for (const [name, tokenHash] of Object.entries(tokenHashes)) {
      if (!Object.hasOwn(externalClients, name) || !externalClients[name] || typeof externalClients[name] !== 'object' || !/^[a-f0-9]{64}$/.test(tokenHash ?? '')) continue;
      externalClients[name] = { ...externalClients[name], tokenHash };
    }
  }
  let leasePolicy = {};
  try { leasePolicy = JSON.parse(getEnv().EXTERNAL_LEASE_POLICY ?? '{}'); } catch {}
  if (leasePolicy && !Array.isArray(leasePolicy) && typeof leasePolicy === 'object') {
    for (const [name, policy] of Object.entries(leasePolicy)) {
      if (!Object.hasOwn(externalClients, name) || !externalClients[name] || !policy || Array.isArray(policy) || typeof policy !== 'object') continue;
      const overrides = {};
      if (policy.maxActive === null || (Number.isSafeInteger(policy.maxActive) && policy.maxActive > 0)) overrides.maxActive = policy.maxActive;
      if (typeof policy.warmReuse === 'boolean') overrides.warmReuse = policy.warmReuse;
      if (policy.startsPerDay === null) overrides.startsPerDay = null;
      if (policy.concurrencyReserve === 0) overrides.concurrencyReserve = 0;
      externalClients[name] = { ...externalClients[name], ...overrides };
    }
  }
  // Two Boat accounts as one pool: the primary account file names the secondary account (`secondaryAccount`).
  const secondaryAccount = selected.secondaryAccount ? accounts.find(candidate => candidate.id === selected.secondaryAccount) : null;
  if (selected.secondaryAccount && !secondaryAccount) throw new TypeError('unknown secondary account');
  const cutoverEnabled = getEnv().ACCOUNT_CUTOVER === 'true' && Boolean(secondaryAccount);
  let cutoverPolicy = {};
  if (cutoverEnabled) {
    try { cutoverPolicy = JSON.parse(getEnv().ACCOUNT_CUTOVER_POLICY); } catch { throw new TypeError('invalid account cutover policy'); }
    if (!cutoverPolicy || Array.isArray(cutoverPolicy) || typeof cutoverPolicy !== 'object' || cutoverPolicy.id || cutoverPolicy.ledgerKey !== `account:ledger:${selected.id}` ||
        !Number.isSafeInteger(cutoverPolicy.dayReserve) || cutoverPolicy.dayReserve < 0 || !Number.isSafeInteger(cutoverPolicy.poolPacing?.hardDayReserve) || cutoverPolicy.poolPacing.hardDayReserve < cutoverPolicy.dayReserve ||
        (cutoverPolicy.maxOwnedStartsPerDay !== undefined && (!Number.isSafeInteger(cutoverPolicy.maxOwnedStartsPerDay) || cutoverPolicy.maxOwnedStartsPerDay < 1)) || cutoverPolicy.forbidPaidStarts !== true || cutoverPolicy.poolPacing?.mode !== 'dynamic' || cutoverPolicy.poolPacing.enabled !== true) throw new TypeError('invalid account cutover policy');
  }
  if (cutoverPolicy.openStartQueue === true || (!cutoverEnabled && selected.openStartQueue === true)) {
    externalClients = Object.fromEntries(Object.entries(externalClients).map(([name, client]) => [name, { ...client, maxActive: null, startsPerDay: null, concurrencyReserve: 0 }]));
  }
  // Account-specific budgets apply to the selected ledger only.  The secondary
  // ledger below retains the authenticated client's original daily budget.
  const accountClients = { ...externalClients };
  if (cutoverEnabled && cutoverPolicy.openStartQueue !== true) {
    for (const [name, client] of Object.entries(accountClients)) {
      const budget = leasePolicy?.[name]?.primaryStartsPerDay;
      if (Number.isSafeInteger(budget) && budget >= 0) accountClients[name] = { ...client, startsPerDay: budget };
    }
  }
  const account = { ...selected, ...cutoverPolicy, requireConcurrency: true, externalClients: accountClients };
  if (selected.starts?.allowPaidExtra !== undefined && typeof selected.starts.allowPaidExtra !== 'boolean') throw new TypeError('invalid paid extra starts');
  if (selected.starts?.paidExtraMaxDollarsPerMonth !== undefined && (!Number.isFinite(selected.starts.paidExtraMaxDollarsPerMonth) || selected.starts.paidExtraMaxDollarsPerMonth < 0)) throw new TypeError('invalid paid extra budget');
  const provisionerFingerprint = createHash('sha256').update(reuseBootstrap()).update('\0').update(getEnv().TOOLCHAIN_REVISION ?? 'default').digest('hex');
  const snapshotName = getEnv().PROJECT_SNAPSHOT_NAME, snapshotManifest = getEnv().PROJECT_SNAPSHOT_MANIFEST_SHA256;
  if ((snapshotName || snapshotManifest) && (!/^[a-z][a-z0-9-]{0,40}-\d{8}-[a-f0-9]{8,64}$/.test(snapshotName ?? '') || !/^[a-f0-9]{64}$/.test(snapshotManifest ?? ''))) throw new TypeError('invalid project snapshot configuration');
  const snapshotFingerprint = snapshotName ? createHash('sha256').update(provisionerFingerprint).update('\0').update(snapshotName).update('\0').update(snapshotManifest).digest('hex') : provisionerFingerprint;
  // Docker-reset boxes use the Docker Actions bootstrap; a change to it or to the reset program retires them at their next finish.
  const dockerProvisionerFingerprint = createHash('sha256').update(dockerBootstrap()).update('\0').update(DOCKER_RESET_PROGRAM_SHA256).update('\0').update(getEnv().TOOLCHAIN_REVISION ?? 'default').digest('hex');
  const projects = getEnv().ROUTER_PROJECTS?.split(',').map(value => value.trim());
  if (projects && (projects.some(value => !value) || new Set(projects).size !== projects.length)) throw new TypeError('invalid router projects');
  const configurations = projectDefinitions.map(({ config, ...definition }) => ({ ...definition, config: accountProject({ ...config, provisionerFingerprint: config.snapshotBoot === true ? snapshotFingerprint : provisionerFingerprint, dockerProvisionerFingerprint }, account) }))
    .filter(({ config, optIn }) => config.account === account.id && (!optIn || projects?.includes(config.id)) && (!projects || projects.includes(config.id)))
    .map(definition => {
      if (account.openStartQueue !== true) return definition;
      const { concurrent, startsPerDay, ...caps } = definition.config.caps ?? {};
      // The open start queue has no per-project cap or lane reserve. `workflowConcurrency` stays: it models
      // GitHub's own max-parallel hold, so a held matrix shard does not get a box of its own.
      return { ...definition, config: { ...definition.config, caps, lanes: [] } };
    });
  if (projects && (configurations.length !== projects.length)) throw new TypeError('unknown router project');
  const cutover = cutoverEnabled;
  const workApi = cutover ? new APIs({ ...getEnv(), BOAT_CI_API_KEY: getEnv().BOAT_WORK_API_KEY }, api.fetch, now, api.credentials) : api;
  const secondaryApi = cutover ? new APIs({ ...getEnv(), BOAT_PROVIDER_WALLET: getEnv().BOAT_SECONDARY_PROVIDER_WALLET }, api.fetch, now, api.credentials) : api;
  if (cutover && (!getEnv().BOAT_WORK_API_KEY || !getEnv().BOAT_SECONDARY_PROVIDER_WALLET)) throw new TypeError('missing account cutover configuration');
  // secondary is the second account of one open pool. It keeps the same money rule as
  // primary (no paid start) and has no reserve and no project cap.
  const secondaryLedger = cutover ? new AccountLedger(storage, { ...secondaryAccount, requireConcurrency: true, externalClients, forbidPaidStarts: true, ...(cutoverPolicy.openStartQueue === true ? { openStartQueue: true, dayReserve: 0 } : {}) }, now) : null;
  // secondary copies of the lease and browser bases (same name and content, own snapshot id).
  const secondaryBases = () => {
    const env = getEnv(), id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
    return Object.fromEntries([['lease-v1', env.LEASE_BASE_SNAPSHOT_NAME, env.LEASE_BASE_SNAPSHOT_ID_SECONDARY], ['browser-v1', env.BROWSER_BASE_SNAPSHOT_NAME, env.BROWSER_BASE_SNAPSHOT_ID_SECONDARY]]
      .filter(([, name, snapshotId]) => name && id.test(snapshotId ?? '')).map(([kind, name, snapshotId]) => [kind, { name, snapshotId }]));
  };
  let poolOptions = null;
  if (cutover && getEnv().ACCOUNT_POOL_POLICY) {
    let policy;
    try { policy = JSON.parse(getEnv().ACCOUNT_POOL_POLICY); } catch { throw new TypeError('invalid account pool policy'); }
    if (!policy || typeof policy !== 'object' || Array.isArray(policy) || typeof policy.accounts?.secondary?.enabled !== 'boolean' || typeof policy.accounts?.primary?.enabled !== 'boolean') throw new TypeError('invalid account pool policy');
    poolOptions = { secondaryEnabled: policy.accounts.secondary.enabled, workEnabled: policy.accounts.primary.enabled, allowPaidExtra: account.starts?.allowPaidExtra === true, secondaryLimits: cachedLimits(() => secondaryApi.limits(), now),
      secondaryBase: lease => { const base = secondaryBases()[lease?.routerSnapshot?.kind]; return base && base.name === lease.routerSnapshot?.name ? base : null; },
      // Which accounts hold the snapshot a project boots from; the other account's boxes would boot plain.
      snapshotAccounts: project => {
        const env = getEnv();
        return configurations.find(({ config }) => config.id === project)?.config.snapshotBoot === true && env.PROJECT_SNAPSHOT_NAME ? { primary: true, secondary: Boolean(env.PROJECT_SNAPSHOT_NAME_SECONDARY) } : null;
      } };
  }
  const accountLimitsApi = workApi;
  const schedule = promise => { try { waitUntil(promise.catch(() => {})); } catch {} };
  const configuredAlerts = alertConfigs ?? account.alerts;
  const alerts = new AlertHooks(storage, configuredAlerts, getEnv, { now, waitUntil: schedule, deployment: BUILD_COMMIT, ...(alertFetcher ? { fetcher: alertFetcher } : {}) });
  const observeLimits = value => {
    for (const [event, name] of [['starts_day', 'day'], ['starts_hour', 'hour']]) {
      const counter = value.starts?.[name];
      if (Number.isFinite(counter?.used) && Number.isFinite(counter?.limit)) schedule(alerts.observe(event, { value: counter.used, limit: counter.limit }));
    }
    if (Number.isFinite(value.activeSandboxes) && Number.isFinite(value.maxActiveSandboxes)) schedule(alerts.observe('sandboxes', { value: value.activeSandboxes, limit: value.maxActiveSandboxes }));
    const hours = value.planIncluded;
    if (Number.isFinite(hours?.vmHours) && Number.isFinite(hours?.vmHoursRemaining)) schedule(alerts.observe('hours', { value: hours.vmHours - hours.vmHoursRemaining, limit: hours.vmHours, window: hours.periodEnd }));
    const day = value.starts?.day;
    if (Number.isFinite(day?.used) && Number.isFinite(day?.limit)) schedule(alerts.observe('day_cap_hit', { value: day.used, limit: day.limit, active: day.used >= day.limit }));
  };
  const limits = cachedLimits(async () => { const value = await accountLimitsApi.limits(); if (configuredAlerts?.length) { try { observeLimits(value); } catch {} } return value; }, now);
  // The account choice may use a read up to 5 s old; each admission still reads its account's limits fresh.
  if (poolOptions) Object.assign(poolOptions, { workLimits: recentLimits(limits, now), secondaryChoiceLimits: recentLimits(poolOptions.secondaryLimits, now) });
  const scopedApi = Object.assign(Object.create(workApi), { limits });
  const projectEnv = (env, config) => ({ ...env, OPEN_START_QUEUE: account.openStartQueue === true ? 'true' : 'false', ...(config.machineTtlSeconds ? { MACHINE_TTL_SECONDS: String(config.machineTtlSeconds) } : {}), MAX_ACTIVE: String(config.caps?.concurrent ?? env.MAX_ACTIVE ?? 4), ...(account.starts ? { MAX_STARTS_PER_MINUTE: String(account.starts.minute), MAX_STARTS_PER_HOUR: String(account.starts.hour), MAX_STARTS_PER_DAY: String(account.starts.day) } : {}) });
  const observeProjects = async router => {
    const ledger = await storage.get(router.ledger.key);
    for (const project of router.projects.values()) {
      const id = project.config.id;
      const waiting = (ledger?.waiting ?? []).filter(item => item.project === id);
      const jobs = [];
      const minutes = queueWaitMinutes(waiting, jobs, now());
      await alerts.observe('queue_wait', { project: id, value: minutes, limit: null });
    }
  };
  let router;
  const routerProjects = configurations.map(({ config }) => {
    let poolController, migration;
    const poolFor = ({ storage: scoped, ledger }) => {
      const env = projectEnv(getEnv(), config);
      if (!poolController) {
        const budget = cutover ? cutoverBudget(scoped, secondaryLedger, ledger, config.id, now, poolOptions) : new SharedBudget(ledger, config.id, now);
        const poolApi = cutover ? accountApi(scoped, secondaryApi, scopedApi) : scopedApi;
        poolController = new PoolFleet(scoped, env, poolApi, now, logger, { sharedBudget: budget, project: config });
        poolController.boxFleet = new BoxFleet(scoped, poolApi, now, { budget, project: config, countLeaseStarts: async () => (await records(storage, 'external-lease:')).filter(lease => lease.project === config.id && lease.state === 'starting').length, ...(cutover ? { createAccount: 'primary' } : {}), getEnv, getLocalCapacity: () => router?.localCapacity, emit: poolController.emit.bind(poolController), logger, alert: (event, data) => schedule(alerts.observe(event, { project: config.id, ...data }).catch(() => {})) });
      }
      poolController.env = env;
      return poolController;
    };
    const hooks = {};
    // A tenant may declare that its pool is on from the first tick;
    // the operator can still drain it through /router/pool-mode.
    const poolMode = async ctx => {
      const mode = await ctx.storage.get('pool:mode');
      if (mode !== undefined || config.poolModeDefault !== 'on') return mode;
      await ctx.storage.put('pool:mode', 'on');
      logger(JSON.stringify({ event: 'pool_mode_default', project: config.id, mode: 'on' }));
      return 'on';
    };
    const ensureMigration = (ctx, controller) => {
      if (!migration) migration = migrateProject(ctx.storage, config, BUILD_COMMIT, now, controller.sharedBudget).finally(() => { migration = null; });
      return migration;
    };
    const preparePool = async (ctx, controller) => {
      if (cutover) await tagCutoverRecords(ctx.storage, controller.sharedBudget);
      await ensureMigration(ctx, controller);
      await ctx.ledger.clearLegacyWaiters(config.id);
      const creates = await records(ctx.storage, 'create:');
      const createKeys = creates.map(item => item.createKey);
      const eligible = new Set((await controller.boxFleet.admissionEntries()).map(item => item.key));
      const hashes = await Promise.all(createKeys.filter(key => eligible.has(key)).map(key => controller.sharedBudget.claimKey(key)));
      await ctx.ledger.clearOrphanPoolWaiters(config.id, createKeys, hashes);
      if (poolOptions) {
        const secondaryHashes = await Promise.all(creates.filter(item => item.account === 'secondary' && eligible.has(item.createKey)).map(item => controller.sharedBudget.claimKey(item.createKey)));
        await secondaryLedger.clearOrphanPoolWaiters(config.id, createKeys, secondaryHashes);
      }
      const installation = await ctx.storage.get('pool:installation') ?? config.installation ?? (await records(ctx.storage, 'job:')).find(job => job.repo === config.repo && Number.isSafeInteger(job.installation))?.installation ?? (await records(ctx.storage, 'webhook-pending:')).find(event => event.repo === config.repo && Number.isSafeInteger(event.installation))?.installation;
      controller.boxFleet.installation = installation;
      if (installation) await ctx.storage.put('pool:installation', installation);
      const last = await ctx.storage.get('pool:snapshot'), due = await ctx.storage.get('pool:snapshot-due'), first = !await ctx.storage.get('pool:first-snapshot');
      if (installation && (first || !last || now() - last.at >= 60000 || due && due <= now())) {
        if (await reconcile(ctx.storage, scopedApi, config, installation, now)) await ctx.storage.put('pool:first-snapshot', true);
        await ctx.storage.delete('pool:snapshot-due');
        const current = await ctx.storage.get('pool:snapshot');
        const resumeAt = snapshotResumeAt(current, now());
        if (resumeAt !== null) {
          await ctx.storage.put('pool:snapshot-due', resumeAt);
          await ctx.storage.setAlarm(resumeAt);
        }
      }
      if (!await ctx.storage.get('pool:first-snapshot')) await ctx.storage.transaction(async tx => {
        await tx.put('pool:snapshot', { ...(await tx.get('pool:snapshot')), at: now(), complete: false });
        await tx.put('pool:snapshot-complete', false);
      });
      await ctx.storage.setAlarm(now() + 60000);
    };
    const ingestPool = async (event, ctx, source = 'webhook') => {
      const controller = poolFor(ctx);
      if (!['on', 'drain'].includes(await poolMode(ctx))) {
        await ensureMigration(ctx, controller);
        await ctx.ledger.clearLegacyWaiters(config.id);
      const creates = await records(ctx.storage, 'create:');
      const createKeys = creates.map(item => item.createKey);
      const hashes = await Promise.all(createKeys.map(key => controller.sharedBudget.claimKey(key)));
      await ctx.ledger.clearOrphanPoolWaiters(config.id, createKeys, hashes);
      }
      await ctx.storage.put('pool:installation', event.installation);
      // a webhook event carries no run name; look the run up once per run so the job's lane is known at once.
      if (source === 'webhook' && event.status === 'queued') event = await attachLane(ctx.storage, scopedApi, config, event, now());
      await observe(ctx.storage, event, now(), source);
      if (event.status === 'queued' && !await ctx.storage.get(`placement-queue:${event.id}`)) {
        const evidence = placementEvidence(router?.localCapacity, now(), getEnv().CI_TO_MINIS !== 'false');
        await ctx.storage.put(`placement-queue:${event.id}`, { at: now(), ...evidence, ...(evidence.reason === 'no_claim_in_time' ? { reason: 'queue_observation' } : {}) });
      }
      if (event.status === 'in_progress' && event.runnerName) {
        logger(JSON.stringify({ event: 'assignment', project: config.id, job_id: event.id, runner_name: event.runnerName }));
        if (event.runnerName.startsWith('boat-')) {
          const owner = await ctx.storage.get(`runner:${event.runnerName}`);
          const box = owner?.machineId ? await ctx.storage.get(`box:${owner.machineId}`) : null;
          const placement = box?.runnerName === event.runnerName && Number.isSafeInteger(box.dispatchJobId) ? await ctx.storage.get(`placement:${box.dispatchJobId}`) : null;
          if (placement) await ctx.storage.put(`placement:${event.id}`, { ...placement, jobId: event.id, ...(box.dispatchJobId !== event.id ? { reservedJobId: box.dispatchJobId } : {}), runnerRegisteredAt: box.runnerRegisteredAt ?? null, runnerStartRequestedAt: box.startedAt ?? null, runnerOnlineObservedAt: box.onlineAt ?? null, assignmentObservedAt: placement.assignmentObservedAt ?? now(), jobStartedAt: event.startedAt ?? placement.jobStartedAt ?? null });
          if (!placement && !await ctx.storage.get(`placement:${event.id}`)) await ctx.storage.put(`placement:${event.id}`, { at: now(), jobId: event.id, machineId: owner?.machineId ?? null, reason: 'no_reservation_evidence', categories: [], capacity: null });
        }
      }
      if (controller.localFleet) await controller.localFleet.ingest(event);
      if (event.status === 'queued') await ctx.storage.put('pool:snapshot-due', now() + 5000);
      await controller.wake(1000);
    };
    return { config, hooks, ingest: async (event, ctx) => {
      return ingestPool(event, ctx);
    },
      ...({ resync: (event, ctx) => ingestPool(event, ctx, 'resync') }),
      ...({ local: ctx => poolFor(ctx).localFleet }),
      ...({ box: ctx => poolFor(ctx).boxFleet }),
      ...({ resetVerificationBreaker: async ctx => {
        await ctx.storage.put('verification:breaker', { counts: {}, tripped: false, epoch: crypto.randomUUID() });
        logger(JSON.stringify({ event: 'verification_breaker_clear', project: config.id }));
        await poolFor(ctx).wake();
      } }),
      ...({ release: async (id, ctx) => {
        const controller = poolFor(ctx);
        await ensureMigration(ctx, controller);
        const archived = await ctx.storage.get(`legacy:job:${id}`);
        const live = await ctx.storage.get(`job:${id}`), job = live ?? archived?.value;
        if (job?.phase === 'attention') {
          const recovered = await controller.operatorRecoverArchivedAttention(id);
          if (recovered) await controller.wake();
          return recovered;
        }
        if (!job?.createPending || job.machineId) return false;
        const claim = await controller.sharedBudget.claim(job.createKey);
        if (!claim || claim.status === 'created') return false;
        if (!await controller.sharedBudget.settle(job.createKey, 'not_created')) return false;
        if (archived && !live) {
          await ctx.storage.delete(`create:${job.createKey}`);
          await ctx.storage.put(`legacy:job:${id}`, { ...archived, value: { ...job, createPending: false, createAttemptedAt: null, nextAt: now() + 60_000 } });
          await controller.wake();
          return true;
        }
        await controller.release(job);
        await controller.patch(id, { createPending: false, createAttemptedAt: null, nextAt: now() + 60_000 });
        await controller.wake();
        return true;
      } }),
      ...({ prepare: async ctx => {
        const mode = await poolMode(ctx);
        const controller = poolFor(ctx);
        await preparePool(ctx, controller);
        return controller.boxFleet.tick({ mode: mode === 'on' ? 'on' : 'drain', env: controller.env, account, project: config, prepareOnly: true });
      } }),
      admissionEntries: async ctx => {
        const controller = poolFor(ctx);
        return controller.boxFleet.admissionEntries();
      }, admitStart: async (key, ctx) => {
        const controller = poolFor(ctx), mode = await poolMode(ctx);
        await controller.boxFleet.admitQueued(key, { mode: mode === 'on' ? 'on' : 'drain', env: controller.env, project: config, preparationFailed: ctx.startPreparationFailed });
      },
      tick: async ctx => {
        const mode = await poolMode(ctx);
        const controller = poolFor(ctx);
        {
          const override = await ctx.storage.get('reuse:override');
          controller.poolProject = override === 'off' ? { ...config, reuse: { ...config.reuse, mode: 'off' } } : config;
          controller.startPreparationFailed = ctx.startPreparationFailed;
        }
        if (!(await ctx.storage.get('pool:migrated'))?.done) return;
        if (controller.localFleet) await controller.localFleet.sweep();
        const result = await controller.boxFleet.tick({ mode: mode === 'on' ? 'on' : 'drain', env: controller.env, account, project: controller.poolProject, preprepared: true, preparationFailed: ctx.startPreparationFailed, skipAdmission: ctx.globalAdmission === true });
        const boxes = await records(ctx.storage, 'box:');
        if (boxes.some(box => ['booting', 'baseline', 'resetting', 'ready', 'finished', 'local-fencing', 'local-held', 'lease-booting', 'lease-baselining', 'lease-resetting', 'lease-returning'].includes(box.state))) await ctx.storage.setAlarm(now() + 10_000);
        return result;
      } };
  });
  router = new Router(storage, account, routerProjects, { now });
  router.accountLimits = limits;
  if (cutover) {
    if (poolOptions) router.accountPools = {
      secondary: { ledger: secondaryLedger, limits: poolOptions.secondaryLimits, enabled: poolOptions.secondaryEnabled },
      primary: { ledger: router.ledger, limits, enabled: poolOptions.workEnabled },
    };
    const rootBoxLookup = { get: async key => {
      for (const project of router.projects.values()) {
        const box = await project.storage.get(key);
        if (box) return box;
      }
      return null;
    } };
    router.externalApi = accountApi(rootBoxLookup, secondaryApi, scopedApi);
    router.externalLedger = externalCutoverLedger(secondaryLedger, router.ledger, poolOptions, now);
    router.externalCreateAccount = 'primary';
    if (poolOptions?.secondaryEnabled) router.secondaryBases = secondaryBases;
  }
  router.observeAlert = (id, event, active, previousActive) => schedule(alerts.observe(event, { project: id, value: active ? 1 : 0, limit: 1, active, previousActive }));
  if (configuredAlerts?.length) {
    const runTick = router.runTick.bind(router);
    router.runTick = async () => {
      try { return await runTick(); }
      finally { schedule(observeProjects(router)); }
    };
  }
  return router;
}
