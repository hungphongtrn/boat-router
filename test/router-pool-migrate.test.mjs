import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { migrateProject } from '../src/router/pool-migrate.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { PoolFleet } from '../src/router/pool-fleet.mjs';
import { jobKey } from '../src/router/jit-pool.mjs';

const project = { id: 'demo', repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } } };

test('operator recovery verifies and releases an archived attention record', async () => {
  const storage = new Storage(), id = 1, machineId = 'bx_23456789';
  const job = { id, repo: project.repo, installation: 1, label: 'boat-large', size: 'large', phase: 'attention', attentionReason: 'alert_pool_retry_unconfirmed', machineId, runnerId: 10, generation: 1, createKey: 'old', retryCount: 1, createdAt: 1 };
  await storage.put(`job:${id}`, job);
  await storage.put(`machine:${machineId}`, { state: 'quarantined', lease: id, generation: 1 });
  await storage.put(jobKey(id), { state: 'quarantined', machineId, generation: 1 });
  await migrateProject(storage, project, 'commit', () => 100);
  const missing = async () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const api = { getJob: async () => ({ status: 'queued', runner_name: null }), sandbox: missing, runner: missing };
  const fleet = new PoolFleet(storage, {}, api, () => 200, () => {}, { project });
  assert.equal(await fleet.operatorRecoverArchivedAttention(id), true);
  assert.equal((await storage.get(`box:${machineId}`)).state, 'deleted');
  assert.equal((await storage.get(`gh-job:${id}`)).status, 'queued');
  assert.equal((await storage.get(`legacy:job:${id}`)).value.phase, 'queued');
  assert.equal(await fleet.operatorRecoverArchivedAttention(id), false);
});

test('archived attention recovery refuses a present runner', async () => {
  const storage = new Storage(), id = 1, machineId = 'bx_23456789';
  const job = { id, repo: project.repo, installation: 1, label: 'boat-large', size: 'large', phase: 'attention', attentionReason: 'alert_pool_retry_unconfirmed', machineId, runnerId: 10, generation: 1, createKey: 'old', createdAt: 1 };
  await storage.put(`job:${id}`, job);
  await storage.put(`machine:${machineId}`, { state: 'quarantined', lease: id, generation: 1 });
  await storage.put(jobKey(id), { state: 'quarantined', machineId, generation: 1 });
  await migrateProject(storage, project, 'commit', () => 100);
  const missing = async () => { throw Object.assign(new Error('missing'), { status: 404 }); };
  const fleet = new PoolFleet(storage, {}, { getJob: async () => ({ status: 'queued' }), sandbox: missing, runner: async () => ({ busy: true }) }, () => 200, () => {}, { project });
  assert.equal(await fleet.operatorRecoverArchivedAttention(id), false);
  assert.equal((await storage.get(`box:${machineId}`)).state, 'quarantined');
});

test('migration preserves pending creates, legacy runner identities and queued webhooks across pages', async () => {
  const storage = new Storage();
  for (let id = 1; id <= 70; id++) await storage.put(`job:${id}`, { id, repo: project.repo, label: 'boat-large', size: 'large', phase: 'queued', createdAt: 1 });
  await storage.put('job:1', { id: 1, label: 'boat-large', size: 'large', phase: 'running', machineId: 'bx_23456789', runnerId: 7, generation: 1, runnerIdentity: 'boat-ci-j1-g2', installation: 5, createdAt: 1 });
  await storage.put('job:2', { id: 2, label: 'boat-large', size: 'large', phase: 'queued', createPending: true, createKey: 'k', routerCreateName: 'name', createAttemptedAt: 2, createdAt: 1 });
  await storage.put('webhook-pending:0000000000000003:one', { id: 3, repo: project.repo, label: 'boat-large', status: 'completed' });
  await migrateProject(storage, project, 'commit', () => 100);
  assert.equal((await storage.get('create:k')).state, 'unknown');
  assert.equal((await storage.get('runner:boat-ci-j1-g1')).machineId, 'bx_23456789');
  assert.equal((await storage.get('runner:boat-ci-j1-g2')).machineId, 'bx_23456789');
  assert.equal((await storage.get('gh-job:3')).status, 'completed');
  assert.equal(await storage.get('job:1'), undefined);
  assert.equal((await storage.get('legacy:job:1')).value.runnerId, 7);
  assert.equal((await storage.get('pool:migrated')).done, true);
  await migrateProject(storage, project, 'commit', () => 200);
  assert.equal((await storage.get('pool:migrated')).finishedAt, 100);
  assert.equal(await migrateProject(storage, project, 'later-commit'), true);
  await storage.put('pool:migrated', { commit: 'commit', prefix: 0, cursor: '', done: false });
  await assert.rejects(migrateProject(storage, project, 'different'), /commit mismatch/);
});

test('unlabeled warm machine is drain-only and waits for a complete snapshot before cleanup', async () => {
  const storage = new Storage();
  await storage.put('machine:bx_23456789', { state: 'ready', compatibility: { size: 'large' }, createdAt: 1 });
  await migrateProject(storage, project, 'commit', () => 10);
  const machine = await storage.get('box:bx_23456789');
  assert.equal(machine.pool, null); assert.equal(machine.drainOnly, true);
  assert.equal((await storage.get('pool:drain-only:bx_23456789')).reason, 'pool_unknown');
  const fleet = new BoxFleet(storage, {}, () => 20, { project });
  await fleet.stepBox(machine.machineId, { complete: false });
  assert.equal((await storage.get('box:bx_23456789')).state, 'quarantined');
  await fleet.stepBox(machine.machineId, { complete: true, runners: [] });
  assert.equal((await storage.get('box:bx_23456789')).state, 'destroying');
});

test('migration resumes after interruption following a committed record', async () => {
  const storage = new Storage();
  for (let id = 1; id <= 3; id++) await storage.put(`job:${id}`, { id, repo: project.repo, label: 'boat-large', size: 'large', phase: 'queued', createdAt: id, installation: 5 });
  const transaction = storage.transaction.bind(storage); let interrupt = true;
  storage.transaction = async fn => {
    const result = await transaction(fn);
    if (interrupt) { interrupt = false; throw new Error('interrupted after commit'); }
    return result;
  };
  await assert.rejects(migrateProject(storage, project, 'commit', () => 100), /interrupted/);
  assert.equal((await storage.get('pool:migrated')).cursor, 'job:1');
  assert.equal(await storage.get('job:1'), undefined);
  await migrateProject(storage, project, 'commit', () => 200);
  assert.equal((await storage.get('pool:migrated')).done, true);
  for (let id = 1; id <= 3; id++) {
    assert.equal((await storage.get(`gh-job:${id}`)).status, 'queued');
    assert.equal((await storage.get(`legacy:job:${id}`)).value.id, id);
  }
});
