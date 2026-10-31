import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, poolKey, poolSize, supplyCounts } from '../src/router/pool.mjs';

test('pool planner counts aged demand and independent supply', () => {
  const key = poolKey('owner/repo', 'boat-large');
  const pools = [{ key, localFirst: true, offerSeconds: 30 }];
  const jobs = [{ id: 1, pool: key, status: 'queued', queuedAt: 0 }, { id: 2, pool: key, status: 'queued', queuedAt: 80_000 }];
  const units = [{ pool: key, state: 'booting', since: 0 }];
  const result = plan({ pools, jobs, units, now: 100_000 })[key];
  assert.deepEqual([result.D, result.Dboat, result.S, result.create, result.localOffer, result.oldestUncoveredAt], [2, 1, 1, 0, true, 80_000]);
  assert.equal(plan({ pools, jobs, units, now: 300_000 })[key].create, 2);
  assert.equal(plan({ pools: [{ ...pools[0], reason: 'breaker' }], jobs, units, now: 300_000 })[key].create, 0);
  assert.equal(poolSize({ sizes: { label: { machine: 'large' } } }, 'label'), 'large');
  assert.equal(poolSize({ sizeLabelPrefix: 'worker-' }, 'worker-large'), 'large');
  assert.throws(() => poolSize({}, 'worker-large'), /Unknown Boat size/);
});

test('supply deadlines and unsafe states', () => {
  const units = [
    { state: 'booting', since: 0 }, { state: 'resetting', since: 0 },
    { state: 'idle', since: 0, online: true }, { state: 'busy' },
    { kind: 'local', state: 'retiring', at: 0 },
    { kind: 'foreign', online: true, busy: false, snapshotComplete: true },
    { kind: 'foreign', online: true, busy: false, snapshotComplete: false },
  ];
  assert.deepEqual(supplyCounts(units, 120_000), { booting: 1, idle: 1, foreign: 1 });
  assert.deepEqual(supplyCounts(units, 300_000), { idle: 1, foreign: 1 });
});
