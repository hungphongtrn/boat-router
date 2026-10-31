const active = runner => ['claiming', 'pending', 'started', 'retiring'].includes(runner.state);
const queued = job => !job.intentDone && !job.intentStarted && !['done', 'attention'].includes(job.phase);
const boatPending = job => ['queued', 'waiting', 'configuring', 'starting', 'running', 'pool_baseline_launch', 'pool_baseline_wait'].includes(job.phase) && !job.haltAfterCleanup && !job.assignedJobId && Boolean(job.createPending || job.machineId);
// GitHub can assign a JIT runner to any queued job with the same label, even
// one which the router stopped counting as demand. Keep local runners out of
// a pool until every potentially queued job with Boat history is resolved.
const unresolvedBoat = job => !job.intentDone && !job.intentStarted && (job.phase === 'attention' || Boolean(job.localBoatHistory || job.machineId || job.lastMachineId || job.createPending || job.createAttemptedAt || job.retryCount || job.attempts));

async function all(store, prefix) {
  const values = []; let startAfter = '';
  for (;;) {
    const page = await store.list({ prefix, startAfter, limit: 128 });
    values.push(...page.values());
    if (page.size < 128) return values;
    startAfter = [...page.keys()].at(-1);
  }
}

export class LocalFleet {
  constructor(controller, config) { this.controller = controller; this.storage = controller.storage; this.api = controller.api; this.now = controller.now; this.config = config; }
  enabled(label) { return this.config?.enabled === true && typeof this.config.labels?.[label] === 'string' && Boolean(this.config.labels[label]); }
  offerMs() { return (this.config.offerSeconds ?? 30) * 1000; }
  timeoutMs() { return (this.config.claimSeconds ?? 900) * 1000; }
  async counts(tx, label) {
    const storedMode = await tx.get('pool:mode');
    const mode = (await tx.get('pool:migrated'))?.done && storedMode !== 'on' ? 'drain' : storedMode;
    if (['on', 'drain'].includes(mode)) {
      const project = this.controller.poolProject, pool = poolKey(project.repo, label), snapshot = await tx.get('pool:snapshot');
      const jobs = (await all(tx, 'gh-job:')).filter(job => job.pool === pool && job.status === 'queued' && (!job.missing || !snapshot?.complete));
      const local = (await all(tx, 'local-runner:')).filter(runner => runner.label === label && active(runner));
      const boxes = (await all(tx, 'box:')).filter(box => box.pool === pool && !box.drainOnly);
      const creates = (await all(tx, 'create:')).filter(create => create.pool === pool);
      const runners = snapshot?.complete ? snapshot.runners ?? [] : [];
      const known = new Set([...boxes.map(box => box.runnerName), ...local.map(runner => runner.name)]);
      const observed = name => runners.find(runner => runner.name === name);
      const units = [
        ...boxes.map(box => ({ ...box, online: observed(box.runnerName)?.status === 'online', busy: observed(box.runnerName)?.busy === true })),
        ...creates.map(create => ({ ...create, kind: 'create' })),
        ...local.map(runner => ({ ...runner, kind: 'local', online: observed(runner.name)?.status === 'online', busy: observed(runner.name)?.busy === true })),
        ...runners.filter(runner => !known.has(runner.name) && (runner.labels ?? []).some(item => (typeof item === 'string' ? item : item.name) === label)).map(runner => ({ kind: 'foreign', snapshotComplete: true, online: runner.status === 'online', busy: runner.busy === true })),
      ];
      const supply = Object.values(supplyCounts(units, this.now(), this.config)).reduce((a, b) => a + b, 0);
      const installation = await tx.get('pool:installation') ?? project.installation;
      return { jobs: jobs.map(job => ({ ...job, repo: project.repo, installation, size: poolSize(project, label), createdAt: job.queuedAt })), supply, local, boatFence: mode === 'drain', poolMode: true };
    }
    const jobs = (await all(tx, 'job:')).filter(job => job.label === label);
    const local = (await all(tx, 'local-runner:')).filter(runner => runner.label === label && active(runner));
    return { jobs: jobs.filter(queued), supply: jobs.filter(boatPending).length + local.length, local, boatFence: jobs.some(job => unresolvedBoat(job) || boatPending(job)) };
  }
  async allowBoat(tx, job) {
    if (this.config.localOnly?.includes(job.label)) return false;
    if (!this.enabled(job.label)) return true;
    const { jobs, supply, local } = await this.counts(tx, job.label);
    if (local.length) return false;
    return jobs.filter(item => item.createdAt + this.offerMs() <= this.now()).length > supply;
  }
  async claim(label) {
    if (!this.enabled(label) || this.controller.env?.ENABLED !== 'true') return null;
    const name = `local-${crypto.randomUUID()}`;
    const record = await this.storage.transaction(async tx => {
      if (this.controller.poolProject && (await tx.get('pool:mode')) !== 'on') return null;
      const { jobs, supply, boatFence, poolMode } = await this.counts(tx, label);
      if (boatFence) return null;
      const candidates = jobs.filter(job => poolMode || this.config.localOnly?.includes(job.label) || job.createdAt + this.offerMs() > this.now()).sort((a, b) => a.createdAt - b.createdAt);
      if (supply >= jobs.length || !candidates.length) return null;
      const job = candidates[0];
      if (!Number.isSafeInteger(job.installation) || job.installation < 1) return null;
      const epoch = this.controller.env.RESUME_EPOCH ?? '0';
      if ((await tx.get('blocked'))?.epoch === epoch || (await tx.get(`size-block:${job.size}`))?.epoch === epoch || (await tx.get('verification:breaker'))?.tripped) return null;
      const runner = { name, label, repo: job.repo, installation: job.installation, jobId: job.id, state: 'claiming', at: this.now() };
      await tx.put(`local-runner:${name}`, runner);
      return runner;
    });
    if (!record) return null;
    await this.controller.wake();
    try {
      const jit = await this.api.github(record, '/actions/runners/generate-jitconfig', { method: 'POST', body: { name, runner_group_id: 1, labels: [label], work_folder: '_work' } });
      if (!Number.isSafeInteger(jit.runner?.id) || typeof jit.encoded_jit_config !== 'string') throw new Error('invalid registration');
      await this.storage.transaction(async tx => {
        const current = await tx.get(`local-runner:${name}`);
        if (current?.state !== 'claiming') throw new Error('claim lost');
        await tx.put(`local-runner:${name}`, { ...current, runnerId: jit.runner.id, state: 'pending' });
      });
      return { name, label, class: this.config.labels[label], jitConfig: jit.encoded_jit_config };
    } catch (error) {
      const refused = Number.isInteger(error.status) && error.status >= 400 && error.status < 500;
      await this.storage.transaction(async tx => {
        const current = await tx.get(`local-runner:${name}`);
        if (current?.state === 'claiming') await tx.put(`local-runner:${name}`, refused ? { ...current, state: 'retired', retiredAt: this.now() } : { ...current, state: 'retiring', retiringAt: this.now() });
      });
      await this.controller.wake();
      throw new Error(refused ? 'local registration refused' : 'local registration uncertain');
    }
  }
  async started(name) {
    return this.storage.transaction(async tx => {
      const runner = await tx.get(`local-runner:${name}`);
      if (runner && ['started', 'assigned', 'retired'].includes(runner.state)) return true;
      if (!runner || runner.state !== 'pending') return false;
      await tx.put(`local-runner:${name}`, { ...runner, state: 'started', startedAt: this.now() });
      return true;
    });
  }
  async release(name) {
    const runner = await this.storage.transaction(async tx => {
      const key = `local-runner:${name}`, current = await tx.get(key);
      if (current?.state === 'retired') return current;
      if (!current || !active(current)) return null;
      await tx.put(key, { ...current, state: 'retiring', retiringAt: current.retiringAt ?? this.now() });
      return current;
    });
    if (!runner) return false;
    if (runner.state === 'retired') return true;
    const removed = await this.remove(name);
    if (removed) await this.controller.wake();
    return removed;
  }
  async remove(name) {
    const key = `local-runner:${name}`, runner = await this.storage.get(key);
    if (runner?.state !== 'retiring') return false;
    let id = runner.runnerId;
    if (!id) {
      if (this.now() - runner.at < 60_000) return false;
      let result;
      try { result = await this.api.github(runner, `/actions/runners?name=${encodeURIComponent(name)}&per_page=100`); } catch { return false; }
      if (!Array.isArray(result.runners) || result.runners.length >= 100) return false;
      const found = result.runners.filter(item => item.name === name);
      if (found.length > 1 || found.some(item => item.busy || item.status === 'online')) return false;
      if (found.length) { id = found[0]?.id; if (!Number.isSafeInteger(id) || id < 1) return false; }
    }
    if (id) {
      try {
        const current = await this.api.runner({ ...runner, runnerId: id });
        if (current.busy) return false;
        await this.api.removeRunner({ ...runner, runnerId: id });
      } catch (error) { if (error.status !== 404) return false; }
    }
    return this.storage.transaction(async tx => {
      const current = await tx.get(key);
      if (current?.state !== 'retiring') return false;
      await tx.put(key, { ...current, state: 'retired', retiredAt: this.now() });
      return true;
    });
  }
  async ingest(event) {
    if (!event.runnerName) return;
    await this.storage.transaction(async tx => {
      const key = `local-runner:${event.runnerName}`, runner = await tx.get(key);
      if (!runner || runner.repo !== event.repo || runner.label !== event.label) return;
      if (event.status === 'in_progress' && active(runner)) await tx.put(key, { ...runner, state: 'assigned', assignedJobId: event.id });
      if (event.status === 'completed' && runner.assignedJobId === event.id) await tx.put(key, { ...runner, state: 'retired', completedAt: this.now() });
    });
  }
  async sweep() {
    const runners = await all(this.storage, 'local-runner:');
    for (const runner of runners) {
      if ((['claiming', 'pending'].includes(runner.state) && this.now() - runner.at >= Math.min(this.offerMs(), this.timeoutMs())) ||
          (runner.state === 'started' && this.now() - runner.at >= this.timeoutMs())) await this.release(runner.name);
      else if (runner.state === 'retiring') {
        const removed = await this.remove(runner.name);
        if (!removed && !runner.retiringAlertAt && this.now() - (runner.retiringAt ?? runner.at) >= (this.config.retireAlertSeconds ?? 300) * 1000) {
          await this.storage.transaction(async tx => {
            const key = `local-runner:${runner.name}`, current = await tx.get(key);
            if (current?.state !== 'retiring' || current.retiringAlertAt) return;
            await this.controller.emit?.('alert_local_runner_retiring', { id: runner.jobId }, { runner_name: runner.name }, tx);
            await tx.put(key, { ...current, retiringAlertAt: this.now() });
          });
        }
      }
    }
    for (const label of new Set(runners.map(runner => runner.label))) {
      const { jobs, supply } = await this.storage.transaction(tx => this.counts(tx, label));
      let excess = Math.max(0, supply - jobs.length);
      for (const runner of runners) {
        if (!excess) break;
        if (runner.label !== label || !['pending', 'started'].includes(runner.state)) continue;
        if (await this.release(runner.name)) excess--;
      }
    }
  }
}
import { poolKey, supplyCounts, poolSize } from './pool.mjs';
