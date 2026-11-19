import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';

const pool = JSON.stringify(['a/b', 'boat-large']);
const project = { id: 'demo', repo: 'a/b', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, reuse: { mode: 'on' } };
const account = { reuse: { enabled: true }, waitForBusyBox: { enabled: true, maxWaitMs: 180000, minimumAllowanceMs: 180000, scarcityFrom: .5, scarcityFull: .95 } };
async function setup(storage, runners = []) {
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { complete: true, at: 1000000, runners });
  await storage.put('verification:breaker', { tripped: true, trippedAt: 999000, counts: { large: 3 } });
}

test('boot breaker blocks new boxes but a completed reusable box resets', async () => {
  const storage = new Storage(); await setup(storage);
  await storage.put('box:box', { machineId:'box', pool, originPool:pool, size:'large', state:'finished', since:999000, createdAt:0, runnerName:'runner', runnerFenced:true, reusable:true, baselineHash:'abc', generation:0, jobs:1 });
  await storage.put('gh-job:1', { id:1, pool, status:'completed', runnerName:'runner', conclusion:'success', durationRecorded:true, startedAt:1000, completedAt:2000, queuedAt:0 });
  await storage.put('gh-job:2', { id:2, pool, status:'queued', queuedAt:500 });
  let resets=0, starts=0;
  const fleet = new BoxFleet(storage, { lightReset: async () => { resets++; return { processId:1 }; }, create: async () => { starts++; } }, () => 1000000, { project, budget:{} });
  const result = await fleet.tick({ mode:'on', env:{ENABLED:'true'}, account, project });
  assert.equal(result[pool].reason,'breaker');
  assert.equal(resets,1); assert.equal(starts,0);
  assert.equal((await storage.get('box:box')).state,'resetting');
  assert.equal((await storage.get('verification:breaker')).tripped,true);
});

test('boot breaker does not claim a still-busy runner as supply', async () => {
  const storage = new Storage(); await setup(storage, [{name:'runner',status:'online',busy:true,labels:['boat-large']}]);
  await storage.put('box:box', {machineId:'box',pool,originPool:pool,size:'large',state:'busy',since:500000,createdAt:0,runnerName:'runner',reusable:true,baselineHash:'abc',generation:0,jobs:0});
  await storage.put('gh-job:1', {id:1,pool,status:'in_progress',runnerName:'runner',jobName:'Tests',startedAt:500000,queuedAt:0});
  await storage.put('gh-job:2', {id:2,pool,status:'queued',queuedAt:1});
  const limits = {starts:{day:{used:95,limit:100},hour:{used:95,limit:100}}};
  let starts=0;
  const fleet = new BoxFleet(storage, {limits:async()=>limits,create:async()=>{starts++;}}, () => 1000000, {project,budget:{}});
  const result = await fleet.tick({mode:'on',env:{ENABLED:'true'},account,project});
  assert.equal(result[pool].reason,'breaker'); assert.equal(starts,0);
  const claim = await storage.get('wait:claim:2');
  assert.equal(claim, undefined);
  assert.equal((await storage.get('box:box')).state,'busy');
});

test('a tripped large breaker leaves default demand eligible', async () => {
  const storage = new Storage(), smallPool = JSON.stringify(['a/b', 'boat-default']);
  await setup(storage);
  await storage.put('gh-job:1', { id: 1, pool, status: 'queued', queuedAt: 1 });
  await storage.put('gh-job:2', { id: 2, pool: smallPool, status: 'queued', queuedAt: 2 });
  const cfg = { ...project, labels: ['boat-large', 'boat-default'], sizes: { ...project.sizes, 'boat-default': { machine: 'default' } } };
  const fleet = new BoxFleet(storage, {}, () => 1_000_000, { project: cfg });
  const result = await fleet.tick({ mode: 'shadow', env: { ENABLED: 'true' }, project: cfg });
  assert.equal(result[pool].reason, 'breaker');
  assert.equal(result[smallPool].reason, null); assert.equal(result[smallPool].create, 1);
});

test('a stale probe with no account reservation is released safely', async () => {
  const storage = new Storage(); await setup(storage);
  await storage.put('verification:breaker', { tripped: true, counts: { large: 3 }, bySize: { large: { tripped: true, trippedAt: 1, counts: { large: 3 }, probe: { createKey: 'probe', at: 1 } } } });
  await storage.put('create:probe', { createKey: 'probe', pool, size: 'large', state: 'pending', at: 1, queuedAt: 1 });
  const budget = { claim: async () => null, claimKey: async key => key, abandon: async () => true, enqueue: async () => {} };
  const fleet = new BoxFleet(storage, {}, () => 1_000_000, { project, budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, prepareOnly: true });
  const root = await storage.get('verification:breaker');
  assert.equal(root.bySize.large.probe, null);
});


test('an uncertain provider call keeps its size probe fenced past the recovery deadline', async () => {
  const storage = new Storage(); await setup(storage);
  await storage.put('verification:breaker', { tripped: true, counts: { large: 3 }, bySize: { large: { tripped: true, trippedAt: 1, counts: { large: 3 }, probe: { createKey: 'probe', at: 1 } } } });
  await storage.put('create:probe', { createKey: 'probe', pool, size: 'large', state: 'pending', at: 1, queuedAt: 1 });
  await storage.put('gh-job:2', { id: 2, pool, status: 'queued', queuedAt: 1 });
  const budget = { claim: async () => ({ status: 'calling' }), claimKey: async key => key, cancelPending: async () => false, enqueue: async () => {} };
  const fleet = new BoxFleet(storage, {}, () => 1_000_000, { project, budget });
  await fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project, prepareOnly: true });
  assert.equal((await storage.get('verification:breaker')).bySize.large.probe.createKey, 'probe');
});
