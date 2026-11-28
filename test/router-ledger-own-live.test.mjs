import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AccountLedger, snapshotLimits } from '../src/router/ledger.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';

const now = 10_000_000;
const limits = ({ active = 0, maxActive = 100 } = {}) => ({
  canStart: true, activeSandboxes: active, maxActiveSandboxes: maxActive,
  starts: { minute: { limit: 12, used: 0 }, hour: { limit: 60, used: 0 }, day: { limit: 200, used: 0 } },
});
const ledger = liveSandboxCap => new AccountLedger(new Storage(), { requireConcurrency: true, liveSandboxCap, starts: { minute: 12, hour: 60, day: 200 }, margin: 0, dayReserve: 0 }, () => now);
const admit = async (account, options, snapshot = limits()) => {
  await account.enqueue('demo', 'first', now);
  return account.admit('demo', 'first', snapshotLimits(snapshot, now), options);
};

test('a sandbox another API key created does not spend this router live cap', async () => {
  // 11 sandboxes live on the account, none of them recorded by this router, and
  // the provider still allows 100: the local live budget has all 5 slots free.
  const admitted = await admit(ledger(5), { ownLive: 0 }, limits({ active: 11 }));
  assert.equal(admitted.ok, true);
});

test('this router five live boxes still refuse a sixth create at the live cap', async () => {
  const refused = await admit(ledger(5), { ownLive: 5 }, limits({ active: 5 }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'concurrency');
});

test('the provider concurrency limit still bounds every sandbox on the account', async () => {
  const refused = await admit(ledger(5), { ownLive: 0 }, limits({ active: 100, maxActive: 100 }));
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'concurrency');
});

test('a create admission hands the ledger the boxes this router owns', async () => {
  const storage = new Storage();
  const own = [
    { machineId: 'bx_23456789', state: 'idle', createdAt: now - 60_000 },
    { machineId: 'bx_2345678a', state: 'busy', createdAt: now - 60_000 },
  ];
  for (const box of own) await storage.put(`box:${box.machineId}`, box);
  // An adopted orphan belongs to another API key, and a deleted box is gone:
  // neither is this router's live spend.
  await storage.put('box:bx_2345678b', { machineId: 'bx_2345678b', state: 'idle', orphan: true });
  await storage.put('box:bx_2345678c', { machineId: 'bx_2345678c', state: 'deleted' });
  const pool = JSON.stringify(['example-owner/project-a', 'peek-router']);
  await storage.put('create:reachable-key', { createKey: 'reachable-key', state: 'pending', pool, size: 'default', queuedAt: now, at: now });
  let seen;
  const budget = {
    claim: async () => null,
    admit: async (key, _limits, options) => { seen = options; return { ok: false, reason: 'denied' }; },
  };
  const fleet = new BoxFleet(storage, {}, () => now, { project: { id: 'demo', repo: 'example-owner/project-a' }, projectCount: 1, budget });
  assert.equal(await fleet.admit('reachable-key', limits({ active: 11 }), 3600), false);
  assert.equal(seen.ownLive, own.length);
});
