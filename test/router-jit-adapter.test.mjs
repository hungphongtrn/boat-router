import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { JitPool, RESET_CHECKS } from '../src/router/jit-pool.mjs';
import { JitAdapter } from '../src/router/jit-adapter.mjs';

const compatibility = { account: 'example-account', project: 'project-a', size: 'large', image: 'golden', trust: 'project-a' };
const account = { reuse: { enabled: true } }, project = { reuse: { mode: 'on' } };
const job = id => ({ id, machineId: 'machine1', compatibility, repo: 'owner/repo', installation: 7, label: 'boat-large' });

test('a pooled machine gets a fresh durable runner identity for each job', async () => {
  const storage = new Storage(), effects = [];
  await storage.put('machine:machine1', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  const api = {
    configure: async (j, saveRunner) => { effects.push(['configure', j.id, j.generation]); await saveRunner(100 + j.generation); },
    start: async j => { assert.equal((await storage.get('machine:machine1')).runnerId, j.runnerId); effects.push(['start', j.runnerId]); },
    removeRunner: async j => effects.push(['remove', j.runnerId]),
  };
  const adapter = new JitAdapter(storage, api, async () => Object.fromEntries(RESET_CHECKS.map(k => [k, true])));
  const pool = new JitPool(storage, adapter, () => 1000);
  assert.equal((await pool.assign(job('one'), account, project)).ok, true);
  assert.equal((await pool.finish(job('one'), account, project)).ok, true);
  assert.equal((await storage.get('machine:machine1')).runnerId, null);
  assert.equal((await pool.assign(job('two'), account, project)).ok, true);
  assert.deepEqual(effects, [['configure', 'one', 1], ['start', 101], ['remove', 101], ['configure', 'two', 2], ['start', 102]]);
});

test('a missing reset verifier retires the machine after runner cleanup', async () => {
  const storage = new Storage();
  await storage.put('machine:machine1', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  const adapter = new JitAdapter(storage, { configure: async (_j, save) => save(1), start: async () => {}, removeRunner: async () => {} });
  const pool = new JitPool(storage, adapter, () => 1000);
  assert.equal((await pool.assign(job('one'), account, project)).ok, true);
  assert.equal((await pool.finish(job('one'), account, project)).reason, 'reset_failed');
  assert.equal((await storage.get('machine:machine1')).state, 'retiring');
});


test('a revoked lease cannot start after runner registration', async () => {
  const storage = new Storage(); let started = false;
  await storage.put('machine:machine1', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  const adapter = new JitAdapter(storage, {
    configure: async (_job, save) => { await save(1); const machine = await storage.get('machine:machine1'); await storage.put('machine:machine1', { ...machine, state: 'quarantined' }); },
    start: async () => { started = true; },
  });
  const pool = new JitPool(storage, adapter, () => 1000);
  assert.equal((await pool.assign(job('one'), account, project)).reason, 'assignment_uncertain');
  assert.equal(started, false);
});


test('a failed start response quarantines the lease', async () => {
  const storage = new Storage();
  await storage.put('machine:machine1', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  const adapter = new JitAdapter(storage, { configure: async (_job, save) => save(1), start: async () => ({ success: false }) });
  const pool = new JitPool(storage, adapter, () => 1000);
  assert.equal((await pool.assign(job('one'), account, project)).reason, 'assignment_uncertain');
  assert.equal((await storage.get('machine:machine1')).state, 'quarantined');
});
