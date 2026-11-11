import test from 'node:test';
import assert from 'node:assert/strict';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { poolKey } from '../src/router/pool.mjs';
import { observe } from '../src/router/pool-observations.mjs';
import { Storage } from './helpers.mjs';

test('pending pool create uses enabled reuse and serves the next job on the same box', async () => {
  const storage = new Storage(), id = 'bx_23456789', repo = 'example/repo', label = 'work', pool = poolKey(repo, label);
  const project = { id: 'sample', repo, labels: [label], sizes: { work: { machine: 'large' } }, caps: { concurrent: 1 }, reuse: { mode: 'on' } };
  const account = { reuse: { enabled: true } }, hash = 'a'.repeat(64);
  let now = 1000, claim, creates = 0, resets = 0, runner;
  const budget = { claimKey: async () => 'a'.repeat(64), enqueue: async () => {}, claim: async () => claim,
    admit: async () => { claim = { status: 'pending' }; return { ok: true }; },
    begin: async () => { claim.status = 'calling'; return true; },
    settle: async (_key, status) => { claim.status = status; return true; } };
  const api = {
    limits: async () => ({ canStart: true, machineTypes: [{ type: 'large', available: true }] }),
    create: async () => { creates++; return { sandbox: { id } }; },
    sandbox: async () => ({ sandbox: { setupStatus: 'done', state: 'ready' } }),
    refresh: async () => ({ processId: 1 }), refreshResult: async () => ({ ok: true, baselineHash: hash }),
    configure: async (box, save) => { runner = { id: box.generation + 1, name: box.runnerName, status: 'online', busy: false }; await save(runner.id); },
    start: async () => ({ success: true }), removeRunner: async () => { runner = null; },
    lightReset: async () => { resets++; return { processId: 2 }; }, lightResetResult: async () => ({ ok: true }),
  };
  const fleet = new BoxFleet(storage, api, () => now, { project, budget, installation: 1 });
  const tick = async () => { await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account, project }); now += 1000; };
  const snapshot = async () => storage.put('pool:snapshot', { complete: true, at: now, runners: runner ? [runner] : [] });
  const event = (id, status, runnerName = null) => ({ id, repo, label, status, runnerName });
  await storage.put('pool:migrated', { done: true }); await snapshot();
  await observe(storage, event(1, 'queued'), now);
  await storage.put('reuse:override', 'off');
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account, project, prepareOnly: true });
  await storage.put('reuse:override', 'config');
  for (let i = 0; i < 5 && !runner; i++) await tick();
  assert.equal(runner?.name, `boat-sample-${id}-g0`);
  runner.busy = true; await snapshot(); await observe(storage, event(1, 'in_progress', runner.name), now); await tick();
  await observe(storage, event(2, 'queued'), now);
  const firstName = runner.name; runner.busy = false; await snapshot();
  await observe(storage, event(1, 'completed', firstName), now); await tick();
  await snapshot();
  for (let i = 0; i < 5 && !runner; i++) { await tick(); await snapshot(); }
  assert.equal(resets, 1);
  assert.equal(runner?.name, `boat-sample-${id}-g1`);
  runner.busy = true; await snapshot(); await observe(storage, event(2, 'in_progress', runner.name), now); await tick();
  assert.equal((await storage.get(`box:${id}`)).state, 'busy');
  assert.equal(creates, 1);
});
