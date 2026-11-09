import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { FleetController } from '../src/fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { APIs } from '../src/apis.mjs';

const limits = now => ({ observedAt: now, canStart: true, startLimits: { perMinute: 2, perHour: 2, perDay: 2 }, starts: Object.fromEntries(['minute', 'hour', 'day'].map(k => [k, { limit: 2, used: 0, remaining: 2 }])) });

test('an injected fleet budget fences creates and never repeats an uncertain create', async () => {
  const now = () => 1000000, storage = new Storage();
  const ledger = new AccountLedger(storage, { starts: { minute: 2, hour: 2, day: 2 } }, now);
  const budget = new SharedBudget(ledger, 'project-a', now); let calls = 0;
  const api = { create: async () => { calls++; throw new Error('connection lost'); }, findCreated: async () => null };
  const fleet = new FleetController(storage, {}, api, now, () => {}, { sharedBudget: budget });
  const job = { id: 1, createKey: 'attempt', phase: 'queued', nextAt: 0 };
  await storage.put('job:1', job);
  await assert.rejects(fleet.create(job, 60), error => error.code === 'reconciliation_required');
  assert.equal(calls, 0);
  assert.equal((await budget.admit('attempt', limits(now()))).ok, true);
  await assert.rejects(fleet.create(job, 60), /connection lost/);
  assert.equal(calls, 1);
  assert.equal((await ledger.claim(await budget.claimKey('attempt'))).status, 'unknown');
  await assert.rejects(fleet.create(job, 60, true), error => error.code === 'reconciliation_required');
  assert.equal(calls, 1);
});

test('a found uncertain create resumes its original job without a second create', async () => {
  const now = () => 1000000, storage = new Storage();
  const ledger = new AccountLedger(storage, { starts: { minute: 2, hour: 2, day: 2 } }, now);
  const budget = new SharedBudget(ledger, 'project-a', now); let creates = 0;
  const api = { create: async () => { creates++; throw new Error('response lost'); },
    findCreated: async job => job.routerCreateName ? { id: 'bx_23456789', name: job.routerCreateName } : null };
  const fleet = new FleetController(storage, {}, api, now, () => {}, { sharedBudget: budget });
  const job = { id: 1, createKey: 'attempt', phase: 'queued', nextAt: 0 };
  await storage.put('job:1', job);
  await budget.admit(job.createKey, limits(now()));
  const reserved = await fleet.reserve(job, 'large');
  await assert.rejects(fleet.create(reserved, 7200), /response lost/);
  assert.equal((await ledger.claim(await budget.claimKey(job.createKey))).status, 'unknown');
  await fleet.create(await storage.get('job:1'), 7200, true);
  assert.equal(creates, 1);
  assert.equal((await storage.get('job:1')).machineId, 'bx_23456789');
  assert.equal((await ledger.claim(await budget.claimKey(job.createKey))).status, 'created');
});

test('provider reconciliation follows pages and rejects ambiguous identities', async () => {
  const api = new APIs({});
  const name = `boat-router-${'a'.repeat(32)}`, job = { routerCreateName: name };
  await assert.rejects(api.findCreated({}), error => error.code === 'lookup_identity_missing');
  api.request = async (_service, path) => path.includes('cursor=next')
    ? { sandboxes: [{ name, id: 'bx_23456789' }] }
    : { sandboxes: [], pageInfo: { nextCursor: 'next' } };
  assert.equal((await api.findCreated(job)).id, 'bx_23456789');
  api.request = async () => ({ sandboxes: [{ name, id: 'bx_23456789' }, { name, id: 'bx_2345678a' }] });
  await assert.rejects(api.findCreated(job));
  api.request = async () => ({ sandboxes: [], pageInfo: { nextCursor: 'again' } });
  await assert.rejects(api.findCreated(job));
});

test('a pre-call pending reservation resumes once or releases when stopped', async () => {
  for (const stopped of [false, true]) {
    const now = () => 1000000, storage = new Storage();
    const ledger = new AccountLedger(storage, { starts: { minute: 2, hour: 2, day: 2 } }, now);
    const budget = new SharedBudget(ledger, 'project-a', now); let creates = 0;
    const api = { create: async () => { creates++; return { sandbox: { id: 'bx_23456789' } }; } };
    const fleet = new FleetController(storage, { ENABLED: 'true' }, api, now, () => {}, { sharedBudget: budget });
    const job = { id: 1, repo: 'hungphongtrn/peek', size: 'large', createKey: 'attempt', phase: 'queued', nextAt: 0, intentDone: stopped };
    await storage.put('job:1', job);
    assert.equal((await budget.admit(job.createKey, limits(now()))).ok, true);
    assert.equal((await budget.admit(job.createKey, limits(now()))).ok, true);
    if (stopped) await storage.put('job:1', { ...job, intentDone: false });
    const reserved = await fleet.reserve({ ...job, intentDone: false }, 'large');
    if (stopped) { await fleet.patch(job.id, { intentDone: true }); reserved.intentDone = true; }
    await fleet.create(reserved, 7200, true);
    assert.equal(creates, stopped ? 0 : 1);
    assert.equal((await storage.get('job:1')).createPending, false);
    if (stopped) assert.equal(await budget.claim(job.createKey), null);
  }
});

test('a pre-call reservation cannot start while account preparation failed', async () => {
  const now = () => 1000000, storage = new Storage();
  const ledger = new AccountLedger(storage, { starts: { minute: 2, hour: 2, day: 2 } }, now);
  const budget = new SharedBudget(ledger, 'project-a', now); let creates = 0;
  const fleet = new FleetController(storage, { ENABLED: 'true' }, { create: async () => { creates++; } }, now, () => {}, { sharedBudget: budget });
  const job = { id: 1, repo: 'hungphongtrn/peek', size: 'large', createKey: 'attempt', phase: 'queued', nextAt: 0 };
  await storage.put('job:1', job); await budget.admit(job.createKey, limits(now()));
  const reserved = await fleet.reserve(job, 'large');
  fleet.startPreparationFailed = true;
  await fleet.create(reserved, 7200, true);
  assert.equal(creates, 0);
  assert.equal((await budget.claim(job.createKey)).status, 'pending');
});

test('a completed queued fleet job leaves the shared admission queue', async () => {
  let time = 1000000; const now = () => time, storage = new Storage();
  const ledger = new AccountLedger(storage, { starts: { minute: 1, hour: 1, day: 1 } }, now);
  const first = new SharedBudget(ledger, 'project-a', now), second = new SharedBudget(ledger, 'project-b', now);
  await first.admit('occupied', limits(now()));
  time++;
  assert.equal((await first.admit('cancelled', limits(now()))).reason, 'minute_cap');
  time++;
  assert.equal((await second.admit('next', limits(now()))).reason, 'minute_cap');
  const fleet = new FleetController(storage, {}, {}, now, () => {}, { sharedBudget: first });
  fleet.patch = async (_id, fields) => ({ id: 1, createKey: 'cancelled', intentDone: true, ...fields });
  fleet.emit = async () => {};
  await fleet.finish({ id: 1, phase: 'queued', createKey: 'cancelled', intentDone: true });
  await first.abandon('occupied');
  assert.equal((await second.admit('next', limits(now()))).ok, true);
});
