import assert from 'node:assert/strict';

export async function assertObservationOnly(storage, action) {
  const before = await storage.list({ prefix: 'box:' });
  const result = await action();
  assert.deepEqual(await storage.list({ prefix: 'box:' }), before, 'observation changed box state');
  return result;
}

function expectedSupply({ boxes, creates, locals, runners, project, now, key }) {
  const byName = new Map(runners.map(runner => [runner.name, runner]));
  const counts = {};
  const add = state => { counts[state] = (counts[state] ?? 0) + 1; };
  const recent = (at, seconds) => Number.isFinite(at) && now - at < seconds * 1000;
  for (const box of boxes) {
    if (box.pool !== key || box.drainOnly) continue;
    const runner = byName.get(box.runnerName);
    if ((box.state === 'booting' || box.state === 'baseline') && recent(box.since, 300)) add(box.state);
    else if (box.state === 'ready') add(box.state);
    else if ((box.state === 'registering' || box.state === 'resetting') && recent(box.since, 120)) add(box.state);
    else if (box.state === 'idle' && !runner?.busy && (runner?.status === 'online' || (!box.everOnline && recent(box.startedAt ?? box.since, 120)))) add(box.state);
  }
  for (const item of creates) if (item.pool === key && (item.state === 'pending' || (['calling', 'unknown'].includes(item.state) && recent(item.callingAt ?? item.at, 120)))) add(`create:${item.state}`);
  for (const local of locals) {
    if (JSON.stringify([project.repo, local.label]) !== key) continue;
    const runner = byName.get(local.name);
    const offer = project.externalClaimer?.offerSeconds ?? project.localFirst?.offerSeconds ?? 30;
    if (['claiming', 'pending'].includes(local.state) && recent(local.at, offer)) add(`local:${local.state}`);
    else if (local.state === 'started' && !runner?.busy && (runner?.status === 'online' || (!local.everOnline && recent(local.startedAt, 120)))) add('local:started');
  }
  const known = new Set([...boxes.map(box => box.runnerName), ...locals.map(local => local.name)]);
  const label = JSON.parse(key)[1];
  for (const runner of runners) if (!known.has(runner.name) && runner.status === 'online' && !runner.busy && (runner.labels ?? []).some(item => (typeof item === 'string' ? item : item.name) === label)) add('foreign');
  return counts;
}

// The caller supplies the real simulator state at a tick boundary.
export async function assertPoolInvariants(sim, { maxWaitS }) {
  const { storage, fleet, project, jobs, machines, runners, now, limit, seed } = sim;
  if (sim.unsafeDestroys) assert.deepEqual(sim.unsafeDestroys, [], `seed ${seed}: destroy without an observed fence or ownership, or while busy`);
  const boxes = [...(await storage.list({ prefix: 'box:' })).values()];
  const creates = [...(await storage.list({ prefix: 'create:' })).values()];
  for (const unit of [...boxes, ...creates]) assert.equal(unit.jobId, undefined, `seed ${seed}: supply unit is bound to a job`);
  if (sim.ledgerStorage && sim.createdClaims) {
    const claims = (await sim.ledgerStorage.get('account:ledger'))?.claims ?? {};
    for (const key of sim.createdClaims) assert.equal(claims[key]?.status, 'created', `seed ${seed}: created claim was refunded`);
    for (const [key, claim] of Object.entries(claims)) if (claim.status === 'created') sim.createdClaims.add(key);
  }
  assert.ok(machines.size <= limit, `seed ${seed}: account limit exceeded`);
  const ownership = new Map(), machineClaims = new Set();
  const createKeys = creates.map(item => item.createKey);
  assert.equal(new Set(createKeys).size, createKeys.length, `seed ${seed}: duplicate create key`);
  for (const box of boxes) {
    if (!machines.has(box.machineId) || box.state === 'deleted') continue;
    if (box.drainOnly && box.pool == null) continue;
    assert.ok(typeof box.pool === 'string' && Array.isArray(JSON.parse(box.pool)), `seed ${seed}: machine lacks a pool`);
    assert.ok(!ownership.has(box.machineId), `seed ${seed}: machine has multiple owners`);
    ownership.set(box.machineId, box.pool);
    if (box.createKey) {
      assert.ok(!machineClaims.has(box.createKey), `seed ${seed}: one create claim owns multiple machines`);
      machineClaims.add(box.createKey);
    }
  }
  for (const id of machines) {
    if (sim.awaitingAdoption?.(id)) continue;
    assert.ok(ownership.has(id) || boxes.some(box => box.machineId === id && box.drainOnly && box.pool == null), `seed ${seed}: started machine lacks an owner`);
  }
  const names = new Map([...runners.values()].map(runner => [runner.name, runner]));
  const claimed = new Set();
  for (const job of jobs.filter(item => item.status === 'in_progress')) {
    assert.ok(!claimed.has(job.runner_name), `seed ${seed}: two jobs share a runner`);
    claimed.add(job.runner_name);
  }
  const snapshot = await storage.get('pool:snapshot');
  if (snapshot?.complete) {
    const locals = [...(await storage.list({ prefix: 'local-runner:' })).values()];
    const observations = [...(await storage.list({ prefix: 'gh-job:' })).values()];
    const actual = await fleet.tick({ mode: 'shadow', project });
    for (const [key, decision] of Object.entries(actual)) {
      const expected = expectedSupply({ boxes, creates, locals, runners: snapshot.runners ?? [], project, now, key });
      assert.deepEqual(decision.supply, expected, `seed ${seed}: incorrect supply or expired deadline in ${key}`);
      assert.equal(decision.S, Object.values(expected).reduce((sum, n) => sum + n, 0), `seed ${seed}: incorrect supply total`);
      if (sim.prepared) {
        const label = JSON.parse(key)[1], claimer = project.externalClaimer ?? project.localFirst;
        const offer = claimer?.enabled && claimer.labels?.[label] ? (claimer.offerSeconds ?? 30) * 1000 : 0;
        const demand = observations.filter(item => item.pool === key && item.status === 'queued' && !item.missing && item.queuedAt + offer <= now).length;
        const pending = creates.filter(item => item.pool === key && item.state === 'pending').length;
        const otherSupply = Object.values(expected).reduce((sum, n) => sum + n, 0) - pending;
        assert.ok(pending <= Math.max(0, demand - otherSupply), `seed ${seed}: multiple pending creates cover one demand unit`);
      }
    }
    for (const job of jobs.filter(item => item.status === 'queued' && item.queuedAt != null)) {
      if (machines.size < limit && !sim.failurePending && !sim.snapshotGap) assert.ok(now - job.queuedAt <= maxWaitS * 1000, `seed ${seed}: queued wait bound exceeded`);
    }
  }
  for (const [name, runner] of names) if (runner.busy && !sim.allowUnobservedBusy) assert.ok(claimed.has(name), `seed ${seed}: busy runner has no job`);
}
