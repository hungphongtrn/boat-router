import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { APIs } from '../src/apis.mjs';
import { Fleet } from '../src/fleet.mjs';
import { installRouter } from '../src/router/install.mjs';
import { Storage } from './helpers.mjs';
import { snapshotLimits } from '../src/router/ledger.mjs';

const repo = 'hungphongtrn/peek';
const env = { BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'provider', ROUTER_PROJECTS: 'peek', ENABLED: 'false', GITHUB_POLL_REPO: repo, GITHUB_POLL_TOKEN: 'test-poll-token', GITHUB_POLL_PAID_CAP_USD: '1.50' };

test('local slot budget preserves FIFO and starts immediately after a slot frees despite spent hourly floor', async () => {
  const now = () => 100_000_000, storage = new Storage();
  const localEnv = { ...env, GITHUB_POLL_MAX_LIVE: '1' };
  const router = installRouter(storage, () => localEnv, { api: new APIs(localEnv), now, logger: () => {} });
  assert.equal(router.account.poolPacing.unpaced, false);
  assert.equal(router.account.poolPacing.slotBudget, true);
  assert.equal(router.account.liveSandboxCap, 1);
  assert.equal(router.projects.get('peek').config.caps.concurrent, 1);
  assert.equal(router.projects.get('peek').config.reuse.idleHoldSeconds, undefined);
  assert.equal(router.account.reuse.idleHoldSeconds, 3600);
  assert.equal(router.projects.get('peek').config.reuse.idleHoldSecondsWhenStartsPaid, 3600);
  await storage.put(router.ledger.key, { claims: {}, waiting: [], dynamicPacing: { at: now(), credit: 0, ratePerMs: 0, floorStarts: [{ key: 'spent1', at: now() }, { key: 'spent2', at: now() }], floorOverflow: [] } });
  const limits = active => snapshotLimits({ canStart: true, activeSandboxes: active, maxActiveSandboxes: 100, nextStartDollars: 0, starts: { minute: { limit: 12, used: 0 }, hour: { limit: 60, used: 9 }, day: { limit: 200, used: 138 } } }, now());
  await router.ledger.enqueue('peek', 'first', now()-2000);
  await router.ledger.enqueue('peek', 'second', now()-1000);
  assert.equal((await router.ledger.admit('peek', 'first', limits(1), { pool: true })).reason, 'concurrency');
  assert.equal((await router.ledger.admit('peek', 'second', limits(0), { pool: true })).reason, 'fairness');
  assert.equal((await router.ledger.admit('peek', 'first', limits(0), { pool: true })).ok, true);
  assert.equal((await router.ledger.admit('peek', 'second', limits(0), { pool: true })).reason, 'concurrency', 'in-flight starts hold the slot');
  await router.ledger.cancelPending('peek', 'first');
  assert.equal((await router.ledger.admit('peek', 'second', limits(0), { pool: true })).ok, true);
  const state = await storage.get(router.ledger.key);
  assert.equal(state.pacingStatus.admissionMode, 'slot_budget');
  state.paidExtraSpend = [{ at: now(), dollars: 1.5 }];
  await storage.put(router.ledger.key, state);
  await router.ledger.cancelPending('peek', 'second');
  await router.ledger.enqueue('peek', 'paid');
  const paid = limits(0); paid.nextStartDollars = 0.03;
  assert.equal((await router.ledger.admit('peek', 'paid', paid, { pool: true })).reason, 'paid_extra_budget');
  for (const value of ['0', '-1', '1.5', '101', 'NaN']) assert.throws(() => installRouter(new Storage(), () => ({ ...env, GITHUB_POLL_MAX_LIVE: value }), { api: new APIs(env), now }), /invalid poll live budget/);
  assert.throws(() => installRouter(new Storage(), () => ({ ...localEnv, GITHUB_POLL_UNPACED: 'true' }), { api: new APIs(env), now }), /invalid poll live budget/);
});

