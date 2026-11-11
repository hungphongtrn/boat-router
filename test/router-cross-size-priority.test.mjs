import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet, largerDemandExpected } from '../src/router/box-fleet.mjs';

const project = { id: 'project-a', repo: 'owner/project-a', labels: ['boat-default', 'boat-large'], sizes: { 'boat-default': { machine: 'default' }, 'boat-large': { machine: 'large' } } };
const pool = label => JSON.stringify([project.repo, label]);

test('queued and recently arrived large jobs retain first claim', () => {
  const job = { pool: pool('boat-large'), status: 'queued', queuedAt: 1 };
  assert.equal(largerDemandExpected([job], project, 'large', 120_000), true);
  assert.equal(largerDemandExpected([{ ...job, status: 'in_progress', queuedAt: 60_001 }], project, 'large', 120_000), true);
  assert.equal(largerDemandExpected([{ ...job, status: 'completed', queuedAt: 60_000 }], project, 'large', 120_000), false);
  assert.equal(largerDemandExpected([{ ...job, pool: pool('boat-default') }], project, 'large', 120_000), false);
});

test('after reset a large box registers both labels only without expected large demand', async () => {
  for (const largeDemand of [false, true]) {
    const storage = new Storage(); let registration;
    await storage.put('pool:snapshot', { complete: true });
    if (largeDemand) await storage.put('gh-job:2', { id: 2, pool: pool('boat-large'), status: 'queued', queuedAt: 1 });
    await storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: pool('boat-default'), originPool: pool('boat-large'), size: 'large', state: 'ready', generation: 1, since: 0, reusable: true });
    const api = { configure: async (box, save) => { registration = box; await save(1); }, start: async () => ({ success: true }) };
    const fleet = new BoxFleet(storage, api, () => 120_000, { project, installation: 1 });
    await fleet.stepBox('bx_23456789');
    assert.deepEqual(registration.labels, largeDemand ? ['boat-large'] : ['boat-default', 'boat-large']);
    assert.equal(registration.pool, pool(largeDemand ? 'boat-large' : 'boat-default'));
  }
});
