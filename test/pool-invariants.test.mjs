import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { assertObservationOnly, assertPoolInvariants } from './pool-invariants.mjs';

test('supply oracle rejects expired and drain-only units even if the planner counts them', async () => {
  const storage = new Storage();
  const project = { repo: 'example/repo', labels: ['work'] };
  const key = JSON.stringify([project.repo, 'work']);
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  await storage.put('box:first', { machineId: 'first', pool: key, state: 'booting', since: 0 });
  await storage.put('box:second', { machineId: 'second', pool: key, state: 'ready', drainOnly: true });
  await storage.put('box:third', { machineId: 'third', pool: key, state: 'destroying' });
  const decision = { supply: {}, S: 0 };
  const sim = { storage, fleet: { tick: async () => ({ [key]: decision }) }, project, jobs: [], machines: new Set(['first', 'second', 'third']), runners: new Map(), now: 300000, limit: 3, seed: 'oracle' };
  await assertPoolInvariants(sim, { maxWaitS: 540 });
  for (const state of ['booting', 'ready', 'destroying']) {
    decision.supply = { [state]: 1 }; decision.S = 1;
    await assert.rejects(assertPoolInvariants(sim, { maxWaitS: 540 }), /incorrect supply or expired deadline/);
  }
});

test('pending admission uses observed demand instead of the reported planner demand', async () => {
  const storage = new Storage(), project = { repo: 'example/repo', labels: ['work'] };
  const key = JSON.stringify([project.repo, 'work']);
  await storage.put('pool:snapshot', { complete: true, runners: [] });
  await storage.put('gh-job:1', { id: 1, pool: key, status: 'queued', queuedAt: 0 });
  await storage.put('create:a', { pool: key, state: 'pending', createKey: 'a' });
  await storage.put('create:b', { pool: key, state: 'pending', createKey: 'b' });
  const fleet = { tick: async () => ({ [key]: { supply: { 'create:pending': 2 }, S: 2, Dboat: 2 } }) };
  const sim = { storage, fleet, project, jobs: [], machines: new Set(), runners: new Map(), now: 1000, limit: 4, seed: 'oracle', prepared: {} };
  await assert.rejects(assertPoolInvariants(sim, { maxWaitS: 540 }), /multiple pending creates/);
});

test('the account cap and immutable created claims are checked independently', async () => {
  const storage = new Storage(), ledgerStorage = new Storage();
  const project = { repo: 'example/repo', labels: ['work'] };
  const sim = { storage, ledgerStorage, createdClaims: new Set(['claim']), project, jobs: [], machines: new Set(), runners: new Map(), now: 0, limit: 0, seed: 'oracle' };
  await assert.rejects(assertPoolInvariants(sim, { maxWaitS: 540 }), /created claim was refunded/);
  await ledgerStorage.put('account:ledger', { claims: { claim: { status: 'created' } } });
  sim.machines.add('machine');
  await assert.rejects(assertPoolInvariants(sim, { maxWaitS: 540 }), /account limit exceeded/);
});

test('the observation guard detects a box mutation', async () => {
  const storage = new Storage();
  await storage.put('box:first', { state: 'idle' });
  await assert.rejects(assertObservationOnly(storage, () => storage.put('box:first', { state: 'busy' })), /observation changed box state/);
});

test('the shared checker rejects an unsafe provider destroy even if an error was caught', async () => {
  const sim = { storage: new Storage(), project: {}, jobs: [], machines: new Set(), runners: new Map(), now: 0, limit: 1, seed: 'oracle', unsafeDestroys: ['machine'] };
  await assert.rejects(assertPoolInvariants(sim, { maxWaitS: 540 }), /destroy without an observed fence/);
});
