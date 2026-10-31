import { plan, poolKey, poolSize, uncovered } from './pool.mjs';
import { records } from './pool-records.mjs';
import { isPlanRefusal, isSizeRefusal } from '../domain.mjs';
import { prunePool } from './pool-prune.mjs';
import { waitClaims } from './wait-for-busy.mjs';

export function boxDeadline(box, now, { reuseEnabled = true } = {}) {
  const age = now - box.since;
  if (box.state === 'booting' && age >= 900_000) return 'boot_timeout';
  if (box.state === 'baseline' && age >= 300_000) return 'baseline_timeout';
  if (box.state === 'registering' && age >= 120_000) return 'registration_timeout';
  if (box.state === 'idle' && !box.busy && !box.online && now - (box.offlineSince ?? box.startedAt ?? box.since) >= 120_000) return 'offline_timeout';
  if (box.state === 'resetting' && !reuseEnabled) return 'reuse_off';
  if (box.state === 'resetting' && age >= 300_000) return 'reset_timeout';
  return null;
}

export class BoxFleet {
  constructor(storage, api, now = Date.now, options = {}) { Object.assign(this, { storage, api, now, ...options }); }

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

  async prepare(pool, size, count, queuedAt, reusable = false) {
    if (!this.budget || !Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid admission');
    const created = [];
    for (let i = 0; i < count; i++) {
      const createKey = crypto.randomUUID();
      const routerCreateName = `boat-router-${(await this.budget.claimKey(createKey)).slice(0, 32)}`;
      const record = { pool, size, createKey, routerCreateName, state: 'pending', at: this.now(), queuedAt, reusable };
      await this.storage.put(`create:${createKey}`, record);
      await this.budget.enqueue(createKey, queuedAt, undefined, { pool: true });
      created.push(record);
    }
    return created;
  }

  async admit(createKey, limits, ttl, epoch = '0') {
    const key = `create:${createKey}`;
    let record = await this.storage.get(key);
    if (!record) return false;
    let claim = await this.budget.claim(createKey);
    if (!claim) {
      const result = await this.budget.admit(createKey, limits, { queuedAt: record.queuedAt, pool: true });
      if (!result.ok) {
        this.logger?.(JSON.stringify({ event: 'admission_refused', project: this.project?.id, reason: result.reason ?? 'refused' }));
        const label = JSON.parse(record.pool)[1], statusKey = `pool:status:${label}`, status = await this.storage.get(statusKey);
        if (status) await this.storage.put(statusKey, { ...status, reason: `ledger:${result.reason ?? 'refused'}` });
        return false;
      }
      claim = await this.budget.claim(createKey);
      this.logger?.(JSON.stringify({ event: 'create_claim', project: this.project?.id, size: record.size, status: claim?.status ?? 'missing' }));
    }
    let sandbox;
    if (claim?.status !== 'pending') {
      sandbox = await this.api.findCreated(record);
      if (!sandbox) {
        if (claim?.status !== 'created' && this.now() - (claim?.callingAt ?? record.at) >= 300_000) {
          if (await this.budget.settle(createKey, 'not_created')) await this.storage.delete(key);
        }
        return false;
      }
    } else {
      if (!await this.budget.begin(createKey)) return false;
      record = { ...record, state: 'calling', callingAt: this.now() };
      await this.storage.put(key, record);
      try {
        const result = await this.api.create({ ...record, machineSize: record.size, routerReusable: record.reusable }, ttl);
        sandbox = result?.sandbox;
        if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox?.id ?? '')) throw new Error('invalid sandbox');
      } catch (error) {
        this.alert?.('create_failures', { value: 1, limit: 1, active: true });
        if (error?.service === 'boat' && [429, 503].includes(error.status)) {
          const delay = Math.max(30_000, Math.min(900_000, (error.retrySeconds ?? 0) * 1000));
          await this.storage.put('startBackoffUntil', this.now() + delay);
        }
        if (error && isSizeRefusal(error)) await this.storage.put(`size-block:${record.size}`, { epoch, at: this.now(), status: error.status });
        if (error && isPlanRefusal(error)) await this.storage.put('blocked', { epoch, at: this.now(), status: error.status });
        const refused = error?.service === 'boat' && ((error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status)) || error.code === 'request_not_sent');
        if (refused && await this.budget.settle(createKey, 'not_created')) await this.storage.delete(key);
        else { await this.budget.settle(createKey, 'unknown'); await this.storage.put(key, { ...record, state: 'unknown' }); }
        return false;
      }
    }
    if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox?.id ?? '')) throw new Error('invalid sandbox');
    this.alert?.('create_failures', { value: 0, limit: 1, active: false });
    if (!await this.budget.settle(createKey, 'created')) return false;
    this.logger?.(JSON.stringify({ event: 'create', project: this.project?.id, machine_id: sandbox.id, size: record.size }));
    return this.storage.transaction(async tx => {
      const current = await tx.get(key);
      if (!current) return false;
      const boxKey = `box:${sandbox.id}`;
      const existing = await tx.get(boxKey);
      if (existing && existing.createKey !== createKey) throw new Error('machine identity conflict');
      if (!existing) await tx.put(boxKey, { machineId: sandbox.id, pool: current.pool, originPool: current.pool, size: current.size, createKey, state: 'booting', since: current.callingAt ?? current.at, createdAt: current.callingAt ?? current.at, generation: 0, reusable: current.reusable, jobs: 0 });
      await tx.delete(key);
      return true;
    });
  }

  async admissionEntries() {
    const entries = await records(this.storage, 'create:');
    return Promise.all(entries.map(async item => ({ key: item.createKey, at: item.queuedAt, rank: this.budget.claimKey ? await this.budget.claimKey(item.createKey) : item.createKey })));
  }

  async admitQueued(key, { mode, env = {}, project = this.project, preparationFailed = false }) {
    const item = await this.storage.get(`create:${key}`);
    if (!item) return;
    const claim = await this.budget.claim(key), uncertain = claim && claim.status !== 'pending';
    const epoch = env.RESUME_EPOCH ?? '0';
    const status = await this.storage.get(`pool:status:${JSON.parse(item.pool)[1]}`);
    const snapshot = await this.storage.get('pool:snapshot'), breaker = await this.storage.get('verification:breaker');
    const localOnly = (project.externalClaimer ?? project.localFirst)?.localOnly?.includes(JSON.parse(item.pool)[1]);
    const reason = localOnly ? 'local_only' : mode !== 'on' ? 'pool_off' : env.ENABLED !== 'true' ? 'disabled' : preparationFailed ? 'preparation_failed' : (status?.reason && !status.reason.startsWith('ledger:')) ? status.reason : !snapshot?.complete ? 'snapshot_incomplete' : breaker?.tripped ? 'breaker' : (await this.storage.get('startBackoffUntil')) > this.now() ? 'backoff' : (await this.storage.get('blocked'))?.epoch === epoch ? 'blocked' : (await this.storage.get(`size-block:${item.size}`))?.epoch === epoch ? 'size_block' : null;
    if (!uncertain && reason) { this.logger?.(JSON.stringify({ event: 'admission_refused', project: this.project?.id, reason })); await this.budget.abandon?.(key); return; }
    try {
      const limits = uncertain ? {} : await this.api.limits();
      if (!uncertain && (!limits.canStart || !limits.machineTypes?.some(type => type.type === item.size && type.available === true))) { this.logger?.(JSON.stringify({ event: 'admission_refused', project: this.project?.id, reason: 'provider_limits', size: item.size })); return; }
      await this.admit(key, limits, Number(project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200), epoch);
    } catch { await this.storage.put('pool:last-error', { at: this.now(), stage: 'create', createKey: key }); }
  }

  async tick({ mode = 'shadow', env = {}, account = {}, project = this.project, prepareOnly = false, preprepared = false, preparationFailed = false, skipAdmission = false } = {}) {
    if (!project || !['shadow', 'on', 'drain'].includes(mode)) throw new TypeError('invalid pool mode');
    if (mode !== 'shadow' && !(await this.storage.get('pool:migrated'))?.done) throw new Error('migration required');
    const now = this.now();
    if (mode !== 'shadow' && !preprepared) await prunePool(this.storage, now);
    const [jobs, boxes, creates, locals, snapshot, breaker, blocked, backoff, override] = await Promise.all([
      records(this.storage, 'gh-job:'), records(this.storage, 'box:'), records(this.storage, 'create:'),
      records(this.storage, 'local-runner:'), this.storage.get('pool:snapshot'), this.storage.get('verification:breaker'),
      this.storage.get('blocked'), this.storage.get('startBackoffUntil'), this.storage.get('reuse:override'),
    ]);
    const complete = snapshot?.complete === true, runners = complete ? snapshot.runners ?? [] : [];
    if (!prepareOnly && mode !== 'shadow' && complete && now - (await this.storage.get('pool:orphan-sweep') ?? -Infinity) >= 600_000) {
      try { await this.sweepOrphans(snapshot, project); }
      catch { await this.storage.put('pool:last-error', { at: now, stage: 'orphan-sweep' }); }
    }
    const byName = new Map(runners.map(runner => [runner.name, runner]));
    const known = new Set([...boxes.map(box => box.runnerName), ...locals.map(local => local.name)].filter(Boolean));
    const units = [
      ...creates.map(create => ({ ...create, kind: 'create' })),
      ...boxes.filter(box => !box.drainOnly).map(box => ({ ...box, online: byName.get(box.runnerName)?.status === 'online', busy: byName.get(box.runnerName)?.busy === true })),
      ...locals.map(local => ({ ...local, pool: poolKey(project.repo, local.label), kind: 'local', online: byName.get(local.name)?.status === 'online', busy: byName.get(local.name)?.busy === true })),
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
      const reason = claimer?.localOnly?.includes(label) ? 'local_only' : !size ? 'size_block' : mode === 'drain' || env.ENABLED !== 'true' || blocked?.epoch === epoch ? 'stopped' : breaker?.tripped ? 'breaker' : sizeBlock?.epoch === epoch ? 'size_block' : backoff > now ? 'backoff' : !complete ? 'snapshot_incomplete' : null;
      pools.push({ key: poolKey(project.repo, label), label, size, reason, localFirst: claimer?.enabled === true && Boolean(claimer.labels?.[label]), offerSeconds: claimer?.offerSeconds });
    }
    const demand = jobs.filter(job => !job.missing || !complete);
    if (mode === 'shadow') return plan({ pools, jobs: demand, units, now });
    const waitEnabled = complete && mode === 'on' && account.reuse?.enabled === true && project.reuse?.mode === 'on' && project.dockerAccess !== true && override !== 'off' && !breaker?.tripped;
    const waits = await waitClaims({ storage: this.storage, api: this.api, jobs: demand, boxes, pools, units, now, account, project, env, enabled: waitEnabled, logger: this.logger });
    units.push(...waits.virtual);
    const output = plan({ pools, jobs: demand, units, now });
    if (waits.active.length) await this.storage.setAlarm(Math.min(...waits.active.map(c => c.until), now + 10_000));
    for (const pool of pools) {
      let status = output[pool.key];
      if (preprepared && !output[pool.key].reason) {
        const previous = await this.storage.get(`pool:status:${pool.label}`);
        if (previous?.reason?.startsWith('ledger:')) status = { ...status, reason: previous.reason };
      }
      await this.storage.put(`pool:status:${pool.label}`, status);
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
    const cap = project.caps?.concurrent ?? Infinity;
    let room = Math.max(0, cap - boxes.filter(box => box.state !== 'deleted').length - creates.length);
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
        if (cancelled) { await this.storage.delete(`create:${create.createKey}`); excessPending--; surplus = Math.max(0, surplus - 1); room++; }
      }
      if (!prepareOnly && surplus && complete) {
        for (const box of boxes.filter(item => item.pool === pool.key && item.state === 'idle').sort((a, b) => a.since - b.since)) {
          if (!surplus) break;
          const hold = box.reusable ? (project.reuse?.idleHoldSeconds ?? account.reuse?.idleHoldSeconds ?? 120) : 120;
          if (now - (box.onlineAt ?? box.since) < hold * 1000 || byName.get(box.runnerName)?.busy) continue;
          if (await this.retire(box.machineId)) surplus--;
        }
      }
      if (!preprepared && !preparationFailed && result.create > 0) {
        const aged = demand.filter(job => job.pool === pool.key && job.status === 'queued' && (!pool.localFirst || job.queuedAt + (pool.offerSeconds ?? 30) * 1000 <= now));
        const held = waits.active.filter(claim => claim.pool === pool.key);
        const unheld = aged.filter(job => !held.some(claim => claim.jobId === job.id));
        for (const job of uncovered(unheld, Math.max(0, result.S - held.length)).slice(0, result.create)) candidates.push({ pool, job });
      }
    }
    candidates.sort((a, b) => a.job.queuedAt - b.job.queuedAt || a.job.id - b.job.id || a.pool.key.localeCompare(b.pool.key));
    const replaceable = (await records(this.storage, 'create:')).filter(item => item.state === 'pending').sort((a, b) => b.queuedAt - a.queuedAt);
    for (const { pool, job } of candidates) {
      while (room <= 0) {
        const later = replaceable.find(item => item.queuedAt > job.queuedAt);
        if (!later) break;
        replaceable.splice(replaceable.indexOf(later), 1);
        const claim = await this.budget.claim(later.createKey);
        const cancelled = claim?.status === 'pending' ? await this.budget.cancelPending(later.createKey)
          : !claim && (await this.budget.abandon(later.createKey) || !await this.budget.claim(later.createKey));
        if (!cancelled) continue;
        await this.storage.delete(`create:${later.createKey}`);
        room++;
      }
      if (room <= 0) break;
      await this.prepare(pool.key, pool.size, 1, job.queuedAt, account.reuse?.enabled === true && project.reuse?.mode === 'on' && project.dockerAccess !== true && override !== 'off');
      room--;
    }
    const pending = await records(this.storage, 'create:');
    const reusable = account.reuse?.enabled === true && project.reuse?.mode === 'on' && project.dockerAccess !== true && override !== 'off';
    for (const item of pending) {
      if (item.state !== 'pending' || item.reusable === reusable) continue;
      const claim = await this.budget.claim(item.createKey);
      if (claim && claim.status !== 'pending') continue;
      item.reusable = reusable;
      await this.storage.put(`create:${item.createKey}`, item);
    }
    const ranks = new Map(await Promise.all(pending.map(async item => [item.createKey, this.budget.claimKey ? await this.budget.claimKey(item.createKey) : item.createKey])));
    pending.sort((a, b) => a.queuedAt - b.queuedAt || ranks.get(a.createKey).localeCompare(ranks.get(b.createKey)));
    for (const item of pending) {
      if (item.state !== 'pending' || !output[item.pool]?.reason) continue;
      const claim = await this.budget.claim(item.createKey);
      if (!claim || claim.status === 'pending') await this.budget.abandon?.(item.createKey);
    }
    if (prepareOnly) {
      for (const item of pending) if (item.state === 'pending' && !output[item.pool]?.reason) await this.budget.enqueue(item.createKey, item.queuedAt, undefined, { pool: true, label: JSON.parse(item.pool)[1] });
      return output;
    }
    let limits;
    for (const item of skipAdmission ? [] : pending) {
      const claim = await this.budget.claim(item.createKey);
      const uncertain = claim && claim.status !== 'pending';
      if (!uncertain && mode === 'drain') {
        const cancelled = claim ? await this.budget.cancelPending(item.createKey) : (await this.budget.abandon(item.createKey) || !await this.budget.claim(item.createKey));
        if (cancelled) await this.storage.delete(`create:${item.createKey}`);
        continue;
      }
      if (!uncertain && output[item.pool]?.reason) continue;
      if (!uncertain && preparationFailed) continue;
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
      catch { await this.storage.put('pool:last-error', { at: now, stage: 'create', createKey: item.createKey }); }
    }
    for (const box of boxes) {
      if (mode === 'drain' && ['booting', 'baseline', 'ready', 'resetting'].includes(box.state) && !box.runnerId) {
        await this.transition(box.machineId, [box.state], 'destroying', { runnerFenced: true });
        continue;
      }
      if (complete && (mode === 'drain' || box.drainOnly) && box.state === 'idle' && !byName.get(box.runnerName)?.busy) { await this.retire(box.machineId); continue; }
      if (complete && override === 'off' && box.state === 'idle' && (box.jobs ?? 0) > 0) { await this.retire(box.machineId); continue; }
      const ttl = Number(project.machineTtlSeconds ?? env.MACHINE_TTL_SECONDS ?? 7200);
      const maxJobs = Math.min(account.reuse?.maxJobs ?? 60, project.reuse?.maxJobs ?? 60);
      const maxAge = Math.min(account.reuse?.maxAgeSeconds ?? 86400, project.reuse?.maxAgeSeconds ?? 86400);
      const timeouts = Object.values(project.jobs ?? {}).map(job => job.timeoutMinutes ?? 0);
      const headroom = Math.max(300, 1200 + Math.max(0, ...timeouts) * 60);
      const reuseEnabled = !box.drainOnly && mode !== 'drain' && override !== 'off' && account.reuse?.enabled === true && project.reuse?.mode === 'on' && project.dockerAccess !== true && !breaker?.tripped && Number.isFinite(box.createdAt) && Number.isFinite(ttl) && timeouts.every(Number.isFinite) && (box.jobs ?? 0) + 1 < maxJobs && now - box.createdAt < Math.min(maxAge, ttl - headroom) * 1000;
      try {
        const associated = demand.filter(job => job.runnerName && job.runnerName === box.runnerName);
        const running = associated.some(job => job.status === 'in_progress');
        const last = associated.find(job => job.status === 'completed');
        const guarded = account.waitForBusyBox?.enabled === true && ['idle', 'busy', 'finished'].includes(box.state) && !running && (!last?.durationRecorded || last.slowBox === true || last.conclusion === 'timed_out');
        const view = { complete, at: snapshot?.at, runners, jobs: demand }, options = { reuseEnabled: reuseEnabled && !guarded, ttlSeconds: ttl };
        await this.stepBox(box.machineId, view, options);
        const next = await this.storage.get(`box:${box.machineId}`);
        if (['booting', 'baseline', 'resetting'].includes(box.state) && next?.state === 'ready') await this.stepBox(box.machineId, view, options);
      }
      catch { await this.storage.put('pool:last-error', { at: now, stage: 'box', machineId: box.machineId }); }
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
        await tx.put(`box:${sandbox.id}`, { machineId: sandbox.id, pool: null, state: 'quarantined', drainOnly: true, orphan: true, aliases, noRunnerKnown: !running && runners.length === 0, runnerId: runner?.id ?? null, runnerName: runner?.name ?? null, repo: project.repo, installation: this.installation, since: this.now(), reusable: false });
        await tx.put(`pool:drain-only:${sandbox.id}`, { at: this.now(), reason: 'orphan' });
      });
    }
    await this.storage.put('pool:orphan-sweep', this.now());
  }

  async verificationOutcome(box, kind, ok, detail) {
    const key = `verification:attempt:${ok ? 'online-success' : 'failure'}:${box.machineId}:${box.generation ?? 0}`;
    const opened = await this.storage.transaction(async tx => {
      if (await tx.get(key)) return;
      await tx.put(key, { at: this.now(), kind, ...(detail ? { phase: box.state, message: JSON.stringify(detail) } : {}) });
      this.logger?.(JSON.stringify({ event: 'verification_result', project: this.project?.id, machine_id: box.machineId, kind, phase: box.state, ok, ...(detail ? { detail } : {}) }));
      if ((box.generation ?? 0) > 0) return;
      const breaker = await tx.get('verification:breaker') ?? { counts: {}, tripped: false };
      const count = ok ? 0 : (breaker.counts[box.size] ?? 0) + 1;
      const threshold = Number(this.getEnv?.().VERIFICATION_FAILURE_THRESHOLD ?? 3);
      const limit = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : 3;
      const tripped = breaker.tripped || count >= limit;
      await tx.put('verification:breaker', { counts: { ...breaker.counts, [box.size]: count }, tripped });
      if (tripped && !breaker.tripped) { this.logger?.(JSON.stringify({ event: 'verification_breaker_trip', project: this.project?.id, size: box.size, failures: count })); await this.emit?.('alert_verification_breaker', null, { size: box.size, failures: count }, tx); return true; }
    });
    if (opened) this.alert?.('breaker_open', { value: 1, limit: 1, active: true });
  }

  async transition(machineId, from, state, changes = {}) {
    return this.storage.transaction(async tx => {
      const key = `box:${machineId}`, box = await tx.get(key);
      if (!box || !from.includes(box.state)) return null;
      const next = { ...box, ...changes, state, since: state === box.state ? box.since : this.now() };
      await tx.put(key, next);
      return next;
    });
  }

  async stepBox(machineId, snapshot = {}, options = {}) {
    let box = await this.storage.get(`box:${machineId}`);
    if (!box) return;
    if (snapshot.complete === true && ['idle', 'busy'].includes(box.state)) {
      const runner = (snapshot.runners ?? []).find(item => item.name === box.runnerName);
      const inProgress = (snapshot.jobs ?? []).some(job => job.status === 'in_progress' && job.runnerName === box.runnerName);
      const completed = (snapshot.jobs ?? []).some(job => job.status === 'completed' && job.runnerName === box.runnerName);
      if (box.state === 'idle' && (runner?.busy || inProgress)) {
        if (!box.everOnline) await this.verificationOutcome(box, 'online', true);
        return this.transition(machineId, ['idle'], 'busy', { online: runner?.status === 'online', everOnline: true });
      }
      if (box.state === 'idle' && completed && !inProgress) {
        if (!runner) box = await this.transition(machineId, ['idle'], 'finished', { runnerFenced: true, jobs: (box.jobs ?? 0) + 1 });
        else {
          const retiring = await this.transition(machineId, ['idle'], 'retiring', { afterFence: 'finished' });
          if (retiring) await this.fenceRunner(retiring);
          return;
        }
      } else if (box.state === 'idle') {
        const online = runner?.status === 'online';
        if (online && !box.everOnline) await this.verificationOutcome(box, 'online', true);
        box = await this.transition(machineId, ['idle'], 'idle', { online, onlineAt: online ? box.onlineAt ?? this.now() : box.onlineAt, everOnline: box.everOnline || online, offlineSince: online ? null : box.offlineSince ?? (box.everOnline ? this.now() : box.startedAt ?? box.since) });
      } else if (!runner && !inProgress) {
        box = await this.transition(machineId, ['busy'], 'finished', { runnerFenced: true, jobs: (box.jobs ?? 0) + 1 });
      } else if (!inProgress && (completed || (!runner?.busy && snapshot.at !== box.lastIdleSnapshotAt))) {
        const idleSnapshots = (box.idleSnapshots ?? 0) + 1;
        if (completed || idleSnapshots >= 2) {
          const retiring = await this.transition(machineId, ['busy'], 'retiring', { afterFence: 'finished' });
          if (retiring) await this.fenceRunner(retiring);
          return;
        }
        box = await this.transition(machineId, ['busy'], 'busy', { idleSnapshots, lastIdleSnapshotAt: snapshot.at });
      } else if (runner?.busy || inProgress) {
        box = await this.transition(machineId, ['busy'], 'busy', { idleSnapshots: 0 });
      }
    }
    if (await this.deadline(machineId, { ...options, snapshotComplete: snapshot.complete === true })) return;
    box = await this.storage.get(`box:${machineId}`);
    if (box.state === 'busy' && Number.isFinite(box.createdAt) && Number.isFinite(options.ttlSeconds) && this.now() >= box.createdAt + options.ttlSeconds * 1000) {
      await this.transition(machineId, ['busy'], 'destroying');
      return this.destroy(machineId, { ttlExpired: true });
    }
    if (box.state === 'booting') {
      const result = await this.api.sandbox(box);
      if (result?.sandbox?.setupStatus === 'failed' || ['error', 'cancelled', 'archived', 'stopped'].includes(result?.sandbox?.state)) {
        await this.verificationOutcome(box, 'boot_failed', false);
        return this.transition(machineId, ['booting'], 'destroying', { failureReason: 'boot_failed' });
      }
      if (result?.sandbox?.setupStatus !== 'done' || !['ready', 'idle', 'running'].includes(result?.sandbox?.state)) return;
      if (!box.reusable) return this.transition(machineId, ['booting'], 'ready');
      box = await this.transition(machineId, ['booting'], 'baseline', { processId: null });
      if (!box) return;
      try {
        const result = await this.api.refresh(box, 'baseline', 0);
        if (!Number.isSafeInteger(result?.processId) || result.processId < 1) throw new Error('missing process');
        return this.transition(machineId, ['baseline'], 'baseline', { processId: result.processId, since: box.since });
      } catch { await this.verificationOutcome(box, 'baseline_failed', false); return this.transition(machineId, ['baseline'], 'destroying', { failureReason: 'baseline_failed' }); }
    }
    if (box.state === 'baseline' && box.processId) {
      const result = await this.api.refreshResult(box, box.processId, 0);
      if (result === null) return;
      if (result?.ok !== true || !/^[a-f0-9]{64}$/.test(result.baselineHash ?? '')) { await this.verificationOutcome(box, 'baseline_failed', false); return this.transition(machineId, ['baseline'], 'destroying', { failureReason: 'baseline_failed' }); }
      return this.transition(machineId, ['baseline'], 'ready', { baselineHash: result.baselineHash, generation: 0 });
    }
    if (box.state === 'ready') {
      const [repo, label] = JSON.parse(box.pool), project = this.project?.id;
      if (!project || !this.installation) throw new Error('project identity missing');
      if (box.generation > 0) {
        let valid = repo === this.project.repo && box.pool === box.originPool;
        try { poolSize(this.project, label); } catch { valid = false; }
        if (!valid) return this.transition(machineId, ['ready'], 'destroying', { failureReason: 'pool_mismatch' });
      }
      const runnerName = `boat-${project}-${machineId}-g${box.generation}`;
      box = await this.transition(machineId, ['ready'], 'registering', { repo, installation: this.installation, label, labels: [label], runnerName, runnerIdentity: runnerName, boxGeneration: true, routerReusable: box.reusable, runnerId: null });
      if (!box) return;
      try {
        await this.api.configure(box, async runnerId => {
          await this.storage.transaction(async tx => {
            const current = await tx.get(`box:${machineId}`);
            if (current?.state !== 'registering' || current.runnerName !== runnerName) throw new Error('registration lost');
            await tx.put(`box:${machineId}`, { ...current, runnerId });
            await tx.put(`runner:${runnerName}`, { kind: 'boat', machineId, generation: box.generation });
          });
        });
        box = await this.storage.get(`box:${machineId}`);
        if (!box?.runnerId) throw new Error('runner missing');
        const result = await this.api.start(box);
        if (result?.success === false) throw new Error('start failed');
        return this.transition(machineId, ['registering'], 'idle', { startedAt: this.now(), online: false, everOnline: false, onlineAt: null, offlineSince: null });
      } catch (error) {
        const detail = box.generation > 0 ? { step: 're-register runner', exitCode: null, output: '', service: ['boat', 'github'].includes(error?.service) ? error.service : null, status: Number.isInteger(error?.status) && error.status >= 0 && error.status <= 599 ? error.status : null } : undefined;
        await this.verificationOutcome(box, 'registration_uncertain', false, detail);
        return this.transition(machineId, ['registering'], 'quarantined', { failureReason: 'registration_uncertain' });
      }
    }
    if (box.state === 'finished') {
      if (!box.reusable || options.reuseEnabled !== true || !box.baselineHash) return this.transition(machineId, ['finished'], 'destroying');
      const generation = box.generation + 1;
      box = await this.transition(machineId, ['finished'], 'resetting', { generation, processId: null });
      try {
        const result = await this.api.lightReset(box, generation);
        if (!Number.isSafeInteger(result?.processId) || result.processId < 1) throw new Error('missing process');
        return this.transition(machineId, ['resetting'], 'resetting', { processId: result.processId });
      } catch { await this.verificationOutcome(box, 'reset_failed', false, { step: 'submit reset command', exitCode: null, output: '' }); return this.transition(machineId, ['resetting'], 'destroying', { failureReason: 'reset_failed' }); }
    }
    if (box.state === 'resetting' && box.processId) {
      let result;
      try { result = await this.api.lightResetResult(box, box.processId, box.generation); }
      catch { result = { ok: false, step: 'read reset result', exitCode: null, output: '' }; }
      if (result === null) return;
      if (result?.ok !== true) { await this.verificationOutcome(box, 'reset_failed', false, { step: result?.step ?? 'read reset result', exitCode: result?.exitCode ?? null, output: result?.output ?? '' }); return this.transition(machineId, ['resetting'], 'destroying', { failureReason: 'reset_failed' }); }
      this.logger?.(JSON.stringify({ event: 'verification_result', project: this.project?.id, machine_id: box.machineId, kind: 'reset', phase: box.state, ok: true }));
      return this.transition(machineId, ['resetting'], 'ready', { runnerId: null, runnerName: null, runnerIdentity: null, runnerFenced: false });
    }
    if (box.state === 'quarantined' && snapshot.complete === true) {
      const prefix = box.orphan ? `boat-${this.project?.id}-${box.machineId}-g` : null;
      const matching = (snapshot.runners ?? []).filter(item => item.name === box.runnerName || (box.runnerId && item.id === box.runnerId) || (box.orphan && ((box.aliases ?? []).includes(item.name) || item.name?.startsWith(prefix))));
      if (matching.length > 1) return;
      const runner = matching[0];
      if (runner?.busy) return this.transition(machineId, ['quarantined'], 'busy', { runnerId: runner.id, runnerName: runner.name, repo: box.repo ?? this.project?.repo, installation: box.installation ?? this.installation, everOnline: true });
      if (runner && Number.isSafeInteger(runner.id)) {
        const retiring = await this.transition(machineId, ['quarantined'], 'retiring', { runnerId: runner.id, runnerName: runner.name, repo: box.repo ?? this.project?.repo, installation: box.installation ?? this.installation });
        if (retiring) return this.fenceRunner(retiring);
      }
      if (box.runnerId) {
        const retiring = await this.transition(machineId, ['quarantined'], 'retiring', { repo: box.repo ?? this.project?.repo, installation: box.installation ?? this.installation });
        if (retiring) return this.fenceRunner(retiring);
      }
      // A missing sandbox cannot provide capacity or require Boat cleanup. Keep
      // ambiguous API failures quarantined until the provider confirms absence.
      if (typeof this.api.sandbox === 'function') {
        try { await this.api.sandbox(box); }
        catch (error) {
          if (error?.status === 404) return this.transition(machineId, ['quarantined'], 'deleted', { failureReason: 'sandbox_missing' });
        }
      }
      const running = box.orphan && (snapshot.jobs ?? []).some(job => job.status === 'in_progress' && ((box.aliases ?? []).includes(job.runnerName) || job.runnerName?.startsWith(prefix)));
      if (box.drainOnly && (box.orphan ? !running : box.noRunnerKnown) && !runner) return this.transition(machineId, ['quarantined'], 'destroying', { runnerFenced: true });
    }
    if (box.state === 'retiring') return this.fenceRunner(box);
    if (box.state === 'destroying') return this.destroy(machineId, { ttlExpired: Number.isFinite(box.createdAt) && Number.isFinite(options.ttlSeconds) && this.now() >= box.createdAt + options.ttlSeconds * 1000 });
    if (box.state === 'unregister') {
      try { await this.api.removeRunner(box); } catch (error) { if (error.status !== 404) return; }
      return this.transition(machineId, ['unregister'], 'purging', { runnerFenced: true });
    }
    if (box.state === 'purging') {
      if (!box.operationId) return this.transition(machineId, ['purging'], 'deleted');
      const result = await this.api.deletion(box);
      if (result?.operation?.status === 'completed') return this.transition(machineId, ['purging'], 'deleted');
    }
  }

  async deadline(machineId, options = {}) {
    const box = await this.storage.get(`box:${machineId}`);
    if (!box) return null;
    const reason = boxDeadline(box, this.now(), options);
    if (!reason) return null;
    if (reason === 'offline_timeout' && options.snapshotComplete !== true) return null;
    if (reason !== 'reuse_off' && reason !== 'offline_timeout') await this.verificationOutcome(box, reason, false);
    if (reason === 'offline_timeout') {
      const removed = await this.retire(machineId);
      if (removed && !box.everOnline) await this.verificationOutcome(box, reason, false);
    } else if (reason === 'registration_timeout') {
      await this.transition(machineId, ['registering'], 'quarantined', { failureReason: reason });
    } else {
      await this.transition(machineId, [box.state], 'destroying', { failureReason: reason === 'reuse_off' ? null : reason });
    }
    return reason;
  }

  async retire(machineId) {
    const box = await this.transition(machineId, ['idle'], 'retiring');
    if (!box) return false;
    return this.fenceRunner(box);
  }

  async fenceRunner(box) {
    if (!Number.isSafeInteger(box.runnerId) || box.runnerId < 1) return false;
    try { await this.api.removeRunner(box); }
    catch (error) {
      if (error.status === 422) {
        await this.transition(box.machineId, ['retiring'], 'busy', { afterFence: null });
        return false;
      }
      if (error.status !== 404) return false;
    }
    return Boolean(await this.transition(box.machineId, ['retiring'], box.afterFence === 'finished' ? 'finished' : 'destroying', { runnerFenced: true, afterFence: null, ...(box.afterFence === 'finished' ? { jobs: (box.jobs ?? 0) + 1 } : {}) }));
  }

  async destroy(machineId, { ttlExpired = false } = {}) {
    const box = await this.storage.get(`box:${machineId}`);
    if (!box || box.state !== 'destroying' || box.machineId !== machineId || box.runnerId && !box.runnerFenced && !ttlExpired) return false;
    let operation;
    try { operation = await this.api.destroy(box); }
    catch (error) { if (error.status !== 404) throw error; }
    if (operation && typeof operation.operation?.id !== 'string') return false;
    await this.transition(machineId, ['destroying'], box.runnerId && !box.runnerFenced ? 'unregister' : 'purging', { operationId: operation?.operation?.id ?? null });
    return true;
  }
}
