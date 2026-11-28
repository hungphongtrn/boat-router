import { transition as applyBoxEvent } from './box-state.mjs';
import { leaseBase } from './lease-base.mjs';
import { browserBase } from './browser-base.mjs';
import { validLeaseSnapshot } from './lease-snapshot.mjs';

// Durable reservations are retained through cleanup, including uncertain creates.
export class ExternalLeases {
  constructor(storage, now = Date.now) { this.storage = storage; this.now = now; }
  async reserve(client, id, maxActive, ttlMs) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(client) || !/^[a-f0-9-]{36}$/.test(id) || (maxActive !== null && (!Number.isSafeInteger(maxActive) || maxActive < 1)) || !Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new TypeError('invalid lease');
    return this.storage.transaction(async tx => {
      const key = `external-lease:${client}:${id}`, existing = await tx.get(key), now = this.now();
      if (existing) {
        if (['reserved', 'waiting'].includes(existing.state) && !existing.machineId && !existing.claimKey && existing.expiresAt <= now) { const closed = { ...existing, state: 'closed' }; await tx.put(key, closed); return closed; }
        if (existing.state !== 'waiting' || existing.machineId || existing.claimKey) return existing;
      }
      const prefix = `external-lease:${client}:`; let startAfter = '', active = 0;
      for (;;) {
        const page = await tx.list({ prefix, startAfter, limit: 128 });
        for (const [itemKey, item] of page) {
          if (['reserved', 'waiting'].includes(item.state) && !item.machineId && !item.claimKey && item.expiresAt <= now) await tx.put(itemKey, { ...item, state: 'closed' });
          else if (item.state !== 'closed' && (item.state !== 'waiting' || item.machineId || item.claimKey)) active++;
        }
        if (maxActive !== null && active >= maxActive) return null;
        if (page.size < 128) break;
        startAfter = [...page.keys()].at(-1);
      }
      const lease = existing ? { ...existing, state: 'reserved' } : { client, id, state: 'reserved', createdAt: now, expiresAt: now + ttlMs };
      await tx.put(key, lease);
      return lease;
    });
  }
  async transition(client, id, expected, next, changes = {}) {
    return this.storage.transaction(async tx => {
      const key = `external-lease:${client}:${id}`, current = await tx.get(key);
      if (!current || !expected.includes(current.state)) return null;
      const lease = { ...current, ...changes, client, id, state: next };
      await tx.put(key, lease);
      return lease;
    });
  }
  async renew(client, id, ttlMs) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) throw new TypeError('invalid lease duration');
    return this.storage.transaction(async tx => {
      const key = `external-lease:${client}:${id}`, lease = await tx.get(key), now = this.now();
      if (!lease || lease.state !== 'active' || lease.expiresAt <= now) return null;
      const renewed = { ...lease, expiresAt: now + ttlMs };
      await tx.put(key, renewed);
      return renewed;
    });
  }
}

