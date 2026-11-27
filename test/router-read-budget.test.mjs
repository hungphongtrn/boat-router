import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fleet } from '../src/fleet.mjs';
import { records } from '../src/router/pool-records.mjs';
import { observe } from '../src/router/pool-observations.mjs';
import { ReadCache } from '../src/router/read-cache.mjs';
import { TenantStorage } from '../src/router/tenant-storage.mjs';
import { Storage } from './helpers.mjs';

class CountedStorage extends Storage {
  rows = 0;
  async list(options) {
    const page = await super.list(options);
    this.rows += page.size;
    return page;
  }
}

test('repeated planner and reconcile reads do not reread retained job history after webhooks', async () => {
  const storage = new CountedStorage();
  const fleet = new Fleet({ storage }, { PLUGIN_ROUTER: 'true', ROUTER_PROJECTS: 'peek', BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'sandbox_0123456789abcdef0123456789abcdef' });
  const prefix = 'project:peek:gh-job:';
  for (let id = 1; id <= 1000; id++) await storage.put(prefix + id, { id, status: 'completed' });
  const project = new TenantStorage(fleet.storage, 'peek');
  for (let tick = 0; tick < 10; tick++) {
    for (let pass = 0; pass < 3; pass++) assert.equal((await records(project, 'gh-job:')).length, 1000 + tick);
    await observe(project, { id: 1001 + tick, status: 'queued', repo: 'hungphongtrn/peek', label: 'peek-router' }, tick);
  }
  assert.equal((await records(project, 'gh-job:')).find(job => job.id === 1010)?.status, 'queued');
  assert.ok(storage.rows <= 1000, `read ${storage.rows} history rows for a 1000-row cold load`);
});

test('range cache clones results and tracks commit, deletion and rollback', async () => {
  class TransactionStorage extends CountedStorage {
    async transaction(fn) {
      const before = structuredClone(this.data);
      try { return await fn(this); }
      catch (error) { this.data = before; throw error; }
    }
  }
  const raw = new TransactionStorage();
  const storage = new TenantStorage(new ReadCache().wrap(raw), 'peek');
  await storage.put('box:2', { state: 'ready' });
  (await records(storage, 'box:'))[0].state = 'deleted';
  assert.deepEqual(await records(storage, 'box:'), [{ state: 'ready' }]);
  await storage.transaction(tx => tx.put('box:1', { state: 'booting' }));
  assert.deepEqual(await records(storage, 'box:'), [{ state: 'booting' }, { state: 'ready' }]);
  await storage.delete('box:1');
  assert.deepEqual(await records(storage, 'box:'), [{ state: 'ready' }]);
  assert.equal(raw.rows, 1);
  await assert.rejects(storage.transaction(async tx => {
    await tx.put('box:2', { state: 'deleted' });
    assert.deepEqual(await records(tx, 'box:'), [{ state: 'deleted' }]);
    throw new Error('roll back');
  }), /roll back/);
  assert.deepEqual(await records(storage, 'box:'), [{ state: 'ready' }]);
});

test('a write racing a cold scan cannot publish the stale scan', async () => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  class OverlapStorage extends CountedStorage {
    async list(options) {
      const snapshot = await super.list(options);
      await held;
      return snapshot;
    }
  }
  const storage = new TenantStorage(new ReadCache().wrap(new OverlapStorage()), 'peek');
  await storage.put('box:1', { state: 'ready' });
  const cold = records(storage, 'box:');
  await storage.put('box:1', { state: 'deleted' });
  release();
  assert.deepEqual(await cold, [{ state: 'ready' }]);
  assert.deepEqual(await records(storage, 'box:'), [{ state: 'deleted' }]);
});
