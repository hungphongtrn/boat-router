import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { prunePool } from '../src/router/pool-prune.mjs';

test('pruning keeps live and recent records and removes old terminal records with aliases', async () => {
  const storage = new Storage(), now = 10 * 86400_000, old = now - 8 * 86400_000;
  for (const [key, value] of Object.entries({
    'box:old': { machineId: 'old', state: 'deleted', since: old },
    'box:live': { machineId: 'live', state: 'busy', since: old },
    'runner:old': { machineId: 'old' }, 'runner:live': { machineId: 'live' },
    'pool:drain-only:old': { at: old }, 'pool:drain-only:live': { at: old },
    'gh-job:old': { status: 'completed', observedAt: old },
    'gh-job:live': { status: 'in_progress', observedAt: old },
    'gh-job:recent': { status: 'completed', observedAt: now },
    'legacy:old': { at: old }, 'verification:attempt:old': { at: old },
  })) await storage.put(key, value);
  await prunePool(storage, now);
  for (const key of ['box:old', 'runner:old', 'pool:drain-only:old', 'gh-job:old', 'legacy:old', 'verification:attempt:old']) assert.equal(await storage.get(key), undefined, key);
  for (const key of ['box:live', 'runner:live', 'pool:drain-only:live', 'gh-job:live', 'gh-job:recent']) assert.ok(await storage.get(key), key);
});
