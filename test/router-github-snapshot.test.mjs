import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshot } from '../src/router/github-snapshot.mjs';

test('snapshot reads all lists and reuses validated cached pages on 304', async () => {
  const requests = [];
  const api = async (_repo, path, etag) => {
    requests.push(path);
    if (etag) return { status: 304 };
    const field = path.includes('/jobs?') ? 'jobs' : path.includes('/runners?') ? 'runners' : 'workflow_runs';
    const rows = field === 'workflow_runs' && path.includes('status=queued') ? [{ id: 1, path: '.github/workflows/full-suite.yml@refs/heads/main' }] : field === 'jobs' ? [{ id: 2 }] : [];
    return { status: 200, etag: 'tag', data: { total_count: rows.length, [field]: rows }, rateRemaining: 4500 };
  };
  const first = await snapshot(api, 'owner/repo');
  assert.equal(first.complete, true);
  assert.deepEqual(first.jobs, [{ id: 2, workflow_path: '.github/workflows/full-suite.yml' }]);
  assert.equal(first.calls, 4);
  const second = await snapshot(api, 'owner/repo', first);
  assert.equal(second.complete, true);
  assert.deepEqual(second.jobs, first.jobs);
});

test('budget exhaustion and inconsistent totals never return a complete snapshot', async () => {
  const api = async () => ({ status: 200, data: { total_count: 101, workflow_runs: [] } });
  assert.equal((await snapshot(api, 'owner/repo')).complete, false);
  assert.equal((await snapshot(api, 'owner/repo', { budget: 0 })).complete, false);
  assert.equal((await snapshot(async () => ({ status: 304 }), 'owner/repo')).complete, false);
});

test('API adapter carries conditional headers and 304 metadata', async () => {
  const { APIs } = await import('../src/apis.mjs');
  let captured;
  const api = new APIs({}, async (_url, options) => {
    captured = options;
    return new Response(null, { status: 304, headers: { etag: '"v1"', 'x-ratelimit-remaining': '4900' } });
  });
  api.tokens.set('1:owner/repo:read', { token: 'fake', expires: Date.now() + 3600000 });
  const result = await api.snapshotPage({ installation: 1, repo: 'owner/repo' }, '/actions/runners', '"v1"');
  assert.equal(captured.headers['If-None-Match'], '"v1"');
  assert.equal(result.status, 304);
  assert.equal(result.etag, '"v1"');
  assert.equal(result.rateRemaining, 4900);
});

test('a backlog of 49 runs completes over two budgeted ticks', async () => {
  const runs = Array.from({ length: 49 }, (_, i) => ({ id: i + 1 }));
  const api = async (_repo, path) => {
    const field = path.includes('/jobs?') ? 'jobs' : path.includes('/runners?') ? 'runners' : 'workflow_runs';
    const rows = field === 'workflow_runs' && path.includes('status=queued') ? runs : field === 'jobs' ? [{ id: Number(path.match(/runs\/(\d+)/)[1]) }] : [];
    return { status: 200, data: { total_count: rows.length, [field]: rows } };
  };
  const first = await snapshot(api, 'owner/repo', { budget: 40 });
  assert.equal(first.complete, false);
  assert.equal(first.calls, 40);
  const second = await snapshot(api, 'owner/repo', { ...first, budget: 40 });
  assert.equal(second.complete, true);
  assert.equal(second.jobs.length, 49);
  assert.ok(second.calls <= 40);
});


test('old cached run pages without paths are refreshed even with an etag', async () => {
  const seen = [];
  const api = async (_repo, path, etag) => {
    seen.push({ path, etag });
    const field = path.includes('/jobs?') ? 'jobs' : path.includes('/runners?') ? 'runners' : 'workflow_runs';
    const rows = field === 'workflow_runs' && path.includes('status=queued') ? [{ id: 1, path: '.github/workflows/full-suite.yml' }] : field === 'jobs' ? [{ id: 2 }] : [];
    return { status: 200, data: { total_count: rows.length, [field]: rows } };
  };
  const key = '/actions/runs?status=queued&per_page=100&page=1';
  const result = await snapshot(api, 'owner/repo', { etags: { [key]: 'old' }, pages: { [key]: { total_count: 1, workflow_runs: [{ id: 1 }] } } });
  assert.equal(seen.find(x => x.path === key).etag, null);
  assert.equal(result.jobs[0].workflow_path, '.github/workflows/full-suite.yml');
});

test('a failed scan records the call and status that broke it', async () => {
  const api = async (_repo, path) => path.includes('/runners?')
    ? { status: 502, data: { message: 'bad gateway' } }
    : { status: 200, data: { total_count: 0, workflow_runs: [] } };
  const result = await snapshot(api, 'owner/repo');
  assert.equal(result.complete, false);
  assert.deepEqual(result.failure, { message: 'snapshot_page', call: '/actions/runners?per_page=100&page=1', status: 502 });
});

test('a transport failure records the adapter status and code', async () => {
  const api = async () => { throw Object.assign(Error('github HTTP 0'), { status: 0, code: 'transport_or_response' }); };
  const result = await snapshot(api, 'owner/repo');
  assert.equal(result.complete, false);
  assert.equal(result.failure.status, 0);
  assert.equal(result.failure.code, 'transport_or_response');
  assert.match(result.failure.call, /^\/actions\/runs\?status=queued/);
});

test('a budget-limited scan reports no failure', async () => {
  const runs = Array.from({ length: 49 }, (_, i) => ({ id: i + 1 }));
  const api = async (_repo, path) => {
    const field = path.includes('/jobs?') ? 'jobs' : path.includes('/runners?') ? 'runners' : 'workflow_runs';
    const rows = field === 'workflow_runs' && path.includes('status=queued') ? runs : field === 'jobs' ? [{ id: Number(path.match(/runs\/(\d+)/)[1]) }] : [];
    return { status: 200, data: { total_count: rows.length, [field]: rows } };
  };
  const first = await snapshot(api, 'owner/repo', { budget: 40 });
  assert.equal(first.complete, false);
  assert.ok(first.partial);
  assert.equal(first.failure.message, 'snapshot_budget');
});
