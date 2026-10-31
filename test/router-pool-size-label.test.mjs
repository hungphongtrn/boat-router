import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { observe, reconcile } from '../src/router/pool-observations.mjs';

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
let serial = 0;
const sandboxId = () => { let n = serial++, s = ''; for (let i = 0; i < 8; i++) { s += ALPHABET[n % ALPHABET.length]; n = Math.floor(n / ALPHABET.length); } return `bx_${s}`; };

function limitsAt(now, active = 0) {
  return { canStart: true, observedAt: now, activeSandboxes: active, maxActiveSandboxes: 50,
    startLimits: { perMinute: 100, perHour: 1000, perDay: 10000 },
    starts: { minute: { limit: 100, used: 0, remaining: 100 }, hour: { limit: 1000, used: 0, remaining: 1000 }, day: { limit: 10000, used: 0, remaining: 10000 } },
    machineTypes: [{ type: 'large', available: true }, { type: 'default', available: true }] };
}

function project(id, repo, label = 'work-large', size = 'large') {
  return { id, repo, account: 'account', labels: [label], sizes: { [label]: { machine: size } }, caps: {}, reuse: { mode: 'off' } };
}

function fakeApi(clock, created) {
  return {
    limits: async () => limitsAt(clock.now),
    create: async unit => { const id = sandboxId(); created.push({ id, pool: unit.pool }); return { sandbox: { id } }; },
    sandbox: async () => ({ sandbox: { state: 'running', setupStatus: 'pending' } }),
  };
}

async function setupProject(cfg, ledger, clock, created, jobs) {
  const storage = new Storage();
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [] });
  const pool = JSON.stringify([cfg.repo, cfg.labels[0]]);
  for (const { id, queuedAt } of jobs) await storage.put(`gh-job:${id}`, { id, pool, status: 'queued', queuedAt, observedAt: queuedAt, source: 'webhook' });
  const budget = new SharedBudget(ledger, cfg.id, () => clock.now);
  const fleet = new BoxFleet(storage, fakeApi(clock, created), () => clock.now, { budget, project: cfg, installation: 1 });
  return { storage, fleet, cfg };
}

// Mirrors Router.runTick in pool mode: prepare all projects, then tick all.
async function routerTick(projects) {
  const opts = p => ({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: p.cfg });
  for (const p of projects) await p.fleet.tick({ ...opts(p), prepareOnly: true });
  for (const p of projects) await p.fleet.tick({ ...opts(p), preprepared: true });
}

test('a boat-size-* job (accepted by select.mjs) must not throw the whole project tick', async () => {
  const clock = { now: 10_000_000 };
  const storage = new Storage(), cfg = project('alpha', 'example/alpha');
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [] });
  await observe(storage, { id: 3, repo: cfg.repo, label: 'boat-size-large', status: 'queued' }, clock.now);
  const fleet = new BoxFleet(storage, {}, () => clock.now, { budget: {}, project: cfg, installation: 1 });
  await assert.doesNotReject(fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: cfg, prepareOnly: true }));
});


test('an invalid job label does not hide valid jobs from the snapshot', async () => {
  const clock = { now: 10_000_000 }, storage = new Storage(), cfg = { ...project('sample', 'example/project'), triggers: [{ on: 'workflow_job', executor: 'actions-jit' }] };
  const jobs = [{ id: 1, run_id: 1, status: 'queued', labels: ['boat-size-large', 'extra'] }, { id: 2, run_id: 1, status: 'queued', labels: ['work-large'] }];
  const api = { snapshotPage: async (_repo, path) => ({ status: 200, data: path.includes('/runners?') ? { total_count: 0, runners: [] } : path.includes('/jobs?') ? { total_count: jobs.length, jobs } : { total_count: 1, workflow_runs: [{ id: 1 }] } }) };
  assert.equal(await reconcile(storage, api, cfg, 1, () => clock.now), true);
  assert.equal((await storage.get('gh-job:2')).status, 'queued');
  assert.equal(await storage.get('gh-job:1'), undefined);
});

test('a configured size label is selected and admitted with the requested machine size', async () => {
  const { selectWorkflowJob } = await import('../src/router/select.mjs');
  const clock = { now: 10_000_000 }, storage = new Storage(), created = [];
  const cfg = { ...project('sample', 'example/project'), sizeLabelPrefix: 'boat-size-', triggers: [{ on: 'workflow_job', executor: 'actions-jit' }] };
  const ledger = new AccountLedger(new Storage(), { requireConcurrency: true }, () => clock.now);
  const budget = new SharedBudget(ledger, cfg.id, () => clock.now);
  const event = selectWorkflowJob('workflow_job', { action: 'queued', repository: { full_name: cfg.repo }, installation: { id: 1 }, workflow_job: { id: 17, labels: ['boat-size-large'], status: 'queued' } }, cfg);
  assert.equal(event.size, 'large');
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [] });
  await observe(storage, event, clock.now);
  const api = { limits: async () => limitsAt(clock.now), create: async unit => { created.push(unit); return { sandbox: { id: 'bx_23456789' } }; } };
  const fleet = new BoxFleet(storage, api, () => clock.now, { budget, project: cfg, installation: 1 });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: cfg });
  assert.equal(created.length, 1);
  assert.equal(created[0].machineSize, 'large');
  assert.equal((await storage.get('box:bx_23456789')).pool, JSON.stringify([cfg.repo, 'boat-size-large']));
});
