import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { observe, reconcile } from '../src/router/pool-observations.mjs';
import { supplyCounts } from '../src/router/pool.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { assertObservationOnly, assertPoolInvariants } from './pool-invariants.mjs';

function random(seed) { let x = seed; return () => { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; return x / 4294967296; }; }

test('500 seeded assignments converge without destroying a busy runner', async () => {
  const coverage = { rate: 0, unavailable: 0, timeout: 0, absent: 0, boot: 0, orphan: 0, cancelledRunning: 0, removalFailed: 0, removal404: 0, assignmentDelay: 0, baselineFailure: 0, registrationFailure: 0, resetFailure: 0, reset: 0, reused: 0, destroy404: 0, webhookRace: 0, ledgerRace: 0 };
  for (let seed = 1; seed <= 500; seed++) {
    const rand = random(seed), storage = new Storage(), ledgerStorage = new Storage(), runners = new Map(), boxes = new Set(), born = new Map(), names = new Map(), orphaned = new Map(), visible = new Map(), starts = new Set(), createdClaims = new Set(), fenced = new Set(), unsafeDestroys = [];
    const reusable = [9, 11, 13].includes(seed % 20), fault = seed % 20 === 11 ? 'baseline' : seed % 20 === 13 ? 'registration' : null;
    const count = reusable ? 3 : 1 + Math.floor(rand() * 3), jobs = Array.from({ length: count }, (_, i) => ({ id: i + 1, run_id: 1, status: 'waiting', arrival: reusable ? i * 7 : Math.floor(rand() * 4), labels: ['work'] }));
    const cancelCandidate = !reusable && count > 1 && rand() < 0.3 ? jobs[count - 1] : null;
    const assignmentOrder = ['fifo', 'lifo', 'random'][seed % 3];
    let cancelled = 0, removalFault = seed % 12 === 6 ? 503 : seed % 12 === 7 ? 404 : 0;
    const assignmentDelay = seed % 12 === 8 ? 3 : 0;
    let remainingFault = fault, resetFault = seed % 40 === 29, destroy404 = seed % 20 === 17;
    let time = 1000000, serial = 0, runnerSerial = 0, created = 0, failures = 0, bootFailure = null, failNext = reusable ? null : seed % 10 === 0 ? 'rate' : seed % 10 === 1 ? 'timeout' : seed % 10 === 2 ? 'absent' : seed % 10 === 3 ? 'boot' : seed % 10 === 4 ? 'unavailable' : null, snapshotGap = false;
    const project = { id: 'sample', repo: 'example/project', labels: ['work'], sizes: { work: { machine: 'large' } }, triggers: [{ on: 'workflow_job', executor: 'actions-jit' }], caps: { concurrent: 8 }, ...(reusable ? { reuse: { mode: 'on', idleHoldSeconds: 240 } } : {}) };
    const account = { reuse: { enabled: reusable } };
    const baselineHash = 'a'.repeat(64);
    const ledger = new AccountLedger(ledgerStorage, { starts: { minute: 100, hour: 100, day: 100 }, requireConcurrency: true }, () => time);
    const budget = new SharedBudget(ledger, project.id, () => time);
    const api = {
      limits: async () => ({ canStart: true, observedAt: time, activeSandboxes: boxes.size, maxActiveSandboxes: 8, starts: Object.fromEntries(['minute', 'hour', 'day'].map(key => [key, { limit: 100, used: 0 }])), machineTypes: [{ type: 'large', available: true }] }),
      create: async unit => { assert.equal(unit.jobId, undefined, `seed ${seed} bound a create to a job`); const failure = failNext; failNext = null; if (failure === 'rate' || failure === 'unavailable') { coverage[failure]++; failures++; throw { service: 'boat', status: failure === 'rate' ? 429 : 503 }; } if (failure === 'absent') { coverage.absent++; failures++; throw new Error('timeout'); } const id = `bx_2345678${'23456789abcdefgh'[serial++]}`; boxes.add(id); names.set(id, unit.routerCreateName); born.set(id, time + Math.floor(rand() * 3) * 30000); created++; if (failure === 'boot') { failures++; bootFailure = id; } if (failure === 'timeout') { coverage.timeout++; failures++; visible.set(unit.routerCreateName, { id, at: time + 60000 }); throw new Error('timeout'); } return { sandbox: { id } }; },
      listSandboxes: async () => [...boxes].filter(id => ![...visible.values()].some(record => record.id === id && time < record.at)).map(id => ({ id, name: names.get(id) })),
      findCreated: async unit => { const record = visible.get(unit.routerCreateName); return record && time >= record.at ? { id: record.id } : null; },
      sandbox: async box => { if (box.machineId === bootFailure) { coverage.boot++; bootFailure = null; return { sandbox: { setupStatus: 'failed', state: 'error' } }; } return time < born.get(box.machineId) ? ({ sandbox: { setupStatus: 'pending', state: 'starting' } }) : ({ sandbox: { setupStatus: 'done', state: 'ready' } }); },
      refresh: async (_box, phase) => { if (phase === 'baseline' && remainingFault === 'baseline') { remainingFault = null; coverage.baselineFailure++; failures++; throw new Error('baseline failed'); } if (phase === 'refresh') { coverage.reset++; if (resetFault) { resetFault = false; coverage.resetFailure++; failures++; throw new Error('reset failed'); } } return { processId: 1 }; },
      refreshResult: async () => ({ ok: true, baselineHash }),
      lightReset: async () => { coverage.reset++; if (resetFault) { resetFault = false; coverage.resetFailure++; failures++; throw new Error('reset failed'); } return { processId: 1 }; },
      lightResetResult: async () => ({ ok: true }),
      configure: async (box, save) => { assert.equal(box.jobId, undefined, `seed ${seed} bound a box to a job`); const id = ++runnerSerial + 100; runners.set(id, { id, name: box.runnerName, status: 'offline', busy: false, labels: ['work'] }); await save(id); if (remainingFault === 'registration') { remainingFault = null; coverage.registrationFailure++; failures++; throw new Error('registration response lost'); } if (box.generation > 0) coverage.reused++; },
      start: async box => { runners.get(box.runnerId).status = 'online'; return { success: true }; },
      removeRunner: async box => { const runner = runners.get(box.runnerId); if (runner?.busy) throw Object.assign(new Error('busy'), { status: 422 }); if (removalFault) { const status = removalFault; removalFault = 0; coverage[status === 404 ? 'removal404' : 'removalFailed']++; if (status === 404) { runners.delete(box.runnerId); fenced.add(box.runnerId); } throw Object.assign(new Error('removal response'), { status }); } runners.delete(box.runnerId); fenced.add(box.runnerId); },
      destroy: async box => { if ((box.runnerId && !fenced.has(box.runnerId)) || [...runners.values()].some(r => r.busy && r.name === box.runnerName) || !boxes.has(box.machineId)) unsafeDestroys.push(box.machineId); boxes.delete(box.machineId); if (destroy404) { destroy404 = false; coverage.destroy404++; throw Object.assign(new Error('sandbox absent'), { status: 404 }); } return { operation: { id: box.machineId } }; },
      deletion: async () => ({ operation: { status: 'completed' } }),
      snapshotPage: async (_repo, path) => { if (snapshotGap) throw new Error('snapshot gap'); return { status: 200, data: path.includes('/runners?') ? { total_count: runners.size, runners: [...runners.values()] } : path.includes('/jobs?') ? { total_count: jobs.filter(job => job.status !== 'waiting').length, jobs: jobs.filter(job => job.status !== 'waiting') } : { total_count: 1, workflow_runs: [{ id: 1 }] } }; },
      getJob: async (_job, id) => jobs.find(job => job.id === id),
    };
    const fleet = new BoxFleet(storage, api, () => time, { budget, project, installation: 1 });
    await storage.put('pool:migrated', { done: true });
    for (let tick = 0; tick < 40; tick++) {
      for (const job of jobs.filter(item => item.status === 'waiting' && item.arrival === tick)) {
        job.status = 'queued'; job.queuedAt = time; job.created_at = new Date(time).toISOString();
        if (rand() < 0.5) {
          const event = { id: job.id, repo: project.repo, label: 'work', status: 'queued', queuedAt: time };
          await assertObservationOnly(storage, async () => {
            await observe(storage, event, time);
            if (rand() < 0.5) await observe(storage, event, time);
            await observe(storage, { ...event, status: 'completed' }, time - 1);
          });
        }
      }
      if (cancelCandidate?.status === 'queued' && tick > cancelCandidate.arrival && rand() < 0.5) { cancelCandidate.status = 'completed'; cancelled++; }
      snapshotGap = rand() < 0.05;
      await assertObservationOnly(storage, async () => {
        if (seed % 20 === 19 && tick === 0) { const event = { id: jobs[0].id, repo: project.repo, label: 'work', status: 'queued', queuedAt: time }; await Promise.all([reconcile(storage, api, project, 1, () => time), observe(storage, event, time)]); coverage.webhookRace++; } else await reconcile(storage, api, project, 1, () => time);
      });
      const before = await storage.list({ prefix: 'create:' });
      const pendingBefore = [...before.values()].filter(unit => unit.state === 'pending').length;
      const prepared = await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, account, prepareOnly: true });
      const status = prepared[JSON.stringify([project.repo, 'work'])];
      if (seed % 20 === 19 && tick === 0) { const requests = [...(await storage.list({ prefix: 'create:' })).values()]; if (requests[0]) { await Promise.all([budget.enqueue(requests[0].createKey, requests[0].queuedAt), budget.enqueue(requests[0].createKey, requests[0].queuedAt)]); coverage.ledgerRace++; } }
      const pendingAfter = [...(await storage.list({ prefix: 'create:' })).values()].filter(unit => unit.state === 'pending').length;
      assert.ok(pendingAfter <= Math.max(0, status.Dboat - Math.max(0, status.S - pendingBefore)), `seed ${seed} pending creates exceed uncovered demand`);
      await assertPoolInvariants({ storage, fleet, project, jobs, machines: boxes, runners, ledgerStorage, createdClaims, now: time, limit: 8, seed, prepared: { status, pendingBefore }, awaitingAdoption: id => [...visible.values()].some(item => item.id === id && time < item.at + 600000) || (orphaned.has(id) && time < orphaned.get(id) + 600000), failurePending: Boolean(failNext), snapshotGap }, { maxWaitS: 540 });
      await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, account, preprepared: true });
      if (seed % 10 === 5 && tick === 2) {
        const candidate = [...(await storage.list({ prefix: 'box:' })).values()].find(item => item.state === 'booting');
        if (candidate) { await storage.delete(`box:${candidate.machineId}`); orphaned.set(candidate.machineId, time); coverage.orphan++; failures++; }
      }
      const ledgerState = await ledgerStorage.get('account:ledger');
      for (const [key, claim] of Object.entries(ledgerState?.claims ?? {})) if (claim.status === 'created') createdClaims.add(key);
      for (const key of createdClaims) assert.equal(ledgerState?.claims?.[key]?.status, 'created', `seed ${seed} refunded a created claim`);
      for (const id of boxes) {
        const exists = await storage.get(`box:${id}`);
        const awaitingVisibility = [...visible.values()].some(item => item.id === id && time < item.at + 600000) || (orphaned.has(id) && time < orphaned.get(id) + 600000);
        assert.ok(exists || awaitingVisibility, `seed ${seed} sandbox lacks a box record after orphan deadline`);
      }
      for (const unit of [{ state: 'booting', since: time - 300000 }, { state: 'registering', since: time - 120000 },
        { state: 'resetting', since: time - 120000 }, { kind: 'create', state: 'unknown', callingAt: time - 120000 }]) {
        assert.equal(Object.values(supplyCounts([unit], time)).reduce((sum, n) => sum + n, 0), 0, `seed ${seed} counted expired supply`);
      }
      for (const runner of runners.values()) {
        if (runner.busy) {
          const job = jobs.find(item => item.runner_name === runner.name && item.status === 'in_progress');
          if (job && rand() < 0.8) { job.status = 'completed'; job.conclusion = rand() < 0.25 ? 'cancelled' : 'success'; if (job.conclusion === 'cancelled') coverage.cancelledRunning++; if (removalFault) { runner.busy = false; } else { runners.delete(runner.id); fenced.add(runner.id); } }
        } else if (runner.status === 'online') {
          const queued = jobs.filter(job => job.status === 'queued');
          if (queued.length && assignmentDelay && tick < queued[0].arrival + assignmentDelay) coverage.assignmentDelay++;
          if (queued.length && (!assignmentDelay || tick >= queued[0].arrival + assignmentDelay)) {
            const job = assignmentOrder === 'fifo' ? queued[0] : assignmentOrder === 'lifo' ? queued.at(-1) : queued[Math.floor(rand() * queued.length)];
            job.status = 'in_progress'; job.runner_name = runner.name; runner.busy = true;
            assert.ok(time - job.queuedAt <= 540000, `seed ${seed} start bound exceeded`);
            assert.ok(!starts.has(job.id), `seed ${seed} duplicate start`); starts.add(job.id);
          }
        }
      }
      await assertPoolInvariants({ storage, fleet, project, jobs, machines: boxes, runners, ledgerStorage, createdClaims, unsafeDestroys, now: time, limit: 8, seed, awaitingAdoption: id => [...visible.values()].some(item => item.id === id && time < item.at + 600000) || (orphaned.has(id) && time < orphaned.get(id) + 600000), failurePending: Boolean(failNext), snapshotGap }, { maxWaitS: 540 });
      time += 30000;
    }
    assert.equal(starts.size, count - cancelled, `seed ${seed} left queued jobs`);
    assert.ok(created <= count + failures, `seed ${seed} over-created`);
    assert.equal(boxes.size, 0, `seed ${seed} leaked boxes`);
  }
  for (const [name, count] of Object.entries(coverage)) assert.ok(count > 0, `${name} was not exercised`);
});