// The caller serializes this operation with the pool tick. A successful
// GitHub deletion fences assignment; an ambiguous result never grants a lease.
export class WarmLeaseFence {
  constructor(storage, api, now = Date.now) { Object.assign(this, { storage, api, now }); }
  async takeWarm(project, client, id, machineId) {
    return this.storage.transaction(async tx => {
      const boxKey = `project:${project}:box:${machineId}`, leaseKey = `external-lease:${client}:${id}`;
      const box = await tx.get(boxKey), lease = await tx.get(leaseKey);
      if (box?.state !== 'lease-warm' || box.leaseClient !== client || box.leaseIsolation !== lease?.isolation || box.size !== lease?.size || (box.baseId ?? null) !== (lease?.baseId ?? null) || lease?.state !== 'reserved' || lease.isolation !== 'external-v2' || lease.expiresAt <= this.now()) return false;
      await tx.put(boxKey, applyBoxEvent(box, 'lease_activate', { leaseId: id }, this.now()));
      await tx.put(leaseKey, { ...lease, state: 'active', machineId, reused: true });
      return true;
    });
  }
  async returnWarm(project, client, id) {
    const leaseKey = `external-lease:${client}:${id}`;
    const box = await this.storage.transaction(async tx => {
      const lease = await tx.get(leaseKey);
      if (lease?.state !== 'active' || lease.isolation !== 'external-v2') return null;
      const boxKey = `project:${project}:box:${lease.machineId}`, current = await tx.get(boxKey);
      if (current?.state !== 'leased' || current.leaseId !== id || current.leaseClient !== client || !current.baselineHash || (current.generation ?? 0) >= 59) return null;
      const next = applyBoxEvent(current, 'lease_return', { generation: (current.generation ?? 0) + 1, processId: null }, this.now());
      await tx.put(boxKey, next);
      await tx.put(leaseKey, { ...lease, state: 'returning', generation: next.generation, processId: null });
      return next;
    });
    if (!box) return false;
    try {
      const result = await this.api.lightReset(box, box.generation);
      if (!Number.isSafeInteger(result?.processId) || result.processId < 1) throw new Error('missing reset process');
      await this.storage.transaction(async tx => {
        const key = `project:${project}:box:${box.machineId}`, current = await tx.get(key), lease = await tx.get(leaseKey);
        if (current?.state !== 'lease-returning' || lease?.state !== 'returning' || current.leaseId !== id) throw new Error('lease lost');
        await tx.put(key, applyBoxEvent(current, 'lease_process', { processId: result.processId }, this.now()));
        await tx.put(leaseKey, { ...lease, processId: result.processId });
      });
    } catch { await this.destroy(project, client, id); }
    return true;
  }
  async completeReturn(project, client, id) {
    const leaseKey = `external-lease:${client}:${id}`, lease = await this.storage.get(leaseKey);
    if (lease?.state !== 'returning' || !Number.isSafeInteger(lease.processId)) return false;
    const boxKey = `project:${project}:box:${lease.machineId}`, box = await this.storage.get(boxKey);
    if (box?.state !== 'lease-returning' || box.leaseId !== id) return false;
    let result;
    try { result = await this.api.lightResetResult(box, lease.processId, lease.generation); } catch { result = { ok: false }; }
    if (result === null) return false;
    if (result?.ok !== true) { await this.destroy(project, client, id); return false; }
    // a lease box whose reset measured a slow disk or CPU (one measured 26.7 ms for one sync write) leaves
    // service at its return instead of going back to the warm pool. Only a measured slow host is retired here; the
    // reset command still runs in observe mode, so a lease box is never lost to a foreign-process or memory reading.
    const health = result.summary?.health;
    if (this.healthEnforce === true && health?.measured === true && health.slow === true) {
      await this.destroy(project, client, id, 'health_check', health);
      return false;
    }
    return this.storage.transaction(async tx => {
      const current = await tx.get(boxKey), item = await tx.get(leaseKey);
      if (current?.state !== 'lease-returning' || item?.state !== 'returning' || current.leaseId !== id) return false;
      await tx.put(boxKey, applyBoxEvent(current, 'lease_park', { leaseIsolation: item.isolation, onlineAt: null, leaseId: null, processId: null, jobs: (current.jobs ?? 0) + 1 }, this.now()));
      await tx.put(leaseKey, { ...item, state: 'closed', processId: null });
      return true;
    });
  }
  async fence(project, client, id, machineId) {
    const boxKey = `project:${project}:box:${machineId}`, leaseKey = `external-lease:${client}:${id}`;
    const reserved = await this.storage.transaction(async tx => {
      const box = await tx.get(boxKey), lease = await tx.get(leaseKey);
      if (!box || !(box.state === 'idle' || (box.state === 'local-held' && box.runnerFenced === true)) || !box.reusable || !box.baselineHash || !Number.isSafeInteger(box.runnerId) || !lease || box.baseId != null || lease.baseId != null || box.size !== lease.size || lease.state !== 'reserved' || lease.expiresAt <= this.now()) return null;
      await tx.put(boxKey, applyBoxEvent(box, 'lease_fence', { leaseClient: client, leaseId: id, leaseRunnerAlreadyFenced: box.state === 'local-held' }, this.now()));
      await tx.put(leaseKey, { ...lease, state: 'fencing', project, machineId });
      return box;
    });
    if (!reserved) return false;
    return this.resume(project, client, id);
  }
  async resume(project, client, id) {
    const leaseKey = `external-lease:${client}:${id}`, lease = await this.storage.get(leaseKey);
    if (!lease || lease.project !== project || lease.state !== 'fencing') return false;
    const boxKey = `project:${project}:box:${lease.machineId}`, box = await this.storage.get(boxKey);
    if (!box || box.state !== 'lease-fencing' || box.leaseId !== id || box.leaseClient !== client) return false;
    try { if (!box.leaseRunnerAlreadyFenced) await this.api.removeRunner(box); }
    catch (error) {
      if (error.status === 422) {
        await this.storage.transaction(async tx => {
          const current = await tx.get(boxKey), item = await tx.get(leaseKey);
          if (current?.state === 'lease-fencing' && item?.state === 'fencing' && current.leaseId === id) {
            await tx.put(boxKey, applyBoxEvent(current, 'lease_fence_busy', { leaseClient: null, leaseId: null }, this.now()));
            await tx.put(leaseKey, { ...item, state: 'reserved', machineId: null });
          }
        });
      }
      if (error.status !== 404) return false;
    }
    const generation = (box.generation ?? 0) + 1;
    // Record the reset intent first. If the call is uncertain, cleanup destroys
    // the box rather than starting a second reset or exposing it to a client.
    const claimed = await this.storage.transaction(async tx => {
      const current = await tx.get(boxKey), item = await tx.get(leaseKey);
      if (current?.state !== 'lease-fencing' || item?.state !== 'fencing' || current.leaseId !== id) return false;
      await tx.put(boxKey, applyBoxEvent(current, 'lease_reset_start', { runnerFenced: true, generation }, this.now()));
      await tx.put(leaseKey, { ...item, state: 'resetting', generation });
      return true;
    });
    if (!claimed) return false;
    try {
      const result = await this.api.lightReset({ ...box, generation }, generation);
      if (!Number.isSafeInteger(result?.processId) || result.processId < 1) throw new Error('missing reset process');
      await this.storage.transaction(async tx => {
        const current = await tx.get(boxKey), item = await tx.get(leaseKey);
        if (current?.state !== 'lease-resetting' || item?.state !== 'resetting' || current.leaseId !== id) throw new Error('lease lost');
        await tx.put(boxKey, applyBoxEvent(current, 'lease_process', { processId: result.processId }, this.now()));
        await tx.put(leaseKey, { ...item, processId: result.processId });
      });
      return true;
    } catch {
      await this.destroy(project, client, id);
      return false;
    }
  }
  async completeReset(project, client, id) {
    const leaseKey = `external-lease:${client}:${id}`, lease = await this.storage.get(leaseKey);
    if (!lease || lease.project !== project || lease.state !== 'resetting' || !Number.isSafeInteger(lease.processId)) return false;
    const boxKey = `project:${project}:box:${lease.machineId}`, box = await this.storage.get(boxKey);
    if (!box || box.state !== 'lease-resetting' || box.leaseId !== id) return false;
    let result;
    try { result = await this.api.lightResetResult(box, lease.processId, lease.generation); }
    catch { result = { ok: false }; }
    if (result === null) return false;
    if (result?.ok !== true || (lease.expiresAt <= this.now() && !lease.releaseRequested)) { await this.destroy(project, client, id); return false; }
    return this.storage.transaction(async tx => {
      const current = await tx.get(boxKey), item = await tx.get(leaseKey);
      if (current?.state !== 'lease-resetting' || item?.state !== 'resetting' || current.leaseId !== id || (item.expiresAt <= this.now() && !item.releaseRequested)) return false;
      const orphan = item.releaseRequested === true && item.isolation === 'external-v2';
      await tx.put(boxKey, applyBoxEvent(current, orphan ? 'lease_park' : 'lease_activate', { runnerId: null, runnerName: null, runnerIdentity: null, processId: null, ...(orphan ? { leaseId: null, leaseIsolation: item.isolation } : {}) }, this.now()));
      await tx.put(leaseKey, { ...item, state: orphan ? 'closed' : 'active', processId: null });
      return true;
    });
  }
  async destroy(project, client, id, retirementReason = 'lease_cleanup', health = null) {
    const leaseKey = `external-lease:${client}:${id}`;
    return this.storage.transaction(async tx => {
      const lease = await tx.get(leaseKey);
      if (!lease || lease.project !== project || !lease.machineId || lease.state === 'closed') return false;
      const boxKey = `project:${project}:box:${lease.machineId}`, box = await tx.get(boxKey);
      if (!box || box.leaseId !== id || box.leaseClient !== client || !['lease-booting', 'lease-baselining', 'lease-resetting', 'lease-returning', 'leased'].includes(box.state)) return false;
      await tx.put(boxKey, applyBoxEvent(box, 'lease_destroy', { runnerFenced: true, retirementReason, ...(health ? { slowHost: health.slow === true, lastResetSummary: { health }, ...(health.cpu ? { hostCpu: health.cpu } : {}) } : {}) }, this.now()));
      await tx.put(leaseKey, { ...lease, state: 'cleaning' });
      return true;
    });
  }
}

