import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { Router } from '../src/router/core.mjs';

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

test('ten uncovered jobs with ample limits are all admitted in one router tick', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { id: 'account', margin: 0.05, requireConcurrency: true }, () => clock.now);
  const jobs = Array.from({ length: 10 }, (_, i) => ({ id: 1000 + i, queuedAt: 1_000_000 + i * 1000 }));
  const p = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, jobs);
  await routerTick([p]);
  const perTick = [created.length];
  for (let i = 0; i < 10 && created.length < 10; i++) { clock.now += 60_000; await routerTick([p]); perTick.push(created.length); }
  assert.equal(perTick[0], 10, `only ${perTick[0]} of 10 admitted in the first tick; ${perTick.length} ticks to reach ${created.length}`);
});



test('router admits interleaved projects in account FIFO order in one tick', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const a = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, queuedAt: i * 2 + 1 })));
  const b = await setupProject(project('beta', 'example/beta'), ledger, clock, created, Array.from({ length: 5 }, (_, i) => ({ id: 20 + i, queuedAt: i * 2 })));
  const suites = [a, b].map(p => ({ config: p.cfg, storage: p.storage,
    prepare: () => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, prepareOnly: true }),
    admissionEntries: () => p.fleet.admissionEntries(),
    admitStart: (key, ctx) => p.fleet.admitQueued(key, { mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preparationFailed: ctx.startPreparationFailed }),
    tick: ctx => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preprepared: true, skipAdmission: ctx.globalAdmission }) }));
  const router = { projects: new Map(suites.map(p => [p.config.id, p])), ledger, now: () => clock.now };
  const result = await Router.prototype.runTick.call(router);
  assert.ok(result.every(item => item.ok));
  assert.equal(created.length, 10);
  assert.deepEqual(created.map(item => JSON.parse(item.pool)[0]), Array.from({ length: 10 }, (_, i) => i % 2 ? 'example/alpha' : 'example/beta'));
});

test('ten ready sandboxes register and start in the second router tick', async () => {
  const clock = { now: 10_000_000 }, created = [], started = [];
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(project('sample', 'example/project'), ledger, clock, created,
    Array.from({ length: 10 }, (_, i) => ({ id: i + 1, queuedAt: clock.now + i })));
  p.fleet.api.sandbox = async () => ({ sandbox: { state: 'ready', setupStatus: 'done' } });
  p.fleet.api.configure = async (box, save) => { await save(created.findIndex(item => item.id === box.machineId) + 1); };
  p.fleet.api.start = async box => { started.push(box.machineId); return { success: true }; };
  await routerTick([p]);
  clock.now += 60_000;
  await routerTick([p]);
  assert.equal(created.length, 10);
  assert.equal(new Set(started).size, 10);
});

test('pool readback reports the daily admission limit and recovers when capacity returns', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, [{ id: 1, queuedAt: 1 }, { id: 2, queuedAt: 2 }]);
  let full = true;
  p.fleet.api.limits = async () => {
    const limits = limitsAt(clock.now);
    if (full) limits.starts.day = { limit: 10000, used: 10000, remaining: 0 };
    return limits;
  };
  const suite = { config: p.cfg, storage: p.storage,
    prepare: () => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, prepareOnly: true }),
    admissionEntries: () => p.fleet.admissionEntries(),
    admitStart: (key, ctx) => p.fleet.admitQueued(key, { mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preparationFailed: ctx.startPreparationFailed }),
    tick: ctx => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preprepared: true, skipAdmission: ctx.globalAdmission }) };
  const router = { projects: new Map([['alpha', suite]]), ledger, now: () => clock.now };
  await Router.prototype.runTick.call(router);
  assert.equal((await p.storage.get('pool:status:work-large')).reason, 'ledger:day_cap');
  assert.equal(created.length, 0);
  assert.equal((await ledger.storage.get('account:ledger')).waiting.length, 2);
  full = false;
  clock.now += 60_000;
  await Router.prototype.runTick.call(router);
  assert.equal(created.length, 2);
  assert.equal((await p.storage.get('pool:status:work-large')).reason, null);
});
