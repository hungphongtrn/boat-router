import test from 'node:test';
import assert from 'node:assert/strict';
import { APIs } from '../src/apis.mjs';
import { installRouter } from '../src/router/install.mjs';
import { Storage } from './helpers.mjs';

const repo = 'hungphongtrn/peek';
const env = { BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'provider', ROUTER_PROJECTS: 'peek', ENABLED: 'false', GITHUB_POLL_REPO: repo, GITHUB_POLL_TOKEN: 'test-poll-token', GITHUB_POLL_PAID_CAP_USD: '1.50' };

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
