import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../src/worker.mjs';
import { webhook } from '../src/webhook.mjs';
function handle(request, env) { return webhook(request, env, env.GITHUB_WEBHOOK_SECRET, event => env.FLEET.get().fetch('https://fleet/event', { body: JSON.stringify(event) })); }

const secret = 'fake-test-webhook-secret';
function request(payload, options = {}) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  const digest = createHmac('sha256', secret).update(body).digest('hex');
  return new Request('https://launcher.test/webhook', { method: 'POST', body, headers: {
    'X-Hub-Signature-256': `sha256=${digest}`, 'X-GitHub-Event': 'workflow_job', ...options,
  } });
}
function environment() {
  const events = [];
  return { events, env: { GITHUB_WEBHOOK_SECRET: secret, FLEET: { idFromName: x => x, get: () => ({
    fetch: async (url, options) => { events.push({ url: typeof url === 'string' ? url : url.url, payload: options?.body ? JSON.parse(options.body) : null }); return new Response(null, { status: 202 }); },
  }) } } };
}
const payload = { action: 'queued', repository: { full_name: 'example-owner/project-b' }, installation: { id: 1 }, workflow_job: { id: 101, labels: ['boat-default'] } };
test('signed webhook persists a minimal event and acknowledges it', async () => {
  const f = environment(); assert.equal((await handle(request(payload), f.env)).status, 202);
  assert.deepEqual(f.events[0].payload, { id: 101, repo: 'example-owner/project-b', installation: 1, label: 'boat-default', size: 'default', status: 'queued', runnerName: null });
});
test('tampered, unsigned, malformed, and oversized requests create no jobs', async () => {
  const f = environment();
  assert.equal((await handle(request(payload, { 'X-Hub-Signature-256': 'sha256=' + '0'.repeat(64) }), f.env)).status, 401);
  assert.equal((await handle(new Request('https://launcher.test/webhook', { method: 'POST', body: '{}' }), f.env)).status, 401);
  assert.equal((await handle(request('{'), f.env)).status, 400);
  assert.equal((await handle(request('x'.repeat(1_048_577)), f.env)).status, 413);
  assert.deepEqual(f.events, []);
  assert.equal((await handle(request(payload), f.env)).status, 202);
});
test('signed unrelated repositories and composite labels are ignored', async () => {
  const f = environment();
  assert.equal((await handle(request({ ...payload, repository: { full_name: 'example-owner/unknown' } }), f.env)).status, 204);
  assert.equal((await handle(request({ ...payload, workflow_job: { id: 101, labels: ['boat-default', 'self-hosted'] } }), f.env)).status, 204);
  assert.deepEqual(f.events, []);
  assert.equal((await handle(request(payload), f.env)).status, 202);
});
test('signed Mini 3 jobs never enter the fleet for any supported label or event', async () => {
  const f = environment();
  for (const repo of ['example-org/project-d', 'example-org/project-d-bridge']) {
    for (const label of ['boat-default', 'boat-large', 'boat-xlarge']) {
      for (const action of ['queued', 'in_progress', 'completed']) {
        const body = { ...payload, action, repository: { full_name: repo }, workflow_job: { id: 101, labels: [label] } };
        assert.equal((await handle(request(body), { ...f.env, ALLOW_SMOKE: 'true' })).status, 204);
      }
    }
  }
  assert.deepEqual(f.events, []);
});
test('GitHub ping is verified and cron wakes the durable sweeper', async () => {
  const f = environment();
  assert.equal((await handle(request({}, { 'X-GitHub-Event': 'ping' }), f.env)).status, 204);
  const pending = [];
  await worker.scheduled({}, f.env, { waitUntil: p => pending.push(p) }); await Promise.all(pending);
  assert.equal(f.events[0].url, 'https://fleet/sweep');
});
