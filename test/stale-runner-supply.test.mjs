import test from 'node:test';
import assert from 'node:assert/strict';
import { FleetController } from '../src/fleet.mjs';
import { Storage } from './helpers.mjs';

test('a completed job with a missing runner does not hold queued demand as spare supply', async () => {
  const storage = new Storage(), now = () => 1000000;
  const api = { runner: async () => { throw Object.assign(new Error('missing'), { status: 404 }); } };
  const fleet = new FleetController(storage, { ENABLED: 'true' }, api, now, () => {});
  fleet.destroy = async job => fleet.patch(job.id, { phase: 'purging' });
  const base = { repo: 'example-owner/project-a', label: 'boat-large', size: 'large', nextAt: 0, createKey: 'key', createdAt: 1, installation: 1 };
  const ghost = { ...base, id: 1, phase: 'running', machineId: 'box', runnerId: 312, machineCreatedAt: 999000, intentDone: true, intentStarted: true, lastCheckedAt: now() };
  const demand = { ...base, id: 2, phase: 'queued', intentDone: false, intentStarted: false };
  await storage.transaction(async tx => { await fleet.save(tx, ghost); await fleet.save(tx, demand); });
  await fleet.step(ghost);
  assert.equal((await storage.get('job:1')).phase, 'purging');
});

test('a busy runner is not retired even when its intended job has completed', async () => {
  const storage = new Storage(), now = () => 1000000;
  const fleet = new FleetController(storage, { ENABLED: 'true' }, { runner: async () => ({ busy: true }) }, now, () => {});
  const job = { id: 1, repo: 'example-owner/project-a', label: 'boat-large', size: 'large', nextAt: 0, createKey: 'key', phase: 'running', machineId: 'box', runnerId: 312, machineCreatedAt: 999000, intentDone: true, intentStarted: true, lastCheckedAt: now() };
  await storage.transaction(tx => fleet.save(tx, job));
  await fleet.step(job);
  assert.equal((await storage.get('job:1')).phase, 'running');
});