export class ExternalLeaseStarts {
  constructor(storage, ledger, api, now = Date.now, createAccount) { Object.assign(this, { storage, ledger, api, now, createAccount }); }
  // a base snapshot copied to the secondary account keeps its name and content but has its own snapshot id.
  // `secondaryBases` maps a base kind to { name, snapshotId } of that copy (operator-pinned, like the primary base).
  secondaryBase(lease) {
    const base = this.secondaryBases?.[lease?.routerSnapshot?.kind];
    return base && base.name === lease.routerSnapshot?.name && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(base.snapshotId ?? '') ? base : null;
  }
  async leaseIdentity(lease, account = 'primary') {
    if (!lease.baseId) return true;
    const selected = lease.routerSnapshot;
    if (!validLeaseSnapshot(selected)) return false;
    // A rolling generation's base identity is its manifest digest, already
    // encoded in the name; the base kinds recompute theirs from the tuple.
    const computed = selected.kind === 'peek-ci' ? { baseId: selected.manifestSha256 } : selected.kind === 'browser-v1' ? await browserBase({ BROWSER_BASE_SNAPSHOT_NAME: selected?.name, BROWSER_BASE_SNAPSHOT_ID: selected?.snapshotId, BROWSER_BASE_TOOLCHAIN_SHA256: selected?.manifestSha256, BROWSER_BASE_FILES_SHA256: selected?.browserManifestSha256, BROWSER_BASE_PROFILE_SHA256: selected?.profileSha256 }) : await leaseBase({ LEASE_BASE_SNAPSHOT_NAME: selected?.name, LEASE_BASE_SNAPSHOT_ID: selected?.snapshotId, LEASE_BASE_MANIFEST_SHA256: selected?.manifestSha256, LEASE_BASE_PROFILE_SHA256: selected?.profileSha256 });
    if (computed?.baseId !== lease.baseId) return false;
    const expectedId = account === 'secondary' ? this.secondaryBase(lease)?.snapshotId : selected.snapshotId;
    if (!expectedId) return false;
    // A single-account router has no account switch and reads the primary
    // account directly; only a secondary snapshot needs the switch.
    let api = this.api;
    if (typeof this.api.forIdentity === 'function') api = await this.api.forIdentity({ account });
    else if (account !== 'primary') return false;
    try {
      const found = (await api.request('boat', `/saved-snapshots/${encodeURIComponent(selected.name)}`))?.snapshot;
      return found?.status === 'ready' && found.snapshotId === expectedId;
    } catch { return false; }
  }
  async start(client, id, project, size, pool, limits, ttlSeconds) {
    const key = `external-lease:${client}:${id}`;
    let lease = await this.storage.get(key);
    if (!lease || !['reserved', 'starting'].includes(lease.state) || (lease.state === 'reserved' && (lease.expiresAt <= this.now() || lease.releaseRequested))) return false;
    // A selected base must have a complete, durable snapshot selection before
    // any ledger admission or provider call. Never fall back to a plain box.
    const validSelection = !((lease.baseId != null || lease.routerSnapshot != null) && (!/^[a-f0-9]{64}$/.test(lease.baseId ?? '') || !validLeaseSnapshot(lease.routerSnapshot) || (lease.routerSnapshot?.kind !== 'peek-ci' && lease.isolation !== 'external-v2')))
      && !(lease.rollingSnapshot === true && lease.routerSnapshot?.kind !== 'peek-ci');
    const identityAtStart = validSelection && (!(lease.baseId || lease.routerSnapshot) || !lease.account || lease.account === 'primary' || (lease.account === 'secondary' && this.secondaryBase(lease))) && await this.leaseIdentity(lease, lease.account === 'secondary' ? 'secondary' : 'primary');
    if (!identityAtStart && lease.state === 'reserved') return false;
    if (lease.state === 'reserved') {
      const createKey = crypto.randomUUID();
      const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([project, createKey])));
      const claimKey = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
      const routerCreateName = `boat-router-${claimKey.slice(0, 32)}`;
      lease = await this.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (current?.state !== 'reserved') return null;
        const next = { ...current, state: 'starting', project, size, pool, createKey, claimKey, routerCreateName, machineTtlSeconds: ttlSeconds, ...(this.createAccount ? { account: this.createAccount } : {}) };
        await tx.put(key, next); return next;
      });
      if (!lease) return false;
    }
    if (lease.project !== project || lease.size !== size || lease.pool !== pool) return false;
    let claim = await this.ledger.claim(lease.claimKey);
    // An uncertain provider call must still be reconciled, even if the image
    // is no longer verifiable. A found box is retired below, never granted.
    if (!identityAtStart && (!claim || claim.status === 'pending')) {
      if (lease.expiresAt <= this.now() || lease.releaseRequested) {
        await this.ledger.abandon(project, lease.claimKey);
        await this.storage.put(key, { ...lease, state: 'closed' });
      }
      return false;
    }
    if (this.createAccount && !lease.account && !claim) return false;
    if (this.ledger.selectForLease && (!claim || claim.status === 'pending')) {
      const account = await this.ledger.selectForLease(lease);
      if (!account) {
        // With no ledger claim, no create was admitted. Reconsider warm boxes
        // on the next request instead of pinning this lease in starting.
        if (!await this.ledger.claim(lease.claimKey)) await this.storage.transaction(async tx => {
          const current = await tx.get(key);
          if (current?.state !== 'starting' || current.claimKey !== lease.claimKey) return;
          const { createKey, claimKey, routerCreateName, account: unusedAccount, ...reserved } = current;
          await tx.put(key, { ...reserved, state: 'waiting', lastReason: 'start_capacity' });
        });
        return false;
      }
      lease = await this.storage.transaction(async tx => {
        const current = await tx.get(key);
        if (!current || current.state !== 'starting' || current.claimKey !== lease.claimKey) return null;
        const updated = { ...current, account }; await tx.put(key, updated); return updated;
      });
      if (!lease) return false;
      claim = await this.ledger.claim(lease.claimKey);
    }
    if ((lease.baseId != null || lease.routerSnapshot != null) && lease.account !== 'primary' && !(lease.account === 'secondary' && this.secondaryBase(lease) && await this.leaseIdentity(lease, 'secondary')) && (!claim || claim.status === 'pending')) return false;
    if ((!claim || claim.status === 'pending') && (lease.expiresAt <= this.now() || lease.releaseRequested)) {
      await this.ledger.abandon(project, lease.claimKey);
      await this.storage.put(key, { ...lease, state: 'closed' });
      return false;
    }
    if (!claim) {
      await this.ledger.enqueue(project, lease.claimKey, lease.createdAt, undefined, { client });
      const admitted = await this.ledger.admit(project, lease.claimKey, limits, { cost: { kind: 'machine', size: lease.size, ttlSeconds: lease.machineTtlSeconds ?? ttlSeconds } });
      if (!admitted.ok) {
        await this.storage.put(key, { ...lease, lastReason: admitted.reason });
        return false;
      }
      claim = await this.ledger.claim(lease.claimKey);
    }
    let sandbox;
    if (claim.status === 'pending') {
      if (!await this.ledger.begin(project, lease.claimKey)) return false;
      try {
        // A lease box is created for a client: no environment, no tailnet identity
        // on its disk, and only the client's own registry network policy.
        const result = await this.api.create({ ...(lease.account ? { account: lease.account } : {}), createKey: lease.createKey, routerCreateName: lease.routerCreateName, machineSize: size, routerReusable: lease.isolation === 'external-v2', noTailnet: true, ...(lease.network ? { network: lease.network } : {}), ...(lease.routerSnapshot ? { routerSnapshot: lease.routerSnapshot } : {}) }, lease.machineTtlSeconds ?? ttlSeconds);
        sandbox = result?.sandbox;
        if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox?.id ?? '')) throw new Error('invalid sandbox');
      } catch (error) {
        const refused = error?.service === 'boat' && ((error.status >= 400 && error.status < 500 && ![408, 409].includes(error.status)) || error.code === 'request_not_sent');
        // failFast answers "no machine of this type is ready" with 503 and creates
        // nothing billed or counted, so the start is retryable: return the lease
        // to the queue instead of pinning it in starting until it expires.
        const noCapacity = error?.service === 'boat' && error.status === 503 && error.code === 'no_ready_machine';
        // a secondary refusal (no credit, plan, rate) parks the secondary account for later leases.
        if (refused && lease.account === 'secondary' && [402, 403, 429].includes(error.status) && typeof this.ledger.blockAccount === 'function') {
          try { await this.ledger.blockAccount('secondary', `lease_${error.status}`, error.status === 429 ? Math.max(30_000, Math.min(900_000, (error.retrySeconds ?? 0) * 1000)) : undefined); } catch {}
        }
        await this.ledger.resolve(lease.claimKey, refused || noCapacity ? 'not_created' : 'unknown');
        if (refused) await this.storage.put(key, { ...lease, state: 'closed' });
        else if (noCapacity) await this.storage.transaction(async tx => {
          const current = await tx.get(key);
          if (current?.state !== 'starting' || current.claimKey !== lease.claimKey) return;
          const { createKey, claimKey, routerCreateName, account: unusedAccount, ...waiting } = current;
          await tx.put(key, { ...waiting, state: 'waiting', lastReason: 'start_capacity' });
        });
        return false;
      }
    } else {
      sandbox = await this.api.findCreated(lease);
      if (!sandbox) return false;
    }
    if (!/^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/.test(sandbox?.id ?? '')) return false;
    const identityStillValid = identityAtStart && await this.leaseIdentity(lease);
    await this.ledger.resolve(lease.claimKey, 'created');
    const recorded = await this.storage.transaction(async tx => {
      const current = await tx.get(key), boxKey = `project:${project}:box:${sandbox.id}`, existing = await tx.get(boxKey);
      if (current?.state !== 'starting' || (existing && existing.createKey !== lease.createKey)) return false;
      if (!existing) await tx.put(boxKey, applyBoxEvent(null, 'lease_start', { machineId: sandbox.id, ...(lease.account ? { account: lease.account } : {}), ...(lease.baseId ? { baseId: lease.baseId, routerSnapshot: lease.routerSnapshot } : {}), pool, originPool: pool, size, createKey: lease.createKey, machineTtlSeconds: lease.machineTtlSeconds ?? ttlSeconds, createdAt: this.now(), generation: 0, reusable: false, jobs: 0, runnerFenced: true, leaseClient: client, leaseId: id }, this.now()));
      await tx.put(key, { ...current, state: 'booting', machineId: sandbox.id });
      return true;
    });
    if (recorded && !identityStillValid) {
      await new WarmLeaseFence(this.storage, this.api, this.now).destroy(project, client, id);
      return false;
    }
    return recorded;
  }
  async ready(client, id) {
    const key = `external-lease:${client}:${id}`, lease = await this.storage.get(key);
    if (!lease || lease.state !== 'booting') return false;
    const result = await this.api.sandbox({ machineId: lease.machineId });
    if (result?.sandbox?.setupStatus !== 'done' || !['ready', 'idle', 'running'].includes(result?.sandbox?.state)) return false;
    if (lease.isolation === 'external-v2') {
      const boxKey = `project:${lease.project}:box:${lease.machineId}`;
      const box = await this.storage.transaction(async tx => {
        const current = await tx.get(key), item = await tx.get(boxKey);
        if (current?.state !== 'booting' || item?.state !== 'lease-booting' || (current.expiresAt <= this.now() && !current.releaseRequested)) return null;
        await tx.put(key, { ...current, state: 'baselining', processId: null });
        const next = applyBoxEvent(item, 'lease_baseline_start', { processId: null, reusable: true }, this.now());
        await tx.put(boxKey, next); return next;
      });
      if (!box) return false;
      try {
        const started = await this.api.refresh(box, 'baseline', 0);
        if (!Number.isSafeInteger(started?.processId) || started.processId < 1) throw new Error('missing baseline process');
        await this.storage.transaction(async tx => {
          const current = await tx.get(key), item = await tx.get(boxKey);
          if (current?.state !== 'baselining' || item?.state !== 'lease-baselining') throw new Error('lease lost');
          await tx.put(key, { ...current, processId: started.processId });
          await tx.put(boxKey, applyBoxEvent(item, 'lease_process', { processId: started.processId }, this.now()));
        });
      } catch { await new WarmLeaseFence(this.storage, this.api, this.now).destroy(lease.project, client, id); }
      return false;
    }
    return this.storage.transaction(async tx => {
      const current = await tx.get(key), boxKey = `project:${lease.project}:box:${lease.machineId}`, box = await tx.get(boxKey);
      if (current?.state !== 'booting' || current.expiresAt <= this.now() || box?.state !== 'lease-booting' || box.leaseId !== id) return false;
      await tx.put(boxKey, applyBoxEvent(box, 'lease_activate', {}, this.now()));
      await tx.put(key, { ...current, state: 'active' });
      return true;
    });
  }
  async baselineReady(client, id) {
    const key = `external-lease:${client}:${id}`, lease = await this.storage.get(key);
    if (lease?.state !== 'baselining' || !Number.isSafeInteger(lease.processId)) return false;
    const boxKey = `project:${lease.project}:box:${lease.machineId}`, box = await this.storage.get(boxKey);
    if (box?.state !== 'lease-baselining' || box.leaseId !== id) return false;
    let result;
    try { result = await this.api.refreshResult(box, lease.processId, 0); } catch { result = { ok: false }; }
    if (result === null) return false;
    if (result?.ok !== true || !/^[a-f0-9]{64}$/.test(result.baselineHash ?? '') || (lease.expiresAt <= this.now() && !lease.releaseRequested)) {
      await new WarmLeaseFence(this.storage, this.api, this.now).destroy(lease.project, client, id); return false;
    }
    return this.storage.transaction(async tx => {
      const current = await tx.get(key), item = await tx.get(boxKey);
      if (current?.state !== 'baselining' || item?.state !== 'lease-baselining' || (current.expiresAt <= this.now() && !current.releaseRequested)) return false;
      const orphan = current.releaseRequested === true;
      await tx.put(boxKey, applyBoxEvent(item, orphan ? 'lease_park' : 'lease_activate', { baselineHash: result.baselineHash, processId: null, ...(orphan ? { leaseId: null, leaseIsolation: current.isolation } : {}) }, this.now()));
      await tx.put(key, { ...current, state: orphan ? 'closed' : 'active', processId: null });
      return true;
    });
  }
}
