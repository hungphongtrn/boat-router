import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { accounts, projects } from '../config/installation.mjs';
import { defaultWallet, repositories, setupOwner } from '../config/policy.mjs';
import { validateSuite } from '../src/router/plugins.mjs';

const wrangler = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const project = projects[0].config;

test('the installation registers exactly the Peek account and project', () => {
  assert.deepEqual(accounts.map(account => account.id), ['peek']);
  assert.deepEqual(projects.map(entry => entry.config.id), ['peek']);
  assert.deepEqual(validateSuite(project), []);
  assert.equal(project.repo, 'hungphongtrn/peek');
  assert.equal(project.account, 'peek');
});

test('the project serves exactly the peek-router label on the default machine', () => {
  assert.deepEqual(project.labels, ['peek-router']);
  assert.deepEqual(project.sizes, { 'peek-router': { machine: 'default' } });
});

test('reuse holds an idle box 120 seconds under a 12 hour machine TTL', () => {
  assert.equal(project.reuse.mode, 'on');
  assert.equal(project.reuse.idleHoldSeconds, 120);
  assert.equal(accounts[0].reuse.enabled, true);
  assert.equal(project.machineTtlSeconds, 43200);
});

test('both routed jobs declare a 150 minute timeout', () => {
  assert.deepEqual(project.jobs, { ci: { timeoutMinutes: 150 }, 'ci-test-run': { timeoutMinutes: 150 } });
});

test('the reuse window is 33000 seconds, not the upstream 600', () => {
  // Same formula as src/router/box-fleet.mjs:302-304.
  const timeouts = Object.values(project.jobs ?? {}).map(job => job.timeoutMinutes ?? 0);
  const headroom = Math.max(300, 1200 + Math.max(0, ...timeouts) * 60);
  assert.equal(headroom, 10200);
  assert.equal(Math.min(86400, project.machineTtlSeconds - headroom), 33000);
});

test('the policy names the Peek owner and repository', () => {
  assert.equal(setupOwner, 'hungphongtrn');
  assert.deepEqual(repositories, ['hungphongtrn/peek']);
  assert.equal(defaultWallet, 'peek');
});

test('the Worker stays disabled and carries the Peek wallet, project and TTL', () => {
  assert.equal(wrangler.name, 'peek-boat-router');
  assert.equal(wrangler.vars.ENABLED, 'false');
  assert.equal(wrangler.vars.BOAT_WALLET, 'peek');
  assert.equal(wrangler.vars.ROUTER_PROJECTS, 'peek');
  assert.equal(wrangler.vars.MACHINE_TTL_SECONDS, '43200');
});
