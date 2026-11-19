import test from 'node:test';
import assert from 'node:assert/strict';
import { reuseEnabled } from '../src/router/jit-pool.mjs';
import { validateSuite } from '../src/router/plugins.mjs';

const account = { id: 'primary', reuse: { enabled: true } };
const project = { id: 'project-b', repo: 'example-owner/project-b', account: 'primary', reuse: { mode: 'on' }, labels: ['boat-large'], jobs: {}, landing: { engine: 'runner' } };
test('docker access rejects reuse at both configuration and runtime boundaries', () => {
  assert.ok(validateSuite({ ...project, dockerAccess: true }).some(x => /docker.*reuse|reuse.*docker/i.test(x)));
  assert.equal(reuseEnabled(account, { ...project, dockerAccess: true }), false);
});
