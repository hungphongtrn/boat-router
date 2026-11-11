import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { breakerForSize } from '../src/router/verification-breaker.mjs';

const machine = (extra = {}) => ({ machineId: 'bx_23456789', createKey: 'original', pool: JSON.stringify(['owner/repo','boat-large']), size: 'large', state: 'booting', since: 0, createdAt: 0, queuedAt: 0, generation: 0, reusable: false, ...extra });
const budget = { claimKey: async () => 'a'.repeat(64), enqueue: async () => {} };

test('final sandbox observation wins at the boot deadline', async () => {
  const storage = new Storage(), box = machine(); await storage.put(`box:${box.machineId}`, box);
  const fleet = new BoxFleet(storage, { sandbox: async () => ({ sandbox: { state: 'ready', setupStatus: 'done' } }) }, () => 900_000);
  await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'ready');
  assert.equal(await storage.get('verification:breaker'), undefined);
});

test('eligible setup failure records one durable ledger replacement', async () => {
  const storage = new Storage(), box = machine(); await storage.put(`box:${box.machineId}`, box);
  const diagnostic = { providerErrorCategory: 'network', retryEligible: true, captureStatus: 'http_403', setupOutput: [] };
  const fleet = new BoxFleet(storage, { sandbox: async () => ({ sandbox: { state: 'error', setupStatus: 'failed' } }), setupDiagnostics: async () => diagnostic }, () => 10_000, { budget });
  await fleet.stepBox(box.machineId); await fleet.failedBoot(box, 'boot_failed', {});
  const failed = await storage.get(`box:${box.machineId}`), retry = await storage.get(`create:${failed.retryCreateKey}`);
  assert.equal(failed.state, 'destroying'); assert.equal(retry.setupRetry, true); assert.equal(retry.pool, box.pool);
  assert.equal((await storage.list({ prefix: 'create:' })).size, 1);
  const second = machine({ machineId: 'bx_2345678a', createKey: retry.createKey, setupRetry: true });
  await storage.put(`box:${second.machineId}`, second); await fleet.stepBox(second.machineId);
  assert.equal((await storage.list({ prefix: 'create:' })).size, 1);
});

test('provider 429 and terminal limit refusal wait without a breaker failure', async () => {
  const storage = new Storage(), box = machine(); await storage.put(`box:${box.machineId}`, box);
  const fleet = new BoxFleet(storage, { sandbox: async () => { throw { service: 'boat', status: 429, retrySeconds: 60 }; } }, () => 900_000);
  await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'booting');
  assert.equal(await storage.get('startBackoffUntil'), 960_000); assert.equal(await storage.get('verification:breaker'), undefined);
  fleet.api = { sandbox: async () => { throw { service: 'boat', status: 403, code: { code: 'QUOTA_EXCEEDED' } }; } };
  await fleet.stepBox(box.machineId); assert.equal((await storage.get(`box:${box.machineId}`)).state, 'booting');
  fleet.api = { sandbox: async () => ({ sandbox: { state: 'error', setupStatus: 'failed' } }), setupDiagnostics: async () => ({ providerErrorCategory: 'rate_limited', retryEligible: false, captureStatus: 'http_403', setupOutput: [] }) };
  await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).failureReason, 'provider_limited');
  assert.equal(await storage.get('verification:breaker'), undefined);
});

test('provider rate-limit waiting does not consume the boot deadline', async () => {
  const storage = new Storage(), box = machine(); let now = 800_000, limited = true;
  await storage.put(`box:${box.machineId}`, box);
  const fleet = new BoxFleet(storage, { sandbox: async () => { if (limited) throw { service: 'boat', status: 429 }; return { sandbox: { state: 'starting', setupStatus: 'running' } }; } }, () => now);
  await fleet.stepBox(box.machineId); now = 1_000_000; limited = false;
  await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).state, 'booting');
  assert.equal(await storage.get('verification:breaker'), undefined);
  now = 1_100_000; await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).failureReason, 'boot_timeout');
});

test('a reserved probe blocks other keys before ledger admission', async () => {
  const storage = new Storage(); let admissions = 0;
  await storage.put('verification:breaker', { tripped: true, trippedAt: 0, probe: { createKey: 'probe', at: 600_000 }, counts: {} });
  await storage.put('create:other', { createKey: 'other', pool: JSON.stringify(['owner/repo','boat-large']), size: 'large', queuedAt: 0, at: 0, state: 'pending' });
  const fleet = new BoxFleet(storage, {}, () => 600_000, { budget: { claim: async () => null, admit: async () => { admissions++; return { ok: true }; } } });
  assert.equal(await fleet.admit('other', {}, 3600), false); assert.equal(admissions, 0);
});

test('a capacity-refused probe keeps its reservation until cancellation', async () => {
  const storage = new Storage(); let admissions = 0;
  await storage.put('verification:breaker', { tripped: true, trippedAt: 0, counts: {} });
  await storage.put('create:probe', { createKey: 'probe', pool: JSON.stringify(['owner/repo','boat-large']), size: 'large', queuedAt: 0, at: 0, state: 'pending' });
  await storage.put('create:other', { createKey: 'other', pool: JSON.stringify(['owner/repo','boat-large']), size: 'large', queuedAt: 0, at: 0, state: 'pending' });
  const fleet = new BoxFleet(storage, {}, () => 600_000, { budget: { claim: async () => null, admit: async () => { admissions++; return { ok: false, reason: 'hour' }; } } });
  assert.equal(await fleet.admit('probe', {}, 3600), false);
  assert.equal(breakerForSize(await storage.get('verification:breaker'), 'large').probe.createKey, 'probe');
  assert.equal(await fleet.admit('other', {}, 3600), false); assert.equal(admissions, 1);
  await fleet.discardCreate('probe');
  assert.equal(breakerForSize(await storage.get('verification:breaker'), 'large').probe, null);
  assert.equal(await storage.get('create:probe'), undefined);
});

test('a failed final provider read is recorded as a boot timeout', async () => {
  const storage = new Storage(), box = machine(); await storage.put(`box:${box.machineId}`, box);
  const fleet = new BoxFleet(storage, { sandbox: async () => { throw { service: 'boat', status: 503 }; } }, () => 900_000);
  await fleet.stepBox(box.machineId);
  assert.equal((await storage.get(`box:${box.machineId}`)).failureReason, 'boot_timeout');
  assert.equal((await storage.get('verification:breaker')).counts.large, 1);
});
