import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';

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

test('a breaker trip in one project must not stop admissions in another project', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { id: 'account', margin: 0.05, requireConcurrency: true }, () => clock.now);
  const a = await setupProject(project('beta', 'example/beta'), ledger, clock, created, [{ id: 1, queuedAt: 1_000_000 }]);
  const b = await setupProject(project('gamma', 'example/gamma', 'work-default', 'default'), ledger, clock, created, [{ id: 2, queuedAt: 2_000_000 }]);
  // Round 1: both projects prepare. Before admission, beta's per-size breaker trips
  // (three failed boxes; any reason in gates(): breaker, size_block, backoff, snapshot_incomplete).
  for (const p of [a, b]) await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: p.cfg, prepareOnly: true });
  await a.storage.put('verification:breaker', { counts: { large: 3 }, tripped: true });
  for (let i = 0; i < 10 && !created.some(c => c.pool.includes('gamma')); i++) { clock.now += 60_000; await routerTick([a, b]); }
  const waiting = (await ledger.storage.get('account:ledger')).waiting.map(w => w.project);
  assert.equal(created.filter(c => c.pool.includes('gamma')).length, 1, 'gamma never got a box: head-of-line blocked by beta waiter');
});

test('one incomplete GitHub snapshot in one project must not stop the other project', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { id: 'account', margin: 0.05, requireConcurrency: true }, () => clock.now);
  const a = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, [{ id: 1, queuedAt: 1_000_000 }]);
  const b = await setupProject(project('beta', 'example/beta'), ledger, clock, created, [{ id: 2, queuedAt: 2_000_000 }]);
  for (const p of [a, b]) await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: p.cfg, prepareOnly: true });
  await a.storage.put('pool:snapshot', { at: clock.now, complete: false });   // e.g. one 5xx page, or > 37 runs
  for (let i = 0; i < 5 && !created.some(c => c.pool.includes('beta')); i++) { clock.now += 60_000; await routerTick([a, b]); }
  assert.equal(created.filter(c => c.pool.includes('beta')).length, 1, 'beta blocked while alpha snapshot is incomplete');
});


test('a breaker tripped after preparation withdraws its waiter before global admission', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { requireConcurrency: true }, () => clock.now);
  const a = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, [{ id: 1, queuedAt: 1 }]);
  const b = await setupProject(project('beta', 'example/beta'), ledger, clock, created, [{ id: 2, queuedAt: 2 }]);
  for (const p of [a, b]) await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, prepareOnly: true });
  await a.storage.put('verification:breaker', { tripped: true });
  for (const p of [a, b]) for (const entry of await p.fleet.admissionEntries()) await p.fleet.admitQueued(entry.key, { mode: 'on', env: { ENABLED: 'true' }, project: p.cfg });
  assert.deepEqual(created.map(item => JSON.parse(item.pool)[0]), ['example/beta']);
});
