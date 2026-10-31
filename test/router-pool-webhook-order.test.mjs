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

test('a busy box whose job finished is released even if the completed webhook was lost', async () => {
  const clock = { now: 10_000_000 };
  const storage = new Storage(), cfg = project('alpha', 'example/alpha'), pool = JSON.stringify([cfg.repo, 'work-large']);
  const id = 'bx_23456789', runnerName = `boat-alpha-${id}-g0`;
  await storage.put('pool:migrated', { done: true });
  await storage.put(`box:${id}`, { machineId: id, pool, size: 'large', state: 'busy', since: clock.now, createdAt: clock.now, generation: 0, runnerName, runnerId: 7, reusable: false, jobs: 0, everOnline: true });
  // The in_progress webhook arrived; the completed webhook was lost (or arrived first and was overwritten).
  await observe(storage, { id: 55, repo: cfg.repo, label: 'work-large', status: 'in_progress', runnerName }, clock.now);
  const calls = [];
  const api = {
    snapshotPage: async (_job, path) => { calls.push(path); return { status: 200, etag: null, rateRemaining: 4000, data: path.startsWith('/actions/runners') ? { total_count: 0, runners: [] } : { total_count: 0, workflow_runs: [] } }; },
    removeRunner: async () => { throw Object.assign(new Error('gone'), { status: 404 }); },
    destroy: async () => ({ operation: { id: 'op' } }), deletion: async () => ({ operation: { status: 'completed' } }), limits: async () => limitsAt(clock.now),
  };
  const fleet = new BoxFleet(storage, api, () => clock.now, { budget: { claim: async () => null }, project: cfg, installation: 1 });
  for (let i = 0; i < 30; i++) {
    clock.now += 60_000;
    await reconcile(storage, api, cfg, 1, () => clock.now);  // run is completed: absent from both run lists; runner self-deleted
    await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: cfg });
  }
  assert.notEqual((await storage.get(`box:${id}`)).state, 'busy', 'box still busy 30 min after its runner vanished; held until TTL');
});

test('webhook reorder (completed delivered before in_progress) leaves the job in_progress', async () => {
  const storage = new Storage();
  await observe(storage, { id: 9, repo: 'r/r', label: 'work-large', status: 'completed', runnerName: 'x' }, 100);
  await observe(storage, { id: 9, repo: 'r/r', label: 'work-large', status: 'in_progress', runnerName: 'x' }, 101);
  assert.equal((await storage.get('gh-job:9')).status, 'completed', 'arrival-time ordering lets a late in_progress overwrite completed');
});
