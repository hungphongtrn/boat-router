import { transition as applyBoxEvent } from './box-state.mjs';
import { ExternalLeases, ExternalLeaseStarts, WarmLeaseFence } from './external-leases.mjs';
import { snapshotLimits } from './ledger.mjs';
import { poolKey, poolSize } from './pool.mjs';
import { reuseHold } from './reuse-pacing.mjs';
import { runnableDemand } from './workflow-demand.mjs';
import { lanesSwitchOn } from './lanes.mjs';
import { breakerForSize } from './verification-breaker.mjs';
import { validLeaseSize } from './sizes.mjs';
import { normalizeNetwork } from './lease-network.mjs';
import { heldUntil, holdActive } from './lease-hold.mjs';
import { snapshotFresh } from './snapshot-freshness.mjs';

async function records(storage, prefix) {
  const out = []; let startAfter = '';
  for (;;) {
    const page = await storage.list({ prefix, startAfter, limit: 128 });
    out.push(...page.values());
    if (page.size < 128) return out;
    startAfter = [...page.keys()].at(-1);
  }
}

// Public handlers must serialize calls with Router.tick and authenticate the
// client before invoking this service. All leases fail closed by default.
export class ExternalService {
  constructor(router, storage, api, clients, now = Date.now) {
    Object.assign(this, { router, storage, api, clients, now });
    this.leases = new ExternalLeases(storage, now);
    this.fence = new WarmLeaseFence(storage, api, now);
    // The account health mode covers lease boxes of both accounts.
    this.fence.healthEnforce = ['auto', 'enforce'].includes(router.account?.reuse?.healthCheck);
    this.ledger = router.externalLedger ?? router.ledger;
    this.starts = new ExternalLeaseStarts(storage, this.ledger, api, now, router.externalCreateAccount);
    Object.defineProperty(this.starts, 'secondaryBases', { get: () => router.secondaryBases?.() ?? null });
  }
  config(client) {
    const cfg = this.clients?.[client];
    if (!cfg || cfg.enabled !== true || (cfg.maxActive !== null && (!Number.isSafeInteger(cfg.maxActive) || cfg.maxActive < 1)) || (cfg.startsPerDay !== null && (!Number.isSafeInteger(cfg.startsPerDay) || cfg.startsPerDay < 0)) || !Number.isSafeInteger(cfg.ttlSeconds) || cfg.ttlSeconds < 60 || cfg.ttlSeconds > 3600 || (cfg.rollingSnapshot !== undefined && typeof cfg.rollingSnapshot !== 'boolean') || (cfg.warmReuse !== undefined && typeof cfg.warmReuse !== 'boolean') || !this.router.projects.has(cfg.project)) return null;
    // A malformed network policy disables the client rather than leaking a box
    // with the provider's open default, so it is validated on every read.
    let network;
    try { network = normalizeNetwork(cfg.network); } catch { return null; }
    return { ...cfg, network };
  }
  async ciIdle(size = 'default', allowDeferred = false) {
    for (const project of this.router.projects.values()) {
      if (!project.box || await project.storage.get('pool:mode') !== 'on') continue;
      const localOnly = (project.config.externalClaimer ?? project.config.localFirst)?.localOnly ?? [];
      const matchingLabels = project.config.labels.filter(label => { try { return !localOnly.includes(label) && poolSize(project.config, label) === size; } catch { return false; } });
      if (!matchingLabels.length) continue;
      if (!snapshotFresh(await project.storage.get('pool:snapshot'), this.now(), project.config)) return false;
      const localPools = new Set(localOnly.map(label => poolKey(project.config.repo, label)));
      const jobs = await records(project.storage, 'gh-job:');
      for (const job of runnableDemand(jobs, project.config.workflowConcurrency, true, { laneCaps: await lanesSwitchOn(project.storage, project.config) })) {
        if (job.status !== 'queued' || job.missing || localPools.has(job.pool)) continue;
        try {
          const label = JSON.parse(job.pool)[1];
          if (!matchingLabels.includes(label) && project.config.labels.includes(label)) continue;
          if (allowDeferred && matchingLabels.includes(label)) {
            const status = await project.storage.get(`pool:status:${label}`);
            if (['local_capacity', 'ledger:minute_cap', 'ledger:hour_cap', 'ledger:day_cap'].includes(status?.reason)) continue;
          }
          return false;
        } catch { return false; }
      }
    }
    return true;
  }
  async snapshotsReady() {
    for (const project of this.router.projects.values()) {
      if (!project.box || await project.storage.get('pool:mode') !== 'on') continue;
      if (!snapshotFresh(await project.storage.get('pool:snapshot'), this.now(), project.config)) return false;
    }
    return true;
  }
  async pendingReason(client, id, size) {
    const cfg = this.config(client);
    if (!cfg) return 'client_disabled';
    const project = this.router.projects.get(cfg.project);
    if (await project.storage.get('pool:mode') !== 'on') return 'pool_disabled';
    const lease = await this.storage.get(`external-lease:${client}:${id}`);
    if (!lease) {
      const active = (await records(this.storage, `external-lease:${client}:`)).filter(item => item.state !== 'closed' && (item.state !== 'waiting' || item.machineId || item.claimKey) && !(item.state === 'reserved' && !item.machineId && !item.claimKey && item.expiresAt <= this.now()));
      if (cfg.maxActive !== null && active.length >= cfg.maxActive) return 'lease_cap';
      if (this.router.account.openStartQueue === true) {
        if (!await this.snapshotsReady()) return 'ci_snapshot_unavailable';
      } else if (!await this.ciIdle(size)) return await this.ciIdle(size, true) ? 'deferred_ci_warm_only' : 'ci_demand_or_snapshot';
      return 'reservation_pending';
    }
    // A held lease is intentionally kept for debugging; it is not a pending claim.
    if (holdActive(lease, this.now())) return 'lease_held';
    if (lease.expiresAt <= this.now()) return 'lease_expired';
    if (['waiting', 'reserved', 'starting'].includes(lease.state)) {
      if (this.router.account.openStartQueue === true) {
        if (!await this.snapshotsReady()) return 'ci_snapshot_unavailable';
      } else if (!await this.ciIdle(lease.size ?? size)) return await this.ciIdle(lease.size ?? size, true) ? 'deferred_ci_warm_only' : 'ci_demand_or_snapshot';
    }
    if (lease.lastReason && /^[a-z_]+$/.test(lease.lastReason)) return lease.lastReason;
    return /^[a-z_]+$/.test(lease.state ?? '') ? `lease_${lease.state}` : 'lease_pending';
  }
  async claim(client, id, size, isolation = null, repoKey = null, fromTick = false, selection = null, rolling = false) {
    const cfg = this.config(client);
    if (!cfg || !validLeaseSize(size) || (repoKey !== null && !/^[a-f0-9]{64}$/.test(repoKey))) return null;
    const project = this.router.projects.get(cfg.project);
    if (await project.storage.get('pool:mode') !== 'on') return null;
    const prior = await this.storage.get(`external-lease:${client}:${id}`);
    if (prior?.size && (prior.baseId ?? null) !== (selection?.baseId ?? null)) return null;
    const ciIdle = await this.ciIdle(size);
    const openStartQueue = this.router.account.openStartQueue === true;
    const snapshotsReady = openStartQueue ? await this.snapshotsReady() : ciIdle || await this.ciIdle(size, true);
    if ((!prior || ['waiting', 'reserved'].includes(prior.state)) && !snapshotsReady) {
      if (prior?.state === 'reserved' && !prior.machineId && !prior.claimKey) await this.leases.transition(client, id, ['reserved'], 'waiting');
      return null;
    }
    // external-v2 clients use the externallease user, isolate /tmp/w, and put transferred files under /tmp/lease-<id>.
    const reuseEnabled = cfg.warmReuse === true && this.router.account.reuse?.enabled === true && project.config.reuse?.mode === 'on' && project.config.dockerAccess !== true && await project.storage.get('reuse:override') !== 'off';
    // A rolling generation is a boot disk, not a reuse feature: it needs no warm
    // reuse, so only the base kinds still require the isolated lease mode.
    if (selection && (!prior || ['waiting', 'reserved'].includes(prior.state)) && (!reuseEnabled || isolation !== 'external-v2') && selection.routerSnapshot?.kind !== 'peek-ci') return null;
    let lease = await this.leases.reserve(client, id, cfg.maxActive, cfg.ttlSeconds * 1000);
    if (!lease) return null;
    if (!lease.size && lease.state === 'reserved') lease = await this.leases.transition(client, id, ['reserved'], 'reserved', { size, project: cfg.project, repoKey, isolation: reuseEnabled && isolation === 'external-v2' ? isolation : null, ...(rolling ? { rollingSnapshot: true } : {}), ...(cfg.network ? { network: cfg.network } : {}), ...(selection ?? {}) });
    if (!lease || lease.size !== size) return null;
    // A rolling client never boots plain: without a stored generation it waits
    // for the next publication instead of spending a start on an empty box.
    if (rolling && !lease.routerSnapshot) {
      if (lease.state === 'reserved') await this.leases.transition(client, id, ['reserved'], 'waiting', { lastReason: 'ci_snapshot_unavailable' });
      if (lease.state !== 'active') return null;
    }
    if (lease.state === 'active') return lease.expiresAt > this.now() ? lease : null;
    if (lease.expiresAt <= this.now()) return null;
    if (lease.state === 'fencing') await this.fence.resume(cfg.project, client, id);
    else if (lease.state === 'resetting') await this.fence.completeReset(cfg.project, client, id);
    else if (lease.state === 'booting') await this.starts.ready(client, id);
    else if (lease.state === 'baselining') await this.starts.baselineReady(client, id);
    else if (['reserved', 'starting'].includes(lease.state) && snapshotsReady) {
      if (lease.state === 'reserved') {
        const snapshot = await project.storage.get('pool:snapshot');
        const runners = snapshot.runners ?? [];
        const boxes = await records(project.storage, 'box:');
        const jobs = await records(project.storage, 'gh-job:');
        const account = this.router.account, reuse = project.config.reuse;
        const override = await project.storage.get('reuse:override');
        const maxJobs = Math.min(account.reuse?.maxJobs ?? 60, reuse?.maxJobs ?? 60);
        const maxAge = Math.min(account.reuse?.maxAgeSeconds ?? 86400, reuse?.maxAgeSeconds ?? 86400);
        const canReuse = account.reuse?.enabled === true && reuse?.mode === 'on' && project.config.dockerAccess !== true && override !== 'off';
        const warm = [];
        for (const box of boxes) {
          if (!canReuse || lease.isolation !== 'external-v2' || box.state !== 'lease-warm' || box.leaseClient !== client || box.leaseIsolation !== lease.isolation || (box.baseId ?? null) !== (lease.baseId ?? null) || box.size !== size || !box.baselineHash || (box.jobs ?? 0) + 1 >= maxJobs || box.generation >= 59 || !Number.isFinite(box.createdAt) || !Number.isFinite(box.since) || this.now() - box.createdAt >= maxAge * 1000 || box.createdAt + (box.machineTtlSeconds ?? project.config.machineTtlSeconds ?? 7200) * 1000 <= this.now() + 1_800_000) continue;
          let label; try { label = JSON.parse(box.pool)[1]; } catch { continue; }
          const status = await project.storage.get(`pool:status:${label}`);
          const base = reuse?.idleHoldSeconds ?? account.reuse?.idleHoldSeconds ?? 120;
          const hold = reuseHold({ box, baseSeconds: base, nominalSeconds: status?.reuseIdleHoldSeconds ?? base, now: this.now(), account, project: { ...project.config, jobs: {}, machineTtlSeconds: box.machineTtlSeconds ?? project.config.machineTtlSeconds }, env: {}, enabled: true });
          if (this.now() - box.since < hold * 1000) warm.push(box);
        }
        const matchingWarm = warm.some(box => box.mirrorKeys?.includes(lease.repoKey) === true);
        const matchingReturning = lease.repoKey && boxes.some(box => box.state === 'lease-returning' && box.leaseClient === client && (box.baseId ?? null) === (lease.baseId ?? null) && box.size === size && box.mirrorKeys?.includes(lease.repoKey) === true && Number.isFinite(box.since) && this.now() - box.since < 120_000);
        if (!matchingWarm && matchingReturning) {
          await this.leases.transition(client, id, ['reserved'], 'waiting', { lastReason: 'lease_pool_preparing' });
          return null;
        }
        if (warm.length) {
          warm.sort((a, b) => Number(b.mirrorKeys?.includes(lease.repoKey) === true) - Number(a.mirrorKeys?.includes(lease.repoKey) === true));
          await this.fence.takeWarm(cfg.project, client, id, warm[0].machineId);
        }
        const candidates = boxes.filter(box => lease.baseId == null && box.baseId == null && canReuse && !jobs.some(job => job.status === 'in_progress' && job.runnerName === box.runnerName) && ((box.state === 'local-held' && box.runnerFenced === true) || (box.state === 'idle' && runners.some(runner => runner.id === box.runnerId && runner.status === 'online' && !runner.busy))) && box.size === size && box.reusable && box.baselineHash && (box.jobs ?? 0) + 1 < maxJobs && (box.generation ?? 0) < 59 && box.everOnline && !box.drainOnly && Number.isFinite(box.createdAt) && this.now() - box.createdAt < maxAge * 1000 && box.createdAt + (box.machineTtlSeconds ?? project.config.machineTtlSeconds ?? 7200) * 1000 > this.now() + 1_800_000);
        if (ciIdle && !warm.length && candidates.length) await this.fence.fence(cfg.project, client, id, candidates[0].machineId);
      }
      lease = await this.storage.get(`external-lease:${client}:${id}`);
      if ((openStartQueue || ciIdle) && ['reserved', 'starting'].includes(lease.state)) {
        if (lease.state === 'reserved' && lease.isolation === 'external-v2') {
          const preparing = (await records(this.storage, `external-lease:${client}:`)).some(item => item.id !== id && item.project === cfg.project && (item.baseId ?? null) === (lease.baseId ?? null) && item.size === size && item.isolation === lease.isolation && (item.releaseRequested || item.expiresAt <= this.now() || item.state === 'returning') && ['starting', 'booting', 'baselining', 'fencing', 'resetting', 'returning'].includes(item.state));
          if (preparing) {
            await this.leases.transition(client, id, ['reserved'], 'waiting', { lastReason: 'lease_pool_preparing' });
            return null;
          }
        }
        const breaker = breakerForSize(await project.storage.get('verification:breaker'), size);
        if (breaker?.tripped) {
          const claim = lease.state === 'starting' && lease.claimKey ? await this.ledger.claim(lease.claimKey) : null;
          if (!claim || claim.status === 'pending') return null;
        }
        const cap = project.config.caps?.concurrent;
        if (lease.state === 'reserved' && Number.isSafeInteger(cap)) {
          const boxes = await records(project.storage, 'box:'), creates = await records(project.storage, 'create:');
          const starts = await records(this.storage, 'external-lease:');
          if (boxes.filter(box => box.state !== 'deleted').length + creates.filter(item => item.state !== 'pending').length + starts.filter(item => item.project === cfg.project && item.state === 'starting').length >= cap) return null;
        }
        const label = project.config.labels.find(value => { try { return poolSize(project.config, value) === size && !((project.config.externalClaimer ?? project.config.localFirst)?.localOnly ?? []).includes(value); } catch { return false; } });
        if (!label) return null;
        // New provider starts use the same ordered tick as CI requests.
        if (openStartQueue && !fromTick) return null;
        const observedAt = this.now();
        let limits;
        try { limits = await this.api.limits(); } catch (error) { if (!this.ledger.selectForLease) throw error; }
        const workAvailable = limits?.canStart === true && limits.machineTypes?.some(type => type.type === size && type.available === true);
        if (!workAvailable && !this.ledger.selectForLease) return null;
        await this.starts.start(client, id, cfg.project, size, poolKey(project.config.repo, label), workAvailable ? snapshotLimits(limits, observedAt) : null, cfg.machineTtlSeconds ?? 7200);
      }
    }
    lease = await this.storage.get(`external-lease:${client}:${id}`);
    return lease?.state === 'active' && lease.expiresAt > this.now() ? lease : null;
  }
  async admissionEntries() {
    if (this.router.account.openStartQueue !== true) return [];
    return (await records(this.storage, 'external-lease:'))
      .filter(lease => ['waiting', 'reserved', 'starting'].includes(lease.state) && !lease.machineId && !lease.releaseRequested && lease.expiresAt > this.now() && Number.isFinite(lease.createdAt) && validLeaseSize(lease.size) && this.config(lease.client))
      .map(lease => ({ at: lease.createdAt, rank: `external:${lease.client}:${lease.id}`, lease }));
  }
  async admitStart(entry) {
    const lease = entry.lease;
    const selection = lease.baseId || lease.routerSnapshot ? { base: lease.base, baseId: lease.baseId, routerSnapshot: lease.routerSnapshot, ...(lease.rollingSnapshot ? { rollingSnapshot: true } : {}) } : null;
    return this.claim(lease.client, lease.id, lease.size, lease.isolation ?? null, lease.repoKey ?? null, true, selection, lease.rollingSnapshot === true);
  }
  async release(client, id, keepOnFailSeconds = 0, operationApi = null) {
    const lease = await this.storage.get(`external-lease:${client}:${id}`);
    if (!lease || lease.state === 'closed') return true;
    // An upload may still be running at the provider after the client leaves.
    // Never reset and reuse that machine while the write is uncertain.
    if (lease.state === 'active' && lease.fileWritePending) return this.fence.destroy(lease.project, client, id);
    if (['reserved', 'waiting'].includes(lease.state)) {
      if (lease.machineId || lease.claimKey) return false;
      return Boolean(await this.leases.transition(client, id, ['reserved', 'waiting'], 'closed'));
    }
    // Releasing an already-held lease either keeps the same bound or ends it now.
    if (lease.state === 'held') return keepOnFailSeconds > 0 ? { heldUntil: lease.heldUntil } : this.fence.destroy(lease.project, client, id, 'release');
    const cfg = this.config(client), project = cfg && this.router.projects.get(cfg.project);
    const reuseEnabled = cfg?.warmReuse === true && this.router.account.reuse?.enabled === true && project?.config.reuse?.mode === 'on' && project.config.dockerAccess !== true && await project.storage.get('reuse:override') !== 'off';
    // A bounded hold keeps a box the client may still debug. The box never enters
    // the warm pool: the sweep deletes it at heldUntil, so its spend settles then.
    if (keepOnFailSeconds > 0 && lease.state === 'active' && lease.machineId && project) {
      const holdUntil = heldUntil(this.now(), keepOnFailSeconds);
      const held = await this.leases.transition(client, id, ['active'], 'held', { heldUntil: holdUntil, holdSeconds: keepOnFailSeconds, fileWritePending: null });
      if (!held) return false;
      // Shorten the provider's own auto-stop to the hold bound, so a sweep that
      // never runs still cannot keep the box past the client's request.
      try {
        const api = operationApi ?? (typeof this.api.forIdentity === 'function' ? await this.api.forIdentity(held) : this.api);
        await api.request('boat', `/sandboxes/${held.machineId}`, { method: 'PATCH', body: { ttlSeconds: keepOnFailSeconds } });
      } catch { /* The sweep's own delete still ends the hold. */ }
      await project.storage.setAlarm(holdUntil);
      return { heldUntil: holdUntil };
    }
    // A rolling lease is never warmed for another client, whatever its warmReuse
    // setting: releasing it deletes the box.
    if (lease.state === 'active' && lease.isolation === 'external-v2' && reuseEnabled && lease.rollingSnapshot !== true) {
      const box = await project.storage.get(`box:${lease.machineId}`);
      const maxJobs = Math.min(this.router.account.reuse?.maxJobs ?? 60, project.config.reuse?.maxJobs ?? 60);
      const maxAge = Math.min(this.router.account.reuse?.maxAgeSeconds ?? 86400, project.config.reuse?.maxAgeSeconds ?? 86400);
      if (box && (box.jobs ?? 0) + 1 < maxJobs && Number.isFinite(box.createdAt) && this.now() - box.createdAt < maxAge * 1000 && await this.fence.returnWarm(lease.project, client, id)) return false;
    }
    if (['booting', 'baselining', 'resetting', 'fencing'].includes(lease.state) && lease.isolation === 'external-v2' && reuseEnabled) {
      await this.leases.transition(client, id, [lease.state], lease.state, { releaseRequested: true });
      return false;
    }
    if (['booting', 'baselining', 'resetting', 'active'].includes(lease.state)) return this.fence.destroy(lease.project, client, id);
    // A pending or uncertain create and an in-flight fence require reconciliation.
    await this.storage.put(`external-lease:${client}:${id}`, { ...lease, releaseRequested: true });
    return false;
  }
  // Kill a process the client started. The lease must still be the caller's and
  // active; the provider owns the process id space, so a plain id is required.
  async cancel(client, id, processId) {
    const leaseKey = `external-lease:${client}:${id}`, lease = await this.storage.get(leaseKey);
    if (!lease || lease.state !== 'active' || lease.expiresAt <= this.now()) return { status: 404, reason: 'process_not_found' };
    // A repeat cancel is idempotent: the process was already asked to stop.
    if ((lease.cancelledProcessIds ?? []).includes(processId)) return { status: 200, cancelled: false };
    const api = typeof this.api.forIdentity === 'function' ? await this.api.forIdentity(lease) : this.api;
    try { await api.request('boat', `/sandboxes/${lease.machineId}/commands/${processId}`, { method: 'DELETE' }); }
    catch (error) {
      if (error?.status === 404) return { status: 404, reason: 'process_not_found' };
      throw error;
    }
    await this.storage.transaction(async tx => {
      const current = await tx.get(leaseKey);
      if (current?.state !== 'active' || current.machineId !== lease.machineId) return;
      const cancelled = [...(current.cancelledProcessIds ?? []).filter(item => item !== processId), processId].slice(-64);
      await tx.put(leaseKey, { ...current, cancelledProcessIds: cancelled });
    });
    return { status: 200, cancelled: true };
  }
  async sweep() {
    for (const lease of await records(this.storage, 'external-lease:')) {
      if (lease.state === 'closed') continue;
      const expired = lease.expiresAt <= this.now() || lease.releaseRequested;
      try {
        if (lease.state === 'active' && lease.fileWritePending && (lease.fileWritePending.failed || this.now() >= lease.fileWritePending.deadline)) {
          await this.fence.destroy(lease.project, lease.client, lease.id);
          continue;
        }
        if (lease.state === 'active' && lease.fileWritePending) await this.router.projects.get(lease.project)?.storage.setAlarm(lease.fileWritePending.deadline);
        if (['reserved', 'waiting'].includes(lease.state) && !lease.machineId && !lease.claimKey && expired) await this.leases.transition(lease.client, lease.id, ['reserved', 'waiting'], 'closed');
        else if (lease.state === 'reserved' && !lease.machineId && !lease.claimKey) await this.leases.transition(lease.client, lease.id, ['reserved'], 'waiting');
        else if (lease.state === 'fencing') await this.fence.resume(lease.project, lease.client, lease.id);
        else if (lease.state === 'resetting') {
          if (expired) await this.release(lease.client, lease.id);
          const current = await this.storage.get(`external-lease:${lease.client}:${lease.id}`);
          const box = await this.storage.get(`project:${lease.project}:box:${lease.machineId}`);
          if (current?.state === 'resetting' && ((!current.processId && this.now() - box?.since > 60000) || this.now() - box?.since >= 300000)) await this.fence.destroy(lease.project, lease.client, lease.id);
          else if (current?.state === 'resetting' && current.processId) await this.fence.completeReset(lease.project, lease.client, lease.id);
        } else if (lease.state === 'returning') {
          const box = await this.storage.get(`project:${lease.project}:box:${lease.machineId}`);
          if (!lease.processId || this.now() - box?.since >= 300000) await this.fence.destroy(lease.project, lease.client, lease.id);
          else await this.fence.completeReturn(lease.project, lease.client, lease.id);
        } else if (lease.state === 'baselining') {
          const box = await this.storage.get(`project:${lease.project}:box:${lease.machineId}`);
          if (expired) await this.release(lease.client, lease.id);
          const current = await this.storage.get(`external-lease:${lease.client}:${lease.id}`);
          if (current?.state === 'baselining' && (!current.processId || this.now() - box?.since >= 300000)) await this.fence.destroy(lease.project, lease.client, lease.id);
          else if (current?.state === 'baselining') await this.starts.baselineReady(lease.client, lease.id);
        } else if (lease.state === 'booting') {
          if (expired) await this.release(lease.client, lease.id);
          const current = await this.storage.get(`external-lease:${lease.client}:${lease.id}`);
          const box = await this.storage.get(`project:${lease.project}:box:${lease.machineId}`);
          if (current?.state === 'booting' && current.releaseRequested && this.now() - box?.since >= 600000) await this.fence.destroy(lease.project, lease.client, lease.id);
          else if (current?.state === 'booting') await this.starts.ready(lease.client, lease.id);
        } else if (lease.state === 'held') {
          // A held box is deleted when its bound ends; the box purge settles its
          // spend at that moment, so the extra seconds are charged to the same
          // reservation the start was admitted against.
          const project = this.router.projects.get(lease.project);
          const box = await this.storage.get(`project:${lease.project}:box:${lease.machineId}`);
          // A box the provider already purged leaves nothing to hold: close the
          // lease so it stops counting against maxActive.
          if (!box || box.state === 'deleted') await this.leases.transition(lease.client, lease.id, ['held'], 'closed');
          else if (!Number.isFinite(lease.heldUntil) || this.now() >= lease.heldUntil) await this.fence.destroy(lease.project, lease.client, lease.id, 'hold_expired');
          else await project?.storage.setAlarm(lease.heldUntil);
        } else if (lease.state === 'active' && expired) await this.release(lease.client, lease.id);
        else if (lease.state === 'cleaning') {
          const box = await this.storage.get(`project:${lease.project}:box:${lease.machineId}`);
          if (box?.state === 'deleted') await this.leases.transition(lease.client, lease.id, ['cleaning'], 'closed');
        } else if (lease.state === 'starting' && !expired && lease.claimKey) {
          const claim = await this.ledger.claim(lease.claimKey);
          if (!claim && (!this.router.externalCreateAccount || lease.account)) {
            await this.leases.transition(lease.client, lease.id, ['starting'], 'waiting', { claimKey:null, createKey:null, routerCreateName:null, account:null, lastReason:'start_capacity' });
          }
        } else if (lease.state === 'starting' && expired) {
          const claim = await this.ledger.claim(lease.claimKey);
          if (this.router.externalCreateAccount && !lease.account && !claim) continue;
          if (!claim || claim.status === 'pending') {
            await this.ledger.abandon(lease.project, lease.claimKey);
            await this.leases.transition(lease.client, lease.id, ['starting'], 'closed');
          } else {
            const found = await this.api.findCreated(lease);
            if (found) await this.starts.start(lease.client, lease.id, lease.project, lease.size, lease.pool, null, 7200);
            else if (this.now() - (claim.callingAt ?? lease.createdAt) >= 300000 && claim.status !== 'created') {
              await this.ledger.resolve(lease.claimKey, 'not_created');
              await this.leases.transition(lease.client, lease.id, ['starting'], 'closed');
            }
          }
        }
      } catch { /* Keep the reservation until a later reconciliation succeeds. */ }
    }
    for (const [client, cfg] of Object.entries(this.clients ?? {})) {
      const project = this.router.projects.get(cfg.project);
      if (!project) continue;
      const jobs = await records(project.storage, 'gh-job:');
      const mode = await project.storage.get('pool:mode');
      const snapshot = await project.storage.get('pool:snapshot');
      const projectBoxes = await records(project.storage, 'box:');
      const creates = await records(project.storage, 'create:');
      for (const box of projectBoxes) {
        if (box.state !== 'lease-warm' || box.leaseClient !== client) continue;
        let label; try { label = JSON.parse(box.pool)[1]; } catch { label = null; }
        const status = label && await project.storage.get(`pool:status:${label}`);
        const base = project.config.reuse?.idleHoldSeconds ?? this.router.account.reuse?.idleHoldSeconds ?? 120;
        const ttl = box.machineTtlSeconds ?? project.config.machineTtlSeconds ?? 7200;
        const hold = reuseHold({ box, baseSeconds: base, nominalSeconds: status?.reuseIdleHoldSeconds ?? base, now: this.now(), account: this.router.account, project: { ...project.config, jobs: {}, machineTtlSeconds: ttl }, env: {}, enabled: true });
        const timeouts = Object.values(project.config.jobs ?? {}).map(job => job.timeoutMinutes ?? 0);
        const safeUntil = box.createdAt + (ttl - Math.max(1800, 1200 + Math.max(0, ...timeouts) * 60)) * 1000;
        const leaseSafeUntil = box.createdAt + (ttl - 1800) * 1000;
        const maxJobs = Math.min(this.router.account.reuse?.maxJobs ?? 60, project.config.reuse?.maxJobs ?? 60);
        const maxAge = Math.min(this.router.account.reuse?.maxAgeSeconds ?? 86400, project.config.reuse?.maxAgeSeconds ?? 86400);
        const canTransfer = this.router.account.reuse?.enabled === true && project.config.reuse?.mode === 'on' && project.config.dockerAccess !== true && (box.jobs ?? 0) + 1 < maxJobs && (box.generation ?? 0) < 59 && this.now() - box.createdAt < maxAge * 1000 && await project.storage.get('reuse:override') !== 'off';
        const demand = box.baseId == null && this.now() < safeUntil && canTransfer && mode === 'on' && snapshotFresh(snapshot, this.now(), project.config) && jobs.some(job => job.status === 'queued' && !job.missing && job.pool === box.pool);
        const cap = project.config.caps?.concurrent;
        const full = Number.isSafeInteger(cap) && cap >= 0 && projectBoxes.filter(item => item.state !== 'deleted').length + creates.length >= cap;
        const fresh = mode === 'on' && snapshotFresh(snapshot, this.now(), project.config);
        const waitingOther = full && fresh && runnableDemand(jobs, project.config.workflowConcurrency, true, { laneCaps: await lanesSwitchOn(project.storage, project.config) }).some(job => job.status === 'queued' && !job.missing && job.pool !== box.pool && !creates.some(item => item.pool === job.pool) && !projectBoxes.some(item => item.pool === job.pool && !['deleted', 'destroying', 'purging', 'busy', 'leased'].includes(item.state)));
        if (demand || waitingOther || this.now() - box.since >= hold * 1000 || this.now() >= leaseSafeUntil) {
          await project.storage.transaction(async tx => {
            const current = await tx.get(`box:${box.machineId}`);
            if (current?.state === 'lease-warm' && current.leaseClient === client) await tx.put(`box:${box.machineId}`, applyBoxEvent(current, demand ? 'lease_warm_reclaim' : 'lease_warm_expire', { runnerFenced: true, leaseClient: null, ...(demand ? {} : { retirementReason: this.now() >= leaseSafeUntil ? 'ttl_headroom' : 'idle_hold_expired' }) }, this.now()));
          });
        }
      }
    }
  }

}
