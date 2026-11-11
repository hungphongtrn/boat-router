import test from 'node:test';
import assert from 'node:assert/strict';
import { plan, poolKey } from '../src/router/pool.mjs';

test('only concrete mini claims cover demand and expire after 30 seconds', () => {
  const key = poolKey('o/r', 'boat-default');
  const pools = [{ key, localFirst: true, offerSeconds: 90 }];
  const jobs = Array.from({ length: 10 }, (_, id) => ({ id, pool: key, status: 'queued', queuedAt: 1000 }));
  const decide = (units, now) => plan({ pools, jobs, units, now })[key];
  assert.equal(decide([], 1000).create, 10, 'idle CPU or a young queue does not block Boat');
  const claim = { kind: 'local', host: 'mini-a', pool: key, state: 'claiming', at: 1000 };
  assert.equal(decide([{ ...claim, host: null }], 1000).create, 10, 'a claim without a selected host cannot hold demand');
  assert.equal(decide([claim], 1000).create, 9, 'one claim covers only one job');
  assert.equal(decide([{ ...claim, state: 'started', startedAt: 2000, online: true }], 30_999).create, 9);
  assert.equal(decide([{ ...claim, state: 'started', startedAt: 2000, online: true }], 31_000).create, 10, 'a job not taken within 30 seconds can overflow');
  const warm = { pool: key, state: 'idle', online: true };
  assert.equal(decide([claim, warm], 1000).create, 8, 'warm Boat supply is counted alongside one mini claim');
});
