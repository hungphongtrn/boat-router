import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateSuite } from '../src/router/plugins.mjs';
import { accounts, leaseClients, projects } from '../config/installation.mjs';
import { defaultWallet, setupOwner, repositories, smokeRepository, localHosts } from '../config/policy.mjs';

const wrangler = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
const account = accounts[0];
const project = projects[0].config;

test('the deployment registers exactly Peek on the owner account', () => {
  assert.ok(accounts.some(value => value.id === 'peek'));
  assert.ok(projects.some(value => value.config.id === 'peek'));
  assert.equal(accounts[0].id, 'peek', 'peek is registered first');
  assert.equal(projects[0].config.id, 'peek', 'peek is registered first');
  assert.equal(defaultWallet, 'peek');
  assert.equal(account.id, defaultWallet);
  assert.ok(repositories.includes('hungphongtrn/peek'));
  assert.equal(project.repo, 'hungphongtrn/peek');
  assert.equal(project.account, account.id);
  assert.equal(setupOwner, 'hungphongtrn');
  assert.equal(smokeRepository, null);
});

test('the installed peek-runs lease client names the Peek project and its policy', () => {
  assert.deepEqual(leaseClients['peek-runs'], {
    enabled: true,
    project: 'peek',
    maxActive: 4,
    ttlSeconds: 1800,
    startsPerDay: 60,
    rollingSnapshot: true,
    warmReuse: false,
  });
  assert.equal(JSON.stringify(leaseClients).includes('tokenHash'), false, 'a token hash never lives in the repository');
});

test('the project passes the router validator', () => {
  assert.deepEqual(validateSuite(project), []);
  assert.equal(project.reuse.mode, 'on');
  assert.equal(project.snapshotBoot, true);
  assert.equal(project.rollingSnapshot, true);
  assert.equal(project.externalClaimer, undefined);
  assert.equal(project.localFirst, undefined);
});

test('the account paces starts at Boat limits and buys the extras past them', () => {
  assert.deepEqual(account.starts, { minute: 12, hour: 60, day: 260, allowPaidExtra: true, paidExtraMaxDollarsPerMonth: 15 });
  // Two caps measure different money: the $15 rolling budget bounds billed extra starts
  // (paid-extra.mjs, and the idle hold's paidExtraRoom), while the $20 spend ledger bounds
  // every metered reservation, the same start fee included.
  assert.equal(account.starts.paidExtraMaxDollarsPerMonth, 15);
  assert.equal(account.spend.monthlyUsd, 20);
  assert.deepEqual(account.spend.machineHourUsd, { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 });
  assert.equal(account.spend.snapshotDayUsd, 0.056);
  assert.equal(account.spend.snapshotRetentionDays, 30);
  assert.equal(account.margin, 0.1);
  assert.equal(account.openStartQueue, true);
  assert.equal(account.dayReserve, 0);
  assert.equal(account.poolPacing.enabled, true);
  assert.equal(account.poolPacing.mode, 'dynamic');
  assert.equal(account.poolPacing.unpaced, false);
  assert.equal(account.reuse.enabled, true);
  assert.equal(account.reuse.healthCheck, 'observe');
  assert.ok(account.reuse.maxAgeSeconds >= 4 * 3600);
  assert.ok(account.reuse.maxAgeSeconds < project.machineTtlSeconds);
});

test('autoscale sizes the CI pool (no fixed box cap) and the live reuse line stays on', () => {
  assert.equal(project.caps?.concurrent, undefined);
  assert.equal(project.reuse.mode, 'on');
  assert.equal(project.reuse.idleHoldSecondsWhenStartsPaid, 3600);
});

test('the heavy label is default and the light label is small', () => {
  assert.deepEqual(project.labels, ['peek-router', 'peek-router-light']);
  assert.deepEqual(project.sizes['peek-router'], { machine: 'default' });
  assert.deepEqual(project.sizes['peek-router-light'], { machine: 'small' });
  assert.deepEqual(project.triggers, [{ on: 'workflow_job', executor: 'actions-jit' }]);
});

test('the four nextest shards are planned as one max-parallel run', () => {
  assert.deepEqual(project.workflowConcurrency, [
    { workflowPath: '.github/workflows/ci.yml', jobPrefix: 'shard (', maxParallel: 4 },
  ]);
});

test('the Worker is disabled, names Peek and the same TTL', () => {
  const vars = wrangler.vars;
  assert.equal(vars.ENABLED, 'false');
  assert.equal(vars.BOAT_WALLET, account.id);
  assert.notEqual(vars.BOAT_PROVIDER_WALLET, vars.BOAT_WALLET);
  assert.equal(vars.ROUTER_PROJECTS, project.id);
  assert.equal(Number(vars.MACHINE_TTL_SECONDS), project.machineTtlSeconds);
});

test('the snapshot pin is either empty or a complete valid pair', () => {
  const name = wrangler.vars.PROJECT_SNAPSHOT_NAME;
  const manifest = wrangler.vars.PROJECT_SNAPSHOT_MANIFEST_SHA256;
  if (!name && !manifest) return;
  assert.match(name, /^[a-z][a-z0-9-]{0,40}-\d{8}-[a-f0-9]{8,64}$/);
  assert.match(manifest, /^[a-f0-9]{64}$/);
});

test('no local runner may claim a job', () => {
  assert.equal(project.externalClaimer, undefined);
  assert.equal(project.localFirst, undefined);
  assert.ok(Array.isArray(localHosts));
});
