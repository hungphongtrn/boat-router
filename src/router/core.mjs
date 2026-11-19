import { TenantStorage } from './tenant-storage.mjs';
import { AccountLedger } from './ledger.mjs';
import { validateSuite } from './plugins.mjs';
import { selectWorkflowJob } from './select.mjs';

export class Router {
  constructor(storage, account, suites, { now = Date.now } = {}) {
    this.storage = storage;
    this.now = now;
    this.account = account;
    this.ledger = new AccountLedger(storage, account, now);
    this.projects = new Map();
    // One repository may feed several tenants, for example a suite
    // controller and an Actions JIT pool. Each tenant selects only its
    // own events; the first match in registration order wins.
    this.repositories = new Map();
    for (const suite of suites) {
      const errors = validateSuite(suite.config, suite.hooks);
      if (suite.config?.account !== account.id) errors.push('wrong account');
      if (this.projects.has(suite.config?.id)) errors.push('duplicate project');
      const peers = this.repositories.get(suite.config?.repo) ?? [];
      if (peers.length && peers.some(peer => !peer.hooks?.selectEvent && !suite.hooks?.selectEvent)) errors.push('duplicate repository');
      if (errors.length) throw new TypeError(errors.join('; '));
      const project = { ...suite, storage: new TenantStorage(storage, suite.config.id) };
      this.projects.set(suite.config.id, project);
      this.repositories.set(suite.config.repo, [...peers, project]);
    }
  }
  select(name, payload) {
    for (const project of this.repositories.get(payload?.repository?.full_name) ?? []) {
      const event = project.hooks?.selectEvent
        ? project.hooks.selectEvent({ name, payload }, project.config)
        : selectWorkflowJob(name, payload, project.config);
      if (!event) continue;
      if (event.repo !== project.config.repo || !Number.isSafeInteger(event.installation) || event.installation < 1) throw new TypeError('invalid project event');
      return { project: project.config.id, event };
    }
    return null;
  }
  async ingest(selection) {
    const project = this.projects.get(selection?.project), event = selection?.event;
    if (!project || event?.repo !== project.config.repo || !Number.isSafeInteger(event.installation) || event.installation < 1) throw new TypeError('invalid selection');
    this.localCounts = null;
    await project.ingest(event, { storage: project.storage, ledger: this.ledger, config: project.config, hooks: project.hooks });
    this.localCounts = null;
  }
  localCountsCache() {
    const now = this.now();
    if (!this.localCounts || now - this.localCounts.at >= 1000 || now < this.localCounts.at) this.localCounts = { at: now, values: new Map() };
    return this.localCounts.values;
  }
  async dispatch(name, payload) {
    const selection = this.select(name, payload);
    if (!selection) return false;
    await this.ingest(selection);
    return true;
  }
  async tick() {
    if (this.ticking) return this.ticking;
    this.ledger.paidTick = { used: false };
    this.ticking = this.runTick().finally(() => { this.ledger.paidTick = null; this.ticking = null; });
    return this.ticking;
  }
  // Local claims may run only at an admission boundary. They must not race a
  // provider start, but they need not wait for the whole tick to finish.
  async localAtBoundary(operation) {
    if (!this.ticking) {
      let unlock;
      const lock = new Promise(resolve => { unlock = resolve; });
      this.ticking = lock;
      try {
        const value = await operation();
        await this.drainLocalQueue();
        return { ran: true, value };
      } finally {
        if (this.ticking === lock) this.ticking = null;
        unlock();
      }
    }
    return new Promise((resolve, reject) => {
      const entry = { operation, resolve, reject, expired: false };
      entry.timer = setTimeout(() => { entry.expired = true; resolve({ ran: false }); }, 10_000);
      (this.localQueue ??= []).push(entry);
    });
  }
  async drainLocalQueue() {
    let ran = false;
    while (this.localQueue?.length) {
      const entry = this.localQueue.shift();
      if (entry.expired) continue;
      ran = true;
      clearTimeout(entry.timer);
      try { entry.resolve({ ran: true, value: await entry.operation() }); }
      catch (error) { entry.reject(error); }
    }
    return ran;
  }
  // An offer is a real agent slot held on a specific admitted mini. It waits
  // without registering a GitHub runner. A tick consumes it only for a job.
  offerLocal(operation, cleanup, signal, waitMs = 8000) {
    return new Promise((resolve, reject) => {
      const entry = { operation, cleanup, resolve, reject, closed: false, running: false };
      const close = () => {
        entry.closed = true;
        if (!entry.running) {
          if (this.localOffers) this.localOffers = this.localOffers.filter(item => item !== entry);
          entry.detach?.();
          resolve(null);
        }
      };
      entry.timer = setTimeout(close, waitMs);
      if (signal?.aborted) close();
      else signal?.addEventListener('abort', close, { once: true });
      entry.detach = () => { clearTimeout(entry.timer); signal?.removeEventListener('abort', close); };
      if (entry.closed) entry.detach(); else (this.localOffers ??= []).push(entry);
    });
  }
  async drainLocalOffers() {
    let claimed = false;
    const cache = new Map();
    const offers = this.localOffers ?? [];
    this.localOffers = [];
    for (const offer of offers) {
      if (offer.closed) { offer.detach(); continue; }
      offer.running = true;
      try {
        const value = await offer.operation(cache);
        offer.running = false;
        if (value) {
          claimed = true;
          offer.detach();
          if (offer.closed) { await offer.cleanup(value); offer.resolve(null); }
          else offer.resolve(value);
        } else if (offer.closed) { offer.detach(); offer.resolve(null); }
        else this.localOffers.push(offer);
      } catch (error) { offer.detach(); offer.reject(error); }
    }
    return claimed;
  }
  async runTick() {
    if (this.externalSweep) { try { await this.externalSweep(); } catch {} }
    const projects = [...this.projects.values()];
    const context = project => ({ storage: project.storage, ledger: this.ledger, config: project.config, hooks: project.hooks });
    const prepared = await Promise.allSettled(projects.map(async project => project.prepare?.(context(project))));
    let startPreparationFailed = prepared.some(result => result.status === 'rejected');
    const refreshAfterClaims = async () => {
      const queued = await this.drainLocalQueue?.();
      const offered = await this.drainLocalOffers?.();
      if (!queued && !offered) return;
      const refreshed = await Promise.allSettled(projects.map(project => project.prepare?.(context(project))));
      if (refreshed.some(result => result.status === 'rejected')) startPreparationFailed = true;
    };
    await refreshAfterClaims();
    const entries = await Promise.all(projects.map(async project => {
      try { return (await project.admissionEntries?.(context(project)) ?? []).map(item => ({ ...item, project })); }
      catch { if (this.account?.openStartQueue === true) startPreparationFailed = true; return []; }
    }));
    let external = [];
    if (this.account?.openStartQueue === true && this.externalAdmissionEntries) {
      try { external = (await this.externalAdmissionEntries()).map(item => ({ ...item, external: true })); }
      catch { startPreparationFailed = true; }
    }
    const ordered = [...entries.flat(), ...external].sort((a, b) => a.at - b.at || a.rank.localeCompare(b.rank));
    for (const item of ordered) {
      await refreshAfterClaims();
      if (item.external) {
        if (!startPreparationFailed) { try { await this.externalAdmitStart(item); } catch { /* Retry the lease on a later tick. */ } }
      } else await item.project.admitStart(item.key, { ...context(item.project), startPreparationFailed });
    }
    await refreshAfterClaims();
    const results = await Promise.allSettled(projects.map(async (project, i) =>
      project.tick({ ...context(project), startPreparationFailed, globalAdmission: Boolean(project.admissionEntries) })));
    await this.drainLocalQueue?.();
    return Promise.all(results.map(async (result, i) => {
      const project = projects[i];
      if (prepared[i].status === 'rejected') result = prepared[i];
      if (result.status === 'fulfilled') return { project: project.config.id, ok: true };
      const allowed = ['Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError'];
      const fault = { at: this.now(), stage: prepared[i].status === 'rejected' ? 'prepare' : 'tick', errorClass: allowed.includes(result.reason?.name) ? result.reason.name : 'Error', message: '[redacted]' };
      try { await project.storage.put('router:last-fault', fault); } catch {}
      return { project: project.config.id, ok: false, error: fault.message, errorClass: fault.errorClass };
    }));
  }
}
