import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { observe, reconcile } from '../src/router/pool-observations.mjs';

const config = { repo: 'owner/repo', labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, triggers: [{ on: 'workflow_job', executor: 'actions-jit' }] };
const event = { id: 1, repo: config.repo, installation: 1, label: 'boat-large', status: 'queued' };

test('verified resync can replace a completed webhook at the same timestamp', async () => {
  const storage = new Storage();
  await observe(storage, { ...event, status: 'completed' }, 10);
  await observe(storage, { ...event, status: 'in_progress', runnerName: 'boat-ci-j1-g1' }, 10, 'resync');
  assert.equal((await storage.get('gh-job:1')).status, 'in_progress');
  assert.equal((await storage.get('gh-job:1')).runnerName, 'boat-ci-j1-g1');
});

test('snapshot preserves a newer webhook while confirming missing queued jobs', async () => {
  const storage = new Storage(); await observe(storage, event, 10);
  const api = {
    snapshotPage: async (_job, path) => {
      if (path.includes('/runners?')) return { status: 200, data: { total_count: 0, runners: [] } };
      return { status: 200, data: { total_count: 0, workflow_runs: [] } };
    },
    getJob: async () => {
      await observe(storage, { ...event, status: 'completed' }, 21);
      return { id: 1, status: 'queued', labels: ['boat-large'] };
    },
  };
  assert.equal(await reconcile(storage, api, config, 1, () => 20), true);
  assert.equal((await storage.get('gh-job:1')).status, 'completed');
  assert.equal((await storage.get('gh-job:1')).missing, false);
});

test('incomplete snapshot preserves queued observations', async () => {
  const storage = new Storage(); await observe(storage, event, 10);
  const api = { snapshotPage: async () => { throw Error('unavailable'); } };
  assert.equal(await reconcile(storage, api, config, 1, () => 20), false);
  assert.equal((await storage.get('gh-job:1')).missing, false);
  assert.equal((await storage.get('pool:snapshot')).complete, false);
});

test('large realistic backlogs reconcile without oversized storage values', async () => {
  for (const count of [92, 300]) {
    const storage = new Storage();
    const runs = Array.from({ length: count }, (_, i) => ({ id: i + 1, status: 'queued', updated_at: '2026-10-31T00:00:00Z', run_attempt: 1, unused: 'x'.repeat(12400) }));
    const api = { snapshotPage: async (_job, path) => {
      const page = Number(new URL('https://example.test' + path).searchParams.get('page'));
      if (path.includes('/runners?')) return { status: 200, data: { total_count: 0, runners: [] } };
      if (path.includes('/jobs?')) return { status: 200, data: { total_count: 1, jobs: [{ id: Number(path.match(/runs\/(\d+)/)[1]), status: 'queued', labels: ['boat-large'], unused: 'x'.repeat(10000) }] } };
      const rows = path.includes('status=queued') ? runs : [];
      return { status: 200, data: { total_count: rows.length, workflow_runs: rows.slice((page - 1) * 100, page * 100) } };
    } };
    let completed = 0;
    for (let tick = 0; tick < 24; tick++) {
      if (await reconcile(storage, api, config, 1, () => tick + 100)) {
        completed++;
        assert.equal((await storage.get('pool:snapshot')).jobs.length, count);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(await storage.get('pool:snapshot'))) < 1_000_000);
      for (const value of (await storage.list({ prefix: 'pool:snapshot-cache:' })).values()) assert.ok(Buffer.byteLength(JSON.stringify(value)) < 1_000_000);
    }
    assert.ok(completed >= 2, `completed scans for ${count} runs`);
  }
});

test('oversized old snapshots are discarded without failing the tick', async () => {
  const storage = new Storage();
  await storage.put('pool:snapshot', { complete: true, pages: { old: 'x'.repeat(2_200_000) } });
  assert.equal(await reconcile(storage, { snapshotPage: async () => { throw Error('unavailable'); } }, config, 1), false);
  assert.ok(Buffer.byteLength(JSON.stringify(await storage.get('pool:snapshot'))) < 1_000_000);
  assert.equal(await storage.get('pool:snapshot-complete'), false);
});
