import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { JitPool, RESET_CHECKS } from '../src/router/jit-pool.mjs';
const compatibility = { account: 'example-account', project: 'project-a', size: 'large', image: 'golden', trust: 'project-a' };
const account = { reuse: { enabled: true } }, project = { reuse: { mode: 'on' } };
const job = id => ({ id, machineId: 'machine1', compatibility });
async function fixture(adapter) {
  const storage = new Storage();
  await storage.put('machine:machine1', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  return { storage, pool: new JitPool(storage, adapter, () => 1000) };
}
test('reuse gets a fresh registration and refuses another project', async () => {
  const registered = [];
  const { pool } = await fixture({ register: async (j, gen) => { registered.push([j.id, gen]); return gen; }, start: async () => {}, removeRunner: async () => {}, resetAndVerify: async () => Object.fromEntries(RESET_CHECKS.map(k => [k, true])) });
  assert.equal((await pool.assign({ ...job('bad'), compatibility: { ...compatibility, project: 'project-b' } }, account, project)).ok, false);
  assert.equal((await pool.assign({ ...job('wrong-size'), compatibility: { ...compatibility, size: 'small' } }, account, project)).ok, false);
  assert.equal((await pool.assign(job('one'), account, project)).ok, true); assert.equal((await pool.finish(job('one'), account, project)).ok, true);
  assert.equal((await pool.assign(job('two'), account, project)).ok, true);
  assert.deepEqual(registered, [['one', 1], ['two', 2]]);
});
test('failed verification retires, uncertain cleanup quarantines, switches disable reuse', async () => {
  for (const [adapter, ac, pr, expected] of [
    [{ removeRunner: async () => {}, resetAndVerify: async () => false }, account, project, 'retiring'],
    [{ removeRunner: async () => { throw Error('unknown'); } }, account, project, 'quarantined'],
    [{ removeRunner: async () => {} }, { reuse: { enabled: false } }, project, 'retiring'],
    [{ removeRunner: async () => {} }, account, { reuse: { mode: 'off' } }, 'retiring'],
  ]) {
    const { pool, storage } = await fixture({ register: async () => 'jit', start: async () => {}, ...adapter });
    assert.equal((await pool.assign(job('one'), ac, pr)).ok, true);
    await pool.finish(job('one'), ac, pr);
    assert.equal((await storage.get('machine:machine1')).state, expected);
  }
});

test('concurrent completion cannot reset a machine twice or make it reusable early', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let resets = 0;
  const { pool } = await fixture({ register: async () => 'jit', start: async () => {}, removeRunner: async () => blocked, resetAndVerify: async () => { resets++; return Object.fromEntries(RESET_CHECKS.map(k => [k, true])); } });
  await pool.assign(job('one'), account, project);
  const first = pool.finish(job('one'), account, project);
  const second = pool.finish(job('one'), account, project);
  assert.equal((await second).reason, 'lost_lease');
  assert.equal((await pool.assign(job('two'), account, project)).ok, false);
  release(); assert.equal((await first).ok, true); assert.equal(resets, 1);
});

test('restart quarantines an interrupted assignment or cleanup before another lease', async () => {
  for (const state of ['assigning', 'cleaning']) {
    const { storage } = await fixture({});
    await storage.put('machine:machine1', { state, compatibility, jobs: 1, createdAt: 0, lease: 'one' });
    const restarted = new JitPool(storage, {}, () => 2000);
    assert.equal(await restarted.recover('machine1'), true);
    assert.equal((await storage.get('machine:machine1')).state, 'quarantined');
    assert.equal((await restarted.assign(job('two'), account, project)).ok, false);
    assert.equal(await restarted.recover('machine1'), false);
  }
});

test('one job cannot lease two machines concurrently or be assigned again after completion', async () => {
  const adapter = { register: async () => 'jit', start: async () => {}, removeRunner: async () => {}, resetAndVerify: async () => Object.fromEntries(RESET_CHECKS.map(k => [k, true])) };
  const { pool, storage } = await fixture(adapter);
  await storage.put('machine:machine2', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  const [first, second] = await Promise.all([pool.assign(job('same'), account, project), pool.assign({ ...job('same'), machineId: 'machine2' }, account, project)]);
  assert.equal([first, second].filter(result => result.ok).length, 1);
  const machineId = first.ok ? 'machine1' : 'machine2';
  assert.equal((await pool.finish({ ...job('same'), machineId }, account, project)).ok, true);
  assert.equal((await pool.assign({ ...job('same'), machineId }, account, project)).ok, false);
});


test('a numeric GitHub job id and its string form share one assignment claim', async () => {
  const { pool, storage } = await fixture({ register: async () => 'jit', start: async () => {} });
  await storage.put('machine:machine2', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  assert.equal((await pool.assign(job(123), account, project)).ok, true);
  assert.equal((await pool.assign({ ...job('123'), machineId: 'machine2' }, account, project)).ok, false);
});


test('an uncertain job gets at most one retry after terminal-box and queued-job proof', async () => {
  let proof = { boxTerminal: false, jobQueued: true };
  const adapter = { register: async () => { throw Error('uncertain'); }, canRetry: async () => proof };
  const { pool, storage } = await fixture(adapter);
  assert.equal((await pool.assign(job('retry'), account, project)).reason, 'assignment_uncertain');
  assert.equal((await pool.permitRetry(job('retry'))).reason, 'retry_uncertain');
  assert.equal((await pool.assign(job('retry'), account, project)).ok, false);
  proof = { boxTerminal: true, jobQueued: true };
  assert.equal((await pool.permitRetry(job('retry'))).ok, true);
  await storage.put('machine:machine2', { state: 'ready', compatibility, jobs: 0, createdAt: 0 });
  assert.equal((await pool.assign({ ...job('retry'), machineId: 'machine2', compatibility: { ...compatibility, project: 'project-b' } }, account, project)).ok, false);
  assert.equal((await pool.assign({ ...job('retry'), machineId: 'machine2' }, account, project)).reason, 'assignment_uncertain');
  assert.equal((await pool.permitRetry({ ...job('retry'), machineId: 'machine2' })).reason, 'retry_exhausted');
});
