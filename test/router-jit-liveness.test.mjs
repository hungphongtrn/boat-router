import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { observe, PROBE, REUSE_PROBE } from '../src/router/jit-liveness.mjs';
import { APIs } from '../src/apis.mjs';

test('liveness requires valid signals and distinguishes progress from silence', () => {
  const steps = [{ number: 1, status: 'in_progress' }];
  const start = observe(null, { at: 1, cpu: 10, mtime: 1 }, steps, 0).state;
  assert.equal(observe(start, { at: 2, cpu: 11, mtime: 1 }, steps, 1200000).decision, 'active');
  assert.equal(observe(start, { at: 2, cpu: 10, mtime: 2 }, steps, 1200000).decision, 'active');
  assert.equal(observe(start, { at: 2, cpu: 10, mtime: 1 }, [{ number: 1, status: 'completed' }], 1200000).decision, 'active');
  assert.equal(observe(start, { at: 2, cpu: 10, mtime: 1 }, steps, 1200000).decision, 'silent');
  assert.equal(observe(start, { at: 2, cpu: 10, mtime: null }, steps, 1200000).decision, 'unknown');
  assert.equal(observe(start, { at: 2, cpu: 9, mtime: 1 }, steps, 1200000).decision, 'observing');
});

test('both metadata probe commands are valid shell without opening logs', () => {
  for (const command of [PROBE, REUSE_PROBE]) {
    assert.equal(spawnSync('/bin/bash', ['-n'], { input: command }).status, 0);
    assert.ok(!command.includes('runner.log'));
  }
});

test('rerun uses a separate Actions-write installation token', async () => {
  const api = new APIs({}, fetch, () => 1000000), permissions = [], calls = [];
  api.appJWT = async () => 'fake-app-jwt';
  api.request = async (_service, path, options = {}) => {
    if (path.includes('/access_tokens')) {
      permissions.push(options.body.permissions);
      return { token: `fake-installation-${permissions.length}`, expires_at: new Date(2000000).toISOString() };
    }
    calls.push({ path, method: options.method, expectEmpty: options.expectEmpty });
    return {};
  };
  const job = { installation: 7, repo: 'owner/project' };
  await api.getJob(job, 10);
  await api.rerunJob(job, 10);
  assert.deepEqual(permissions, [{ administration: 'write', actions: 'read' }, { actions: 'write' }]);
  assert.deepEqual(calls.at(-1), { path: '/repos/owner/project/actions/jobs/10/rerun', method: 'POST', expectEmpty: true });
});
