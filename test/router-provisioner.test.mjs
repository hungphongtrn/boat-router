import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { Provisioner } from '../src/router/provisioner.mjs';

const compatibility = { account: 'example-account', project: 'project-a', size: 'large', image: 'golden', trust: 'project-a' };
const snapshot = { at: 1000, canStart: true, windows: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { used: 0, limit: 10 }])) };
const request = { project: 'project-a', key: 'start1', compatibility, snapshot };
function fixture(adapter) {
  const storage = new Storage();
  const ledger = new AccountLedger(storage, { id: 'example-account', dayReserve: 0, starts: { minute: 1, hour: 1, day: 1 } }, () => 1000);
  return { storage, ledger, provisioner: new Provisioner(storage, ledger, adapter, () => 1000) };
}

test('a lost create response remains charged and restart reconciles the owned machine', async () => {
  let calls = 0;
  const adapter = { create: async ({ key }) => { calls++; assert.equal(key, 'start1'); throw Error('lost response'); }, find: async () => ({ state: 'found', id: 'machine1' }) };
  const { storage, ledger, provisioner } = fixture(adapter);
  assert.equal((await provisioner.start(request)).reason, 'create_uncertain');
  const restarted = new Provisioner(storage, ledger, adapter, () => 2000);
  assert.equal((await restarted.start(request)).reason, 'reconciliation_required');
  assert.deepEqual(await restarted.reconcile(request), { ok: true, machineId: 'machine1' });
  assert.equal(calls, 1);
  assert.equal((await storage.get('machine:machine1')).state, 'creating');
  assert.equal((await storage.get('machine:machine1')).createdAt, 1000);
  assert.equal((await ledger.claim('start1')).status, 'created');
  await assert.rejects(ledger.resolve('start1', 'not_created'), /cannot be refunded/);
});

test('an interrupted claim does not issue a create and releases only final absence', async () => {
  let result = { state: 'absent', final: false }, calls = 0;
  const { storage, ledger, provisioner } = fixture({ create: async () => { calls++; }, find: async () => result });
  await storage.put('start:start1', { project: 'project-a', compatibility });
  await ledger.enqueue('project-a', 'start1');
  assert.equal((await ledger.admit('project-a', 'start1', snapshot)).ok, true);
  assert.equal((await provisioner.start(request)).reason, 'reconciliation_required');
  assert.equal((await provisioner.reconcile(request)).reason, 'create_uncertain');
  assert.equal((await ledger.claim('start1')).status, 'pending');
  result = { state: 'absent', final: true };
  assert.equal((await provisioner.reconcile(request)).reason, 'confirmed_absent');
  assert.equal(await ledger.claim('start1'), null);
  assert.deepEqual(await storage.get('start:start1'), { project: 'project-a', compatibility });
  assert.equal(calls, 0);
});

test('parallel requests cannot create or reconcile the same claim twice', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { provisioner } = fixture({ create: async () => { await gate; return { id: 'machine1' }; }, find: async () => ({ state: 'absent', final: true }) });
  const first = provisioner.start(request);
  assert.equal((await provisioner.start(request)).reason, 'in_flight');
  assert.equal((await provisioner.reconcile(request)).reason, 'in_flight');
  release();
  assert.deepEqual(await first, { ok: true, machineId: 'machine1' });
});

test('an in-flight provider request cannot be cancelled as an uncalled claim', async () => {
  let release, started;
  const gate = new Promise(resolve => { release = resolve; });
  const entered = new Promise(resolve => { started = resolve; });
  const { ledger, provisioner } = fixture({ create: async () => { started(); await gate; return { id: 'machine1' }; } });
  const requestPromise = provisioner.start(request);
  await entered;
  assert.equal((await ledger.claim('start1')).status, 'calling');
  assert.equal(await ledger.abandon('project-a', 'start1'), false);
  release();
  assert.equal((await requestPromise).ok, true);
  assert.equal((await ledger.claim('start1')).status, 'created');
});


test('a claim cannot be rebound to another image after an uncertain create', async () => {
  const { provisioner } = fixture({ create: async () => { throw Error('lost response'); }, find: async () => ({ state: 'found', id: 'machine1' }) });
  await provisioner.start(request);
  const changed = { ...request, compatibility: { ...compatibility, image: 'other' } };
  await assert.rejects(provisioner.reconcile(changed), /start identity conflict/);
  assert.equal((await provisioner.reconcile(request)).machineId, 'machine1');
});


test('reconciliation refuses to invent an identity for an orphan claim', async () => {
  const { ledger, provisioner } = fixture({ find: async () => ({ state: 'found', id: 'machine1' }) });
  await ledger.enqueue('project-a', 'start1');
  await ledger.admit('project-a', 'start1', snapshot);
  assert.equal((await provisioner.reconcile(request)).reason, 'missing_start_identity');
  assert.equal((await ledger.claim('start1')).status, 'pending');
});
