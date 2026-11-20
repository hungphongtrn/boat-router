import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { APIs } from '../src/apis.mjs';
import { Fleet } from '../src/fleet.mjs';
import { installRouter } from '../src/router/install.mjs';
import { Storage } from './helpers.mjs';

const repo = 'hungphongtrn/peek';
const env = { BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'provider', ROUTER_PROJECTS: 'peek', ENABLED: 'false', GITHUB_POLL_REPO: repo, GITHUB_POLL_TOKEN: 'test-poll-token', GITHUB_POLL_PAID_CAP_USD: '1.50' };

test('a signed repo hook and an overlapping poll start only one Boat box for the same job', async t => {
  const secret = 'test-repo-secret';
  const job = { id: 52, run_id: 912, status: 'queued', labels: ['peek-router'], name: 'ci' };
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let entered, resume;
  const polling = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { resume = resolve; });
  let starts = 0, scans = 0, runLookups = 0;
  t.mock.method(globalThis, 'fetch', async (url, { method = 'GET', headers } = {}) => {
    const u = new URL(url), path = u.pathname;
    if (u.hostname === 'boat.dev') {
      if (path.endsWith('/limits')) {
        const window = { limit: 20, used: 0, remaining: 20 };
        return Response.json({ canStart: true, nextStartDollars: 0, activeSandboxes: 0, maxActiveSandboxes: 20, startLimits: { perMinute: 20, perHour: 20, perDay: 20 }, starts: { minute: window, hour: window, day: window }, machineTypes: [{ type: 'default', available: true }] });
      }
      if (path.endsWith('/sandboxes') && method === 'POST') {
        starts++;
        return Response.json({ sandbox: { id: 'bx_23456789' } }, { status: 202 });
      }
      return Response.json({ sandbox: { state: 'running', setupStatus: 'pending' } });
    }
    assert.equal(headers.Authorization, 'Bearer test-poll-token');
    if (path.endsWith('/runners')) return Response.json({ total_count: 0, runners: [] });
    if (path.endsWith(`/runs/${job.run_id}`)) {
      runLookups++;
      return Response.json({ display_title: 'CI', path: '.github/workflows/ci.yml' });
    }
    if (path.endsWith('/jobs')) {
      scans++;
      entered();
      await paused;
      return Response.json({ total_count: 1, jobs: [job] });
    }
    const runs = u.searchParams.get('status') === 'queued' ? [{ id: job.run_id }] : [];
    return Response.json({ total_count: runs.length, workflow_runs: runs });
  });
  const storage = new Storage();
  const fleet = new Fleet({ storage, waitUntil() {} }, { ...env, PLUGIN_ROUTER: 'true', ENABLED: 'true', GITHUB_WEBHOOK_SECRET: secret });
  await storage.put('project:peek:pool:mode', 'on');
  const post = (name, payload, key = secret) => {
    const body = JSON.stringify(payload);
    return fleet.fetch(new Request('http://fleet/webhook', { method: 'POST', body, headers: { 'X-Boat-CI-Enabled': 'true', 'X-GitHub-Event': name, 'X-Hub-Signature-256': `sha256=${createHmac('sha256', key).update(body).digest('hex')}` } }));
  };
  const payload = { repository: { full_name: repo }, workflow_job: job, action: 'queued' };
  assert.equal((await post('ping', {})).status, 204);
  assert.equal((await post('workflow_job', payload, 'wrong-key')).status, 401);
  assert.equal((await post('workflow_job', { ...payload, repository: { full_name: 'other/repo' } })).status, 204);
  const tick = fleet.alarm();
  await Promise.race([polling, tick.then(() => assert.fail('no GitHub scan'))]);
  try { assert.equal((await post('workflow_job', payload)).status, 202); }
  finally { resume(); }
  await tick;
  assert.equal((await post('workflow_job', payload)).status, 202);
  now += 60_000;
  await fleet.alarm();
  assert.equal(starts, 1);
  assert.equal(scans, 1);
  assert.equal(runLookups, 0, 'a non-matrix job does not need a workflow path lookup');
});

test('pool reconciles with a user token without App credentials or a webhook installation', async () => {
  const api = new APIs(env, async (url, { headers }) => {
    const path = new URL(url).pathname;
    if (new URL(url).hostname === 'boat.dev') return Response.json({});
    assert.equal(headers.Authorization, 'Bearer test-poll-token');
    assert.ok(path.startsWith(`/repos/${repo}/actions/`));
    if (path.endsWith('/runners')) return Response.json({ total_count: 0, runners: [] });
    if (path.endsWith('/jobs')) return Response.json({ total_count: 1, jobs: [{ id: 52, status: 'queued', labels: ['peek-router'] }] });
    const runs = url.includes('status=queued') ? [{ id: 912 }] : [];
    return Response.json({ total_count: runs.length, workflow_runs: runs });
  });
  const router = installRouter(new Storage(), () => env, { api, logger: () => {} });
  const { storage } = router.projects.get('peek');
  await storage.put('pool:mode', 'on');
  await router.tick();
  assert.equal((await storage.get('pool:snapshot')).complete, true);
  assert.equal((await storage.get('gh-job:52')).status, 'queued');
  assert.equal(await storage.get('pool:installation'), undefined);
  assert.equal(router.account.starts.paidExtraMaxDollarsPerMonth, 1.5);
});

test('JIT uses the same token; it cannot be used for reruns or a different repo', async () => {
  const calls = [];
  const api = new APIs(env, async (url, options) => {
    calls.push([url, options]);
    if (url.includes('generate-jitconfig')) return Response.json({ runner: { id: 31 }, encoded_jit_config: 'jit-only' });
    return Response.json({ runners: [] });
  });
  const job = { repo, installation: 1, id: 52, generation: 1, label: 'peek-router', machineId: 'test-box' };
  await api.configure(job, async id => assert.equal(id, 31));
  assert.equal(calls.length, 3);
  assert.equal(calls[1][1].headers.Authorization, 'Bearer test-poll-token');
  assert.equal(calls[1][1].method, 'POST');
  assert.ok(calls[2][0].startsWith('https://boat.dev/'));
  assert.equal(calls[2][1].headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[2][1].body).content, 'jit-only');
  await assert.rejects(api.rerunJob(job, 52), { code: 'poll_auth_denied' });
  await assert.rejects(api.getJob({ ...job, repo: 'other/repo' }), { code: 'poll_auth_denied' });
  assert.equal(calls.length, 3);
});
