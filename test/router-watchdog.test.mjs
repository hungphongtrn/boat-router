import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { stopSilent } from '../src/router/watchdog.mjs';
test('silent lease is quarantined before evidence and stop, then needs replacement', async () => {
  const storage = new Storage(), actions = [];
  await storage.put('machine:m1', { state: 'busy', lease: 'job1', lastActivityAt: 100 });
  const adapter = { captureEvidence: async () => { actions.push('evidence'); assert.equal((await storage.get('machine:m1')).state, 'quarantined'); }, stop: async () => { actions.push('stop'); } };
  assert.equal((await stopSilent({ storage, adapter, machineId: 'm1', leaseId: 'job1', now: 500, idleMs: 1000 })).stopped, false);
  assert.deepEqual(await stopSilent({ storage, adapter, machineId: 'm1', leaseId: 'job1', now: 1200, idleMs: 1000 }), { stopped: true, replace: true, evidence: true });
  assert.deepEqual(actions, ['evidence', 'stop']);
});

test('silent recovery captures evidence, retries an uncertain stop, and enqueues one replacement', async () => {
  const { recoverSilent } = await import('../src/router/watchdog.mjs');
  const storage = new Storage(), effects = [], replacements = new Map();
  await storage.put('machine:m1', { state: 'busy', lease: 'job1', lastActivityAt: 100 });
  let stopFails = true;
  const adapter = {
    captureEvidence: async () => { effects.push('evidence'); },
    stop: async () => { effects.push('stop'); if (stopFails) { stopFails = false; throw Error('uncertain'); } },
    enqueueReplacement: async ({ key }) => { effects.push('replace'); if (!replacements.has(key)) replacements.set(key, 'next-job'); return replacements.get(key); },
  };
  const args = { storage, adapter, machineId: 'm1', leaseId: 'job1', now: 1200, idleMs: 1000 };
  assert.deepEqual(await recoverSilent(args), { ok: false, reason: 'stop_uncertain', evidence: true });
  assert.deepEqual(await recoverSilent(args), { ok: true, evidence: true, replacement: 'next-job' });
  assert.deepEqual(await recoverSilent(args), { ok: true, evidence: true, replacement: 'next-job' });
  assert.deepEqual(effects, ['evidence', 'stop', 'stop', 'replace']);
  assert.equal((await storage.get('machine:m1')).state, 'quarantined');
});

test('a negative stop result cannot start a replacement', async () => {
  const { recoverSilent } = await import('../src/router/watchdog.mjs');
  for (const result of [false, { success: false }]) {
    const storage = new Storage(); let replacements = 0;
    await storage.put('machine:m1', { state: 'busy', lease: 'job1', lastActivityAt: 100 });
    const adapter = { captureEvidence: async () => {}, stop: async () => result, enqueueReplacement: async () => { replacements++; return 'next-job'; } };
    const args = { storage, adapter, machineId: 'm1', leaseId: 'job1', now: 1200, idleMs: 1000 };
    assert.equal((await recoverSilent(args)).reason, 'stop_uncertain');
    assert.equal((await storage.get('machine:m1')).watchdog.phase, 'stop');
    assert.equal(replacements, 0);
    const other = new Storage();
    await other.put('machine:m1', { state: 'busy', lease: 'job1', lastActivityAt: 100 });
    assert.equal((await stopSilent({ ...args, storage: other })).reason, 'stop_uncertain');
  }
});

test('silent recovery quarantines the job claim so a proven retry can proceed', async () => {
  const { recoverSilent } = await import('../src/router/watchdog.mjs');
  const { JitPool, jobKey } = await import('../src/router/jit-pool.mjs');
  const storage = new Storage(), compatibility = { account: 'example-account', project: 'project-a', size: 'large', image: 'golden', trust: 'project-a' };
  const adapter = { register: async () => ({}), start: async () => {}, captureEvidence: async () => {}, stop: async () => {}, enqueueReplacement: async () => 'retry', canRetry: async () => ({ boxTerminal: true, jobQueued: true }) };
  const pool = new JitPool(storage, adapter, () => 100);
  const job = { id: 'job1', machineId: 'm1', compatibility };
  await storage.put('machine:m1', { state: 'ready', compatibility, jobs: 0, createdAt: 1 });
  assert.equal((await pool.assign(job, { reuse: { enabled: true } }, { reuse: { mode: 'on' } })).ok, true);
  assert.equal((await recoverSilent({ storage, adapter, machineId: 'm1', leaseId: 'job1', now: 1200, idleMs: 1000 })).ok, true);
  assert.equal((await storage.get(jobKey('job1'))).state, 'quarantined');
  assert.equal((await pool.permitRetry(job)).ok, true);
  assert.equal((await storage.get(jobKey('job1'))).state, 'retryable');
});
