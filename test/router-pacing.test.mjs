import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';

function setup(pacing) {
  let time = 1_000_000;
  const ledger = new AccountLedger(new Storage(), { poolPacing: pacing }, () => time);
  const snapshot = (used = 0) => ({ at: time, canStart: true, windows: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 100, used }])) });
  return { ledger, snapshot, advance: ms => { time += ms; } };
}

test('pool pacing is off by default', async () => {
  const { ledger, snapshot } = setup(undefined);
  for (const key of ['a', 'b']) {
    await ledger.enqueue('ci', key);
    assert.equal((await ledger.admit('ci', key, snapshot(), { pool: true })).ok, true);
  }
});

test('pool pacing shares burst and refills while preserving the reserve', async () => {
  const { ledger, snapshot, advance } = setup({ enabled: true, marginPct: 10, burst: 1, reserveStarts: 5, fromPct: 0 });
  await ledger.enqueue('ci', 'a');
  assert.equal((await ledger.admit('ci', 'a', snapshot(), { pool: true })).ok, true);
  await ledger.enqueue('ci', 'b');
  assert.equal((await ledger.admit('ci', 'b', snapshot(), { pool: true })).reason, 'pacing');
  advance(960_000);
  assert.equal((await ledger.admit('ci', 'b', snapshot(95), { pool: true })).reason, 'pacing_reserve');
  assert.equal((await ledger.admit('ci', 'b', snapshot(), { pool: true })).ok, true);
});

test('pacing starts at 70 percent of either account window', async () => {
  for (const window of ['day', 'hour']) {
    const { ledger, snapshot } = setup({ enabled: true, burst: 1 });
    const snap = used => { const value = snapshot(); value.windows[window].used = used; return value; };
    for (const key of ['a', 'b']) {
      await ledger.enqueue('ci', key);
      assert.equal((await ledger.admit('ci', key, snap(69), { pool: true })).ok, true);
    }
    await ledger.enqueue('ci', 'c');
    assert.equal((await ledger.admit('ci', 'c', snap(70), { pool: true })).ok, true);
    await ledger.enqueue('ci', 'd');
    assert.equal((await ledger.admit('ci', 'd', snap(70), { pool: true })).reason, 'pacing');
  }
});

test('available reusable supply replaces a pending fresh start', async () => {
  const { plan } = await import('../src/router/pool.mjs');
  const pool = { key: 'p' }, jobs = [{ pool: 'p', status: 'queued', queuedAt: 1, id: 1 }];
  const decision = plan({ pools: [pool], jobs, units: [{ pool: 'p', state: 'ready' }], now: 1000 }).p;
  assert.equal(decision.create, 0);
  assert.equal(decision.supply.ready, 1);
});
