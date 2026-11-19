import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet, DOCKER_REUSE_KEY } from '../src/router/box-fleet.mjs';
import { transition } from '../src/router/box-state.mjs';

const REPO = 'a/b', LABEL = 'boat-large', POOL = JSON.stringify([REPO, LABEL]), ID = 'bx_23456789';
const project = extra => ({ id: 'demo', repo: REPO, labels: [LABEL], sizes: { [LABEL]: { machine: 'large' } }, reuse: { mode: 'on' }, caps: {}, ...extra });
const docker = project({ dockerAccess: true, reuse: { mode: 'on', docker: true } });
const acct = { reuse: { enabled: true }, waitForBusyBox: { enabled: false } };

async function harness(now) {
  const clock = { now }, storage = new Storage();
  const fleet = new BoxFleet(storage, {}, () => clock.now, { project: docker, budget: {}, installation: 1, logger: () => {}, emit: async () => {} });
  await storage.put(DOCKER_REUSE_KEY, { [LABEL]: 'on' });
  await storage.put('pool:migrated', { done: true });
  return { clock, storage, fleet };
}
async function lagTick(h, runnerName, jobs, mode) {
  await h.storage.put('pool:snapshot', { at: h.clock.now, complete: true, runners: [] });
  for (const job of jobs) await h.storage.put(`gh-job:${job.id}`, { pool: POOL, source: 'snapshot', observedAt: h.clock.now, ...job });
  const plan = await h.fleet.tick({ mode: 'shadow', project: docker, account: acct });
  if (mode === 'on') await h.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: docker, account: acct, preprepared: true, skipAdmission: true });
  return plan[POOL].S;
}

test('a reused box gets a fresh runner absence grace period', async () => {
  const T0 = 1_000_000;
  const h = await harness(T0);
  const g0 = `boat-demo-${ID}-g0`, g1 = `boat-demo-${ID}-g1`;
  await h.storage.put(`box:${ID}`, { machineId: ID, pool: POOL, originPool: POOL, size: 'large', state: 'busy', since: T0 - 60_000, createdAt: 0, runnerName: g0, runnerId: 3, reusable: true, resetMode: 'docker', baselineHash: 'abc', generation: 0, jobs: 0, everOnline: true, machineTtlSeconds: 7200 });
  // Generation 0: the runner leaves, the job list lags (normal). Supply 1, stamp T0.
  const s0 = await lagTick(h, g0, [{ id: 1, status: 'in_progress', runnerName: g0, queuedAt: 0, startedAt: 1 }, { id: 2, status: 'queued', queuedAt: 1 }], 'on');
  assert.equal(s0, 1);
  let box = await h.storage.get(`box:${ID}`);
  assert.equal(box.runnerAbsentSince, T0);
  // The job ends and the box is reused: the same events and changes box-fleet passes.
  const steps = [
    ['runner_gone', { runnerFenced: true, jobs: 1 }],
    ['reset_start', { generation: 1, processId: null, localHoldRelease: false, awaitingResultSince: null }],
    ['reset_submitted', { processId: 7 }],
    ['reset_done', { runnerId: null, runnerName: null, runnerIdentity: null, runnerFenced: false }],
    ['register', { runnerName: g1, runnerIdentity: g1, runnerId: null }],
    ['runner_registered', { runnerId: 4 }],
    ['start', { startedAt: T0 + 60_000, online: false, everOnline: false, onlineAt: null, offlineSince: null }],
    ['job_started', { online: true, everOnline: true }],
  ];
  for (const [event, changes] of steps) box = transition(box, event, changes, T0 + 60_000);
  assert.equal(box.state, 'busy'); assert.equal(box.runnerName, g1);
  assert.equal(box.runnerAbsentSince, null, 'the previous generation stamp is cleared');
  await h.storage.put(`box:${ID}`, box);
  await h.storage.delete('gh-job:1'); await h.storage.delete('gh-job:2');
  // Generation 1, a short job: its runner leaves, the job list lags exactly as for generation 0.
  h.clock.now = T0 + 300_000;
  const jobs1 = [{ id: 3, status: 'in_progress', runnerName: g1, queuedAt: 0, startedAt: 1 }, { id: 4, status: 'queued', queuedAt: 1 }];
  const s1 = await lagTick(h, g1, jobs1, 'shadow');
  // Control: the same record without the leaked stamp.
  await h.storage.put(`box:${ID}`, { ...box, runnerAbsentSince: undefined });
  const control = await lagTick(h, g1, jobs1, 'shadow');
  assert.equal(control, 1, 'control: a fresh absence is supply');
  assert.equal(s1, 1, `first lag tick of generation 1 must be supply like generation 0 (got ${s1})`);
});
