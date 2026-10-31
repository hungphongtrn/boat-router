import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BalancerHistory, arrivalRate, historyKey, runtimeQuantiles } from '../src/router/balancer-history.mjs';

const job = (id, fields = {}) => ({ id, status: 'queued', size: 'large', workflowName: 'CI', jobName: 'Tests (1/4)', generation: 1, ...fields });

test('arrival history counts a job once and decays after inactivity', async () => {
  let now = 10000000; const storage = new Storage(), history = new BalancerHistory(storage, () => now);
  await storage.put('job:1', job(1)); await history.arrival(1); await history.arrival(1);
  assert.equal((await history.read()).arrivals.large.rate, 1);
  now += 3600000;
  await storage.put('job:2', job(2)); await history.arrival(2);
  const entry = (await history.read()).arrivals.large;
  assert.ok(Math.abs(entry.rate - (1 + Math.exp(-1))) < 1e-9);
  assert.equal(arrivalRate(entry, now + 86400001), null);
  assert.equal(arrivalRate(entry, now - 1), null);
});

test('runtime history is grouped by workflow and matrix job, deduplicated by generation and bounded', async () => {
  let now = 10000000; const storage = new Storage(), history = new BalancerHistory(storage, () => now);
  await storage.put('job:1', job(1, { runnerStartedAt: now - 100000 }));
  await history.runtime(1); await history.runtime(1);
  let state = await history.read(), key = historyKey(job(1));
  assert.deepEqual(runtimeQuantiles(state.runtimes[key], now), { medianSeconds: 100, p75Seconds: 100, samples: 1 });
  await storage.put('job:1', job(1, { generation: 2, jobName: 'Tests (3/4)', runnerStartedAt: now - 200000, balancerRuntimeGeneration: 1 }));
  await history.runtime(1);
  state = await history.read();
  assert.deepEqual(runtimeQuantiles(state.runtimes[key], now), { medianSeconds: 100, p75Seconds: 200, samples: 2 });
  assert.equal(runtimeQuantiles(state.runtimes[key], now + 7 * 86400000 + 1), null);
  for (let i = 0; i < 70; i++) { await storage.put(`job:${i + 2}`, job(i + 2, { jobName: `job ${i}`, runnerStartedAt: now - 1000 })); await history.runtime(i + 2); now++; }
  assert.equal(Object.keys((await history.read()).runtimes).length, 64);
});

test('missing workflow or clock anomalies do not invent runtime history', async () => {
  let now = 10000000; const storage = new Storage(), history = new BalancerHistory(storage, () => now);
  await storage.put('job:1', job(1, { workflowName: undefined, runnerStartedAt: now - 1000 })); await history.runtime(1);
  await storage.put('job:2', job(2, { runnerStartedAt: now + 1 })); await history.runtime(2);
  assert.deepEqual((await history.read()).runtimes, {});
});
