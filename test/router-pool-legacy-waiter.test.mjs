import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { migrateProject } from '../src/router/pool-migrate.mjs';

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

test('a legacy ledger waiter left at cutover must not block all pool admissions', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { id: 'account', margin: 0.05, requireConcurrency: true }, () => clock.now);
  // Legacy alpha job 7: queued, enqueued by the last legacy prepareQueue, not yet admitted
  // (account at concurrency, fairness, or simply the same tick). Its waiter is keyed by the legacy createKey.
  const legacyCfg = project('alpha', 'example/alpha');
  const k = await setupProject(legacyCfg, ledger, clock, created, []);
  await k.storage.delete('pool:migrated');
  await k.storage.put('job:7', { id: 7, repo: legacyCfg.repo, installation: 1, label: 'work-large', size: 'large', phase: 'queued', createKey: 'legacy-create-key-7', createdAt: 5_000_000, updatedAt: 5_000_000 });
  await new SharedBudget(ledger, 'alpha', () => clock.now).enqueue('legacy-create-key-7', 5_000_000, 7);
  await migrateProject(k.storage, legacyCfg, 'commit', () => clock.now, new SharedBudget(ledger, legacyCfg.id, () => clock.now));
  // A newer job in another project after cutover.
  const t = await setupProject(project('gamma', 'example/gamma', 'work-default', 'default'), ledger, clock, created, [{ id: 8, queuedAt: 9_000_000 }]);
  for (let i = 0; i < 10 && !created.some(c => c.pool.includes('gamma')); i++) { clock.now += 60_000; await routerTick([k, t]); }
  const waiting = (await ledger.storage.get('account:ledger')).waiting;
  assert.equal(created.filter(c => c.pool.includes('gamma')).length, 1, 'gamma never admitted: stale legacy waiter holds the account queue head');
});

test('migration withdraws prepared waiters without refunding an in-flight create', async () => {
  const clock = { now: 10_000_000 }, ledger = new AccountLedger(new Storage(), { requireConcurrency: true }, () => clock.now);
  const cfg = project('sample', 'example/project'), budget = new SharedBudget(ledger, cfg.id, () => clock.now), storage = new Storage();
  await budget.enqueue('in-flight', clock.now - 2);
  assert.equal((await budget.admit('in-flight', limitsAt(clock.now), { queuedAt: clock.now - 2 })).ok, true);
  assert.equal(await budget.begin('in-flight'), true);
  await budget.enqueue('waiting', clock.now - 1);
  await storage.put('router:prepared-starts', ['in-flight', 'waiting']);
  await migrateProject(storage, cfg, 'commit', () => clock.now, budget);
  assert.equal((await budget.claim('in-flight')).status, 'calling');
  assert.equal(await budget.claim('waiting'), null);
  assert.equal((await ledger.storage.get('account:ledger')).waiting.length, 0);
  assert.equal(await storage.get('router:prepared-starts'), undefined);
});
