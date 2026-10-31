import { safeLogger } from '../redact.mjs';
import { accounts, projects as projectDefinitions } from '../../config/installation.mjs';
import { Router } from './core.mjs';
import { SharedBudget } from './shared-budget.mjs';
import { PoolFleet } from './pool-fleet.mjs';
import { BoxFleet } from './box-fleet.mjs';
import { migrateProject } from './pool-migrate.mjs';
import { observe, reconcile } from './pool-observations.mjs';
import { records } from './pool-records.mjs';
import { BUILD_COMMIT } from '../build.mjs';
import { AlertHooks } from './alert-hooks.mjs';

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
  const account = { ...selected, requireConcurrency: true };
  const projects = getEnv().ROUTER_PROJECTS?.split(',').map(value => value.trim());
  if (projects && (projects.some(value => !value) || new Set(projects).size !== projects.length)) throw new TypeError('invalid router projects');
  const configurations = projectDefinitions.map(({ config, ...definition }) => ({ ...definition, config: account.projectAccounts?.includes(config.id) ? { ...config, account: account.id } : config })).filter(({ config, optIn }) => config.account === account.id && (!optIn || projects?.includes(config.id)) && (!projects || projects.includes(config.id)));
  if (projects && (configurations.length !== projects.length)) throw new TypeError('unknown router project');
  const schedule = promise => { try { waitUntil(promise.catch(() => {})); } catch {} };
  const alerts = new AlertHooks(storage, alertConfigs ?? account.alerts, getEnv, { now, waitUntil: schedule, deployment: BUILD_COMMIT, ...(alertFetcher ? { fetcher: alertFetcher } : {}) });
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
  const limits = cachedLimits(async () => { const value = await api.limits(); if ((alertConfigs ?? account.alerts)?.length) { try { observeLimits(value); } catch {} } return value; }, now);
  const scopedApi = Object.assign(Object.create(api), { limits });
  const projectEnv = (env, config) => ({ ...env, ...(config.machineTtlSeconds ? { MACHINE_TTL_SECONDS: String(config.machineTtlSeconds) } : {}), MAX_ACTIVE: String(config.caps?.concurrent ?? env.MAX_ACTIVE ?? 4), ...(account.starts ? { MAX_STARTS_PER_MINUTE: String(account.starts.minute), MAX_STARTS_PER_HOUR: String(account.starts.hour), MAX_STARTS_PER_DAY: String(account.starts.day) } : {}) });
  const observeProjects = async router => {
    const ledger = await storage.get(router.ledger.key);
    for (const project of router.projects.values()) {
      const id = project.config.id;
      const waiting = (ledger?.waiting ?? []).filter(item => item.project === id);
      const minutes = waiting.length ? Math.max(0, now() - Math.min(...waiting.map(item => item.at))) / 60_000 : 0;
      await alerts.observe('queue_wait', { project: id, value: minutes, limit: null });
    }
  };
  const routerProjects = configurations.map(({ config }) => {
    let poolController, migration;
    const poolFor = ({ storage: scoped, ledger }) => {
      const env = projectEnv(getEnv(), config);
      if (!poolController) {
        const budget = new SharedBudget(ledger, config.id, now);
        poolController = new PoolFleet(scoped, env, scopedApi, now, logger, { sharedBudget: budget, project: config });
        poolController.boxFleet = new BoxFleet(scoped, scopedApi, now, { budget, project: config, getEnv, emit: poolController.emit.bind(poolController), logger, alert: (event, data) => schedule(alerts.observe(event, { project: config.id, ...data }).catch(() => {})) });
      }
      poolController.env = env;
      return poolController;
    };
    const hooks = {};
    const ensureMigration = (ctx, controller) => {
      if (!migration) migration = migrateProject(ctx.storage, config, BUILD_COMMIT, now, controller.sharedBudget).finally(() => { migration = null; });
      return migration;
    };
    const preparePool = async (ctx, controller) => {
      await ensureMigration(ctx, controller);
      await ctx.ledger.clearLegacyWaiters(config.id);
      const installation = await ctx.storage.get('pool:installation') ?? config.installation ?? (await records(ctx.storage, 'job:')).find(job => job.repo === config.repo && Number.isSafeInteger(job.installation))?.installation ?? (await records(ctx.storage, 'webhook-pending:')).find(event => event.repo === config.repo && Number.isSafeInteger(event.installation))?.installation;
      controller.boxFleet.installation = installation;
      if (installation) await ctx.storage.put('pool:installation', installation);
      const last = await ctx.storage.get('pool:snapshot'), due = await ctx.storage.get('pool:snapshot-due'), first = !await ctx.storage.get('pool:first-snapshot');
      if (installation && (first || !last || now() - last.at >= 60000 || due && due <= now())) {
        if (await reconcile(ctx.storage, scopedApi, config, installation, now)) await ctx.storage.put('pool:first-snapshot', true);
        await ctx.storage.delete('pool:snapshot-due');
      }
      if (!await ctx.storage.get('pool:first-snapshot')) await ctx.storage.transaction(async tx => {
        await tx.put('pool:snapshot', { ...(await tx.get('pool:snapshot')), at: now(), complete: false });
        await tx.put('pool:snapshot-complete', false);
      });
      await ctx.storage.setAlarm(now() + 60000);
    };
    const ingestPool = async (event, ctx, source = 'webhook') => {
      const controller = poolFor(ctx);
      if (!['on', 'drain'].includes(await ctx.storage.get('pool:mode'))) {
        await ensureMigration(ctx, controller);
        await ctx.ledger.clearLegacyWaiters(config.id);
      }
      await ctx.storage.put('pool:installation', event.installation);
      await observe(ctx.storage, event, now(), source);
      if (event.status === 'in_progress' && event.runnerName) logger(JSON.stringify({ event: 'assignment', project: config.id, job_id: event.id, runner_name: event.runnerName }));
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
        await ctx.storage.put('verification:breaker', { counts: {}, tripped: false });
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
        const mode = await ctx.storage.get('pool:mode');
        const controller = poolFor(ctx);
        await preparePool(ctx, controller);
        return controller.boxFleet.tick({ mode: mode === 'on' ? 'on' : 'drain', env: controller.env, account, project: config, prepareOnly: true });
      } }),
      admissionEntries: async ctx => {
        const controller = poolFor(ctx);
        return controller.boxFleet.admissionEntries();
      }, admitStart: async (key, ctx) => {
        const controller = poolFor(ctx), mode = await ctx.storage.get('pool:mode');
        await controller.boxFleet.admitQueued(key, { mode: mode === 'on' ? 'on' : 'drain', env: controller.env, project: config, preparationFailed: ctx.startPreparationFailed });
      },
      tick: async ctx => {
        const mode = await ctx.storage.get('pool:mode');
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
        if (boxes.some(box => ['booting', 'baseline', 'resetting', 'ready'].includes(box.state))) await ctx.storage.setAlarm(now() + 10_000);
        return result;
      } };
  });
  const router = new Router(storage, account, routerProjects, { now });
  router.observeAlert = (id, event, active, previousActive) => schedule(alerts.observe(event, { project: id, value: active ? 1 : 0, limit: 1, active, previousActive }));
  if ((alertConfigs ?? account.alerts)?.length) {
    const runTick = router.runTick.bind(router);
    router.runTick = async () => {
      try { return await runTick(); }
      finally { schedule(observeProjects(router)); }
    };
  }
  return router;
}
