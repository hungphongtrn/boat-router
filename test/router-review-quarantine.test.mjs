import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';

const REPO = 'a/b', LABEL = 'boat-large', POOL = JSON.stringify([REPO, LABEL]), ID = 'bx_23456789';

test('quarantined box remains during an incomplete snapshot', async () => {
  const calls = [];
  const clock = { now: 10_000_000 }, storage = new Storage();
  const api = { destroy: async () => { calls.push('destroy'); return { operation: { id: 'op' } }; }, removeRunner: async () => { calls.push('removeRunner'); throw Object.assign(new Error(), { status: 422 }); }, sandbox: async () => ({}) };
  const fleet = new BoxFleet(storage, api, () => clock.now, { project: { id: 'demo', repo: REPO, labels: [LABEL] }, budget: {}, installation: 1, logger: () => {}, emit: async () => {} });
  // registration_uncertain after the runner registered: runnerId known, runner actually busy with a job.
  await storage.put(`box:${ID}`, { machineId: ID, pool: POOL, state: 'quarantined', since: clock.now, failureReason: 'registration_uncertain', runnerId: 9, runnerName: 'r9', runnerFenced: false });
  const gap = { complete: false, runners: [], jobs: [] }; // GitHub listing incomplete (rate limit / outage)
  for (let minute = 0; minute <= 75; minute++) { clock.now += 60_000; await fleet.stepBox(ID, gap); }
  const box = await storage.get(`box:${ID}`);
  assert.deepEqual({ state: box.state, calls }, { state: 'quarantined', calls: [] }, `busy runner's box was ${box.state}, calls ${calls}`);
});

test('quarantined orphan remains when one matching runner is busy', async () => {
  const calls = [];
  const clock = { now: 10_000_000 }, storage = new Storage();
  const api = { destroy: async () => { calls.push('destroy'); return { operation: { id: 'op' } }; }, removeRunner: async () => { calls.push('removeRunner'); }, deletion: async () => ({ operation: { id: 'op', status: 'running' } }), sandbox: async () => ({}) };
  const fleet = new BoxFleet(storage, api, () => clock.now, { project: { id: 'demo', repo: REPO, labels: [LABEL] }, budget: {}, installation: 1, logger: () => {}, emit: async () => {} });
  await storage.put(`box:${ID}`, { machineId: ID, pool: null, state: 'quarantined', since: clock.now, drainOnly: true, orphan: true, aliases: [], noRunnerKnown: false, runnerId: null, runnerName: null, reusable: false });
  const view = { complete: true, runners: [{ id: 1, name: `boat-demo-${ID}-g0`, status: 'offline', busy: false }, { id: 2, name: `boat-demo-${ID}-g1`, status: 'online', busy: true }], jobs: [{ id: 5, status: 'in_progress', runnerName: `boat-demo-${ID}-g1` }] };
  for (let minute = 0; minute <= 65; minute++) { clock.now += 60_000; await fleet.stepBox(ID, view); }
  const box = await storage.get(`box:${ID}`);
  assert.deepEqual({ state: box.state, calls }, { state: 'quarantined', calls: [] }, `orphan with a busy runner was ${box.state}, calls ${calls}`);
});