test('pool autoscaling validates its live floor and engages on the floor alone', () => {
  const now = () => 100_000_000;
  for (const value of ['0', '1.5', 'NaN']) assert.throws(() => installRouter(new Storage(), () => ({ ...env, GITHUB_POLL_MIN_LIVE: value }), { api: new APIs(env), now }), /invalid poll live floor/);
  assert.throws(() => installRouter(new Storage(), () => ({ ...env, GITHUB_POLL_MIN_LIVE: '6', GITHUB_POLL_MAX_LIVE: '5' }), { api: new APIs(env), now }), /invalid poll live floor/);
  assert.throws(() => installRouter(new Storage(), () => ({ BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'provider', ROUTER_PROJECTS: 'peek', ENABLED: 'false', GITHUB_POLL_MIN_LIVE: '2' }), { api: new APIs(env), now }), /invalid poll live floor/);
  const router = installRouter(new Storage(), () => ({ ...env, GITHUB_POLL_MIN_LIVE: '2' }), { api: new APIs(env), now, logger: () => {} });
  assert.equal(router.account.liveSandboxCap, 5);
  assert.equal(router.projects.get('peek').config.caps.concurrent, 5);
  assert.equal(router.account.poolPacing.slotBudget, true);
  assert.equal(router.account.poolPacing.unpaced, false);
});

test('local unpaced admission drains a spent pacing floor but preserves FIFO, provider limits and paid budget', async () => {
  const now = () => 100_000_000;
  const storage = new Storage();
  const localEnv = { ...env, GITHUB_POLL_UNPACED: 'true' };
  const router = installRouter(storage, () => localEnv, { api: new APIs(localEnv), now, logger: () => {} });
  assert.equal(router.account.poolPacing.unpaced, true);
  assert.equal(router.account.starts.paidExtraMaxDollarsPerMonth, 1.5);
  const ledger = router.ledger;
  await storage.put(ledger.key, { claims: {}, waiting: [], dynamicPacing: { at: now(), credit: 0.13, ratePerMs: 4 / 3_600_000, floorStarts: [{ key: 'used1', at: now() }, { key: 'used2', at: now() }], floorOverflow: [] } });
  await ledger.enqueue('peek', 'oldest', now() - 2000);
  await ledger.enqueue('peek', 'next', now() - 1000);
  const limits = (changes = {}) => snapshotLimits({ canStart: true, activeSandboxes: 15, maxActiveSandboxes: 100, nextStartDollars: 0, starts: { minute: { limit: 12, used: 0 }, hour: { limit: 60, used: 9 }, day: { limit: 200, used: 138 } }, ...changes }, now());
  assert.equal((await ledger.admit('peek', 'next', limits(), { pool: true })).reason, 'fairness');
  assert.equal((await ledger.admit('peek', 'oldest', limits(), { pool: true })).ok, true);
  assert.equal((await ledger.admit('peek', 'next', limits(), { pool: true })).ok, true);
  await ledger.enqueue('peek', 'blocked');
  assert.equal((await ledger.admit('peek', 'blocked', limits({ activeSandboxes: 100 }), { pool: true })).reason, 'concurrency');
  const full = { minute: { limit: 12, used: 12 }, hour: { limit: 60, used: 9 }, day: { limit: 200, used: 138 } };
  assert.equal((await ledger.admit('peek', 'blocked', limits({ starts: full }), { pool: true })).reason, 'minute_cap');
  const state = await storage.get(ledger.key);
  state.paidExtraSpend = [{ at: now(), dollars: 1.5 }];
  await storage.put(ledger.key, state);
  assert.equal((await ledger.admit('peek', 'blocked', limits({ nextStartDollars: 0.03 }), { pool: true })).reason, 'paid_extra_budget');
  assert.equal(installRouter(new Storage(), () => env, { api: new APIs(env), now, logger: () => {} }).account.poolPacing.unpaced, false);
  assert.throws(() => installRouter(new Storage(), () => ({ ...env, GITHUB_POLL_UNPACED: 'yes' }), { api: new APIs(env), now }), /invalid poll unpaced/);
});

test('a signed repo hook acknowledges before admission and starts one Boat box even when a poll sees the same job', { timeout: 5000 }, async t => {
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
  const project = fleet.router.projects.get('peek');
  const ingest = project.ingest;
  let ingested = false;
  project.ingest = (...args) => { ingested = true; return ingest(...args); };
  const received = performance.now();
  assert.equal((await post('workflow_job', payload)).status, 202);
  assert.ok(performance.now() - received < 1000);
  assert.equal(ingested, false, 'ack does not wait for router ingestion');
  assert.equal(starts, 0);
  assert.ok(await storage.getAlarm() <= now + 1000, 'ack leaves a durable wakeup');
  const tick = fleet.alarm();
  await Promise.race([polling, tick.then(() => assert.fail('no GitHub scan'))]);
  try { assert.ok(await storage.get('project:peek:gh-job:52')); }
  finally { resume(); }
  await tick;
  assert.equal(starts, 1, 'the webhook alarm starts without waiting for the minute sweep');
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
