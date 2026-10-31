import test from 'node:test';
import assert from 'node:assert/strict';
import { Router } from '../src/router/core.mjs';
import { Storage } from './helpers.mjs';
const suite = id => ({ id, repo: `owner/${id}`, account: 'example-account', reuse: { mode: 'off' }, labels: [], jobs: {}, landing: { engine: 'runner' } });
test('project tick failures do not stop other tenants', async () => {
  const storage = new Storage();
  const router = new Router(storage, { id: 'example-account', starts: {} }, [
    { config: suite('project-a'), hooks: {}, tick: async ({ storage }) => { await storage.put('tick', 'first'); throw Error('TOKEN=private'); } },
    { config: suite('project-b'), hooks: {}, tick: async ({ storage }) => { await storage.put('tick', 'second'); } },
  ]);
  const result = await router.tick();
  assert.equal(result[0].ok, false); assert.equal(result[1].ok, true);
  assert.equal(result[0].error.includes('private'), false);
  const fault = await storage.get('project:project-a:router:last-fault');
  assert.equal(fault.stage, 'tick'); assert.equal(fault.errorClass, 'Error'); assert.equal(fault.message, '[redacted]');
  assert.equal(Number.isFinite(fault.at), true);
  assert.equal(await storage.get('project:project-a:tick'), 'first');
  assert.equal(await storage.get('project:project-b:tick'), 'second');
});

test('a preparation failure blocks new starts but still runs tenant cleanup', async () => {
  const storage = new Storage();
  const router = new Router(storage, { id: 'example-account', starts: {} }, [
    { config: suite('project-a'), hooks: {}, prepare: () => { throw new TypeError('secret'); },
      tick: async ctx => { assert.equal(ctx.startPreparationFailed, true); await ctx.storage.put('cleanup', true); } },
    { config: suite('project-b'), hooks: {}, tick: async ctx => { assert.equal(ctx.startPreparationFailed, true); await ctx.storage.put('tick', true); } },
  ]);
  const result = await router.tick();
  assert.equal(result[0].ok, false); assert.equal(result[1].ok, true);
  assert.deepEqual(await storage.get('project:project-a:router:last-fault'), { at: (await storage.get('project:project-a:router:last-fault')).at, stage: 'prepare', errorClass: 'TypeError', message: '[redacted]' });
  assert.equal(await storage.get('project:project-a:cleanup'), true);
  assert.equal(await storage.get('project:project-b:tick'), true);
});

test('dispatch selects the repository and label before using tenant storage', async () => {
  const storage = new Storage(), received = [];
  const configure = (id, label) => ({ ...suite(id), labels: [label], sizes: { [label]: { machine: 'large' } }, triggers: [{ on: 'workflow_job', executor: 'actions-jit' }] });
  const router = new Router(storage, { id: 'example-account', starts: {} }, ['project-a', 'project-b'].map(id => ({ config: configure(id, 'boat-large'), hooks: {}, tick: async () => {}, ingest: async (event, ctx) => { received.push([ctx.config.id, event.id]); await ctx.storage.put(`job:${event.id}`, event); } })));
  const payload = { repository: { full_name: 'owner/project-a' }, installation: { id: 7 }, action: 'queued', workflow_job: { id: 101, labels: ['boat-large'] } };
  assert.equal(await router.dispatch('workflow_job', payload), true);
  assert.deepEqual(received, [['project-a', 101]]);
  assert.equal((await storage.get('project:project-a:job:101')).size, 'large');
  assert.equal(await storage.get('project:project-b:job:101'), undefined);
  assert.equal(await router.dispatch('workflow_job', { ...payload, repository: { full_name: 'owner/foreign' } }), false);
  await assert.rejects(router.ingest({ project: 'project-a', event: { repo: 'owner/project-b', installation: 7 } }), /invalid selection/);
  assert.equal(await router.dispatch('workflow_job', { ...payload, workflow_job: { ...payload.workflow_job, labels: ['boat-large', 'other'] } }), false);
});

test('JIT workflow events preserve validated run and head identity', async () => {
  const { selectWorkflowJob } = await import('../src/router/select.mjs');
  const config = { ...suite('project-b'), labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, triggers: [{ on: 'workflow_job', executor: 'actions-jit' }] };
  const payload = { repository: { full_name: config.repo }, installation: { id: 7 }, action: 'queued', workflow_job: {
    id: 101, labels: ['boat-large'], run_id: 501, run_attempt: 2, head_branch: 'feature', head_sha: 'a'.repeat(40), name: 'browser' } };
  const event = selectWorkflowJob('workflow_job', payload, config);
  assert.deepEqual({ runId: event.runId, runAttempt: event.runAttempt, branch: event.branch, headSha: event.headSha, jobName: event.jobName },
    { runId: 501, runAttempt: 2, branch: 'feature', headSha: 'a'.repeat(40), jobName: 'browser' });
  payload.workflow_job.head_sha = 'not-a-sha';
  assert.equal(selectWorkflowJob('workflow_job', payload, config).headSha, undefined);
});

test('duplicate repositories cannot be registered as two tenants', () => {
  const a = suite('project-a'), b = { ...suite('project-b'), repo: a.repo };
  assert.throws(() => new Router(new Storage(), { id: 'example-account' }, [{ config: a }, { config: b }]), /duplicate repository/);
});

test('JIT size labels override the project mapping and reject unknown or conflicting sizes', async () => {
  const { selectWorkflowJob } = await import('../src/router/select.mjs');
  const config = { ...suite('project-a'), labels: ['boat-large'], sizes: { 'boat-large': { machine: 'large' } }, triggers: [{ on: 'workflow_job', executor: 'actions-jit' }] };
  const payload = { repository: { full_name: config.repo }, installation: { id: 7 }, action: 'queued', workflow_job: { id: 1, labels: ['boat-large'] } };
  assert.equal(selectWorkflowJob('workflow_job', payload, config).size, 'large');
  payload.workflow_job.labels = ['boat-size-small'];
  const selected = selectWorkflowJob('workflow_job', payload, config);
  assert.equal(selected.size, 'small');
  assert.deepEqual(selected.labels, ['boat-size-small']);
  payload.workflow_job.labels[0] = 'boat-size-huge';
  assert.throws(() => selectWorkflowJob('workflow_job', payload, config), /Unknown Boat size/);
  payload.workflow_job.labels = ['boat-large', 'boat-size-small', 'boat-size-default'];
  assert.throws(() => selectWorkflowJob('workflow_job', payload, config), /one Boat runner label/);
});
