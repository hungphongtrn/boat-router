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
    this.repositories = new Map();
    for (const suite of suites) {
      const errors = validateSuite(suite.config, suite.hooks);
      if (suite.config?.account !== account.id) errors.push('wrong account');
      if (this.projects.has(suite.config?.id)) errors.push('duplicate project');
      if (this.repositories.has(suite.config?.repo)) errors.push('duplicate repository');
      if (errors.length) throw new TypeError(errors.join('; '));
      const project = { ...suite, storage: new TenantStorage(storage, suite.config.id) };
      this.projects.set(suite.config.id, project);
      this.repositories.set(suite.config.repo, project);
    }
  }
  select(name, payload) {
    const project = this.repositories.get(payload?.repository?.full_name);
    if (!project) return null;
    const event = project.hooks?.selectEvent
      ? project.hooks.selectEvent({ name, payload }, project.config)
      : selectWorkflowJob(name, payload, project.config);
    if (!event) return null;
    if (event.repo !== project.config.repo || !Number.isSafeInteger(event.installation) || event.installation < 1) throw new TypeError('invalid project event');
    return { project: project.config.id, event };
  }
  async ingest(selection) {
    const project = this.projects.get(selection?.project), event = selection?.event;
    if (!project || event?.repo !== project.config.repo || !Number.isSafeInteger(event.installation) || event.installation < 1) throw new TypeError('invalid selection');
    await project.ingest(event, { storage: project.storage, ledger: this.ledger, config: project.config, hooks: project.hooks });
  }
  async dispatch(name, payload) {
    const selection = this.select(name, payload);
    if (!selection) return false;
    await this.ingest(selection);
    return true;
  }
  async tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.runTick().finally(() => { this.ticking = null; });
    return this.ticking;
  }
  async runTick() {
    const projects = [...this.projects.values()];
    const context = project => ({ storage: project.storage, ledger: this.ledger, config: project.config, hooks: project.hooks });
    const prepared = await Promise.allSettled(projects.map(async project => project.prepare?.(context(project))));
    const startPreparationFailed = prepared.some(result => result.status === 'rejected');
    const entries = await Promise.all(projects.map(async project => {
      try { return (await project.admissionEntries?.(context(project)) ?? []).map(item => ({ ...item, project })); }
      catch { return []; }
    }));
    const ordered = entries.flat().sort((a, b) => a.at - b.at || a.rank.localeCompare(b.rank));
    for (const item of ordered) await item.project.admitStart(item.key, { ...context(item.project), startPreparationFailed });
    const results = await Promise.allSettled(projects.map(async (project, i) =>
      project.tick({ ...context(project), startPreparationFailed, globalAdmission: Boolean(project.admissionEntries) })));
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
