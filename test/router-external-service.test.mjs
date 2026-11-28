import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { TenantStorage } from '../src/router/tenant-storage.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { ExternalService } from '../src/router/external-service.mjs';

const id = '00000000-0000-4000-8000-000000000001';

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
function rollingName(manifestSha256) {
  const value = BigInt(`0x${manifestSha256}`) << 4n;
  let encoded = '';
  for (let index = 51; index >= 0; index--) encoded += alphabet[Number((value >> BigInt(index * 5)) & 31n)];
  return `peek-ci-${encoded}`;
}

function setup() {
  let time = 10_000; const now = () => time;
  const storage = new Storage(), projectStorage = new TenantStorage(storage, 'project-a');
  const config = { repo: 'a/b', labels: ['boat-default'], sizes: { 'boat-default': { machine: 'default' } }, caps: { concurrent: 10 }, machineTtlSeconds: 7200, reuse: { mode: 'on' } };
  const clients = { compute: { enabled: true, project: 'project-a', maxActive: 1, startsPerDay: 1, ttlSeconds: 60 } };
  const ledger = new AccountLedger(storage, { externalClients: clients, starts: { minute: 10, hour: 10, day: 10 } }, now);
  const project = { storage: projectStorage, config, box: true };
  const api = { removeRunner: async () => {}, lightReset: async () => ({ processId: 7 }), lightResetResult: async () => ({ ok: true }), limits: async () => ({ canStart: false }) };
  const service = new ExternalService({ projects: new Map([['project-a', project]]), ledger, account: { reuse: { enabled: true } } }, storage, api, clients, now);
  return { storage, projectStorage, service, setTime: n => { time = n; } };
}
test('warm lease is fenced and reset, and expiry starts deletion', async () => {
  const { storage, projectStorage, service, setTime } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [{ id: 9, status: 'online', busy: false }] });
  await projectStorage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: '["a/b","boat-default"]', state: 'idle', size: 'default', runnerId: 9, generation: 0, reusable: true, baselineHash: 'hash', everOnline: true, createdAt: 1 });
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'resetting');
  assert.equal((await service.claim('compute', id, 'default')).state, 'active');
  setTime(71_000); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'destroying');
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'cleaning');
  await projectStorage.put('box:bx_23456789', { state: 'deleted' }); await service.sweep();
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'closed');
});
test('a CI-fenced warm box can serve a lease lease after reset', async () => {
  const { storage, projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: '["a/b","boat-default"]', state: 'local-held', runnerFenced: true, size: 'default', runnerId: 9, generation: 0, reusable: true, baselineHash: 'hash', everOnline: true, createdAt: 1 });
  let removals = 0;
  service.api.removeRunner = async () => { removals++; };
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'resetting');
  assert.equal(removals, 0, 'the CI runner was already fenced');
  assert.equal((await service.claim('compute', id, 'default')).state, 'active');
});
test('an unconfirmed local fence cannot serve a lease lease', async () => {
  const { storage, projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: '["a/b","boat-default"]', state: 'local-held', runnerFenced: false, size: 'default', runnerId: 9, generation: 0, reusable: true, baselineHash: 'hash', everOnline: true, createdAt: 1 });
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'local-held');
  assert.notEqual((await storage.get(`external-lease:compute:${id}`))?.state, 'active');
});
test('queued CI demand prevents taking an idle runner', async () => {
  const { projectStorage, service, storage } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('gh-job:1', { status: 'queued' });
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal(await storage.get(`external-lease:compute:${id}`), undefined);
  assert.equal(await service.pendingReason('compute', id, 'default'), 'ci_demand_or_snapshot');
});
test('boot breaker allows a fenced warm lease without starting a box', async () => {
  const { projectStorage, service, storage } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [{ id: 9, status: 'online', busy: false }] });
  await projectStorage.put('verification:breaker', { tripped: true });
  await projectStorage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: '["a/b","boat-default"]', state: 'idle', size: 'default', runnerId: 9, generation: 0, reusable: true, baselineHash: 'hash', everOnline: true, createdAt: 1 });
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'resetting');
  assert.equal((await service.claim('compute', id, 'default')).state, 'active');
});
test('boot breaker prevents a new external lease box when no warm runner exists', async () => {
  const { projectStorage, service, storage } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('verification:breaker', { tripped: true });
  let starts = 0;
  service.api.limits = async () => ({ canStart:true, machineTypes:[{type:'default',available:true}], starts:{minute:{limit:10,used:0},hour:{limit:10,used:0},day:{limit:10,used:0}} });
  service.api.create = async () => { starts++; return { sandbox:{id:'bx_23456789'} }; };
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal(starts,0);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'reserved');
});


test('local-only queued work does not block a Boat lease', async () => {
  const { projectStorage, service } = setup();
  service.router.projects.get('project-a').config.externalClaimer = { localOnly: ['mac-only'] };
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('gh-job:1', { status: 'queued', pool: '[\"a/b\",\"mac-only\"]' });
  assert.equal(await service.ciIdle(), true);
  await projectStorage.put('gh-job:2', { status: 'queued', pool: '[\"a/b\",\"boat-default\"]' });
  assert.equal(await service.ciIdle(), false);
});

test('incomplete snapshots and unknown pools remain conservative', async () => {
  const { projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: false, at: 10_000, runners: [] });
  assert.equal(await service.ciIdle('default'), false);
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('gh-job:unknown', { status: 'queued', pool: '["a/b","unknown"]' });
  assert.equal(await service.ciIdle('default'), false);
});

test('lease refusal reports the client cap and CI gate', async () => {
  const { projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('gh-job:1', { status: 'queued', pool: '[\"a/b\",\"boat-default\"]' });
  await service.claim('compute', id, 'default');
  assert.equal(await service.pendingReason('compute', id), 'ci_demand_or_snapshot');
  await service.storage.put(`external-lease:compute:${id}`, {client:'compute', id, state:'active', expiresAt:70_000});
  assert.equal(await service.pendingReason('compute', '00000000-0000-4000-8000-000000000002'), 'lease_cap');
});

test('boot breaker blocks pending external creates but resolves uncertain creates', async () => {
  for (const status of ['pending','unknown']) {
    const { projectStorage, service, storage } = setup();
    await projectStorage.put('pool:mode','on');
    await projectStorage.put('pool:snapshot',{complete:true,at:10_000,runners:[]});
    await projectStorage.put('verification:breaker',{tripped:true});
    await storage.put(`external-lease:compute:${id}`,{client:'compute',id,state:'starting',size:'default',project:'project-a',claimKey:'claim',createdAt:1,expiresAt:70_000});
    service.router.ledger.claim = async () => ({status});
    service.api.limits = async () => ({canStart:true,machineTypes:[{type:'default',available:true}],starts:{minute:{limit:10,used:0},hour:{limit:10,used:0},day:{limit:10,used:0}}});
    let attempts=0; service.starts.start = async () => { attempts++; return false; };
    assert.equal(await service.claim('compute',id,'default'),null);
    assert.equal(attempts,status === 'unknown' ? 1 : 0);
  }
});

test('isolated release resets and reuses a warm box without a new start', async () => {
  const { storage, projectStorage, service } = setup();
  const next = '00000000-0000-4000-8000-000000000002';
  service.clients.compute.warmReuse = true;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await storage.put(`external-lease:compute:${id}`, {client:'compute',id,state:'active',project:'project-a',size:'default',machineId:'bx_23456789',isolation:'external-v2',expiresAt:70_000});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',pool:'["a/b","boat-default"]',state:'leased',size:'default',leaseClient:'compute',leaseId:id,baselineHash:'a'.repeat(64),generation:1,createdAt:1});
  assert.equal(await service.release('compute', id), false);
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'lease-returning');
  await service.sweep();
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'closed');
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'lease-warm');
  assert.equal((await service.claim('compute', next, 'default', 'external-v2')).machineId, 'bx_23456789');
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'leased');
});

test('a warm lease prefers the box that has its repository mirror', async () => {
  const { projectStorage, service } = setup();
  const key = 'a'.repeat(64);
  service.clients.compute.warmReuse = true;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  const box = { pool:'["a/b","boat-default"]', state:'lease-warm', size:'default', leaseClient:'compute', leaseIsolation:'external-v2', baselineHash:'a'.repeat(64), generation:1, createdAt:1, since:10_000 };
  await projectStorage.put('box:bx_11111111', { ...box, machineId:'bx_11111111' });
  await projectStorage.put('box:bx_22222222', { ...box, machineId:'bx_22222222', mirrorKeys:[key] });
  const lease = await service.claim('compute', id, 'default', 'external-v2', key);
  assert.equal(lease.machineId, 'bx_22222222');
});

test('failed return reset destroys the box and retains the lease until deletion', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.warmReuse = true;
  service.api.lightResetResult = async () => ({ok:false});
  await storage.put(`external-lease:compute:${id}`, {client:'compute',id,state:'active',project:'project-a',size:'default',machineId:'bx_23456789',isolation:'external-v2',expiresAt:70_000});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',state:'leased',leaseClient:'compute',leaseId:id,baselineHash:'a'.repeat(64),generation:1,createdAt:1});
  await service.release('compute', id); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'destroying');
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'cleaning');
});

test('old unrestricted leases are deleted instead of reused', async () => {
  const { storage, projectStorage, service } = setup();
  await storage.put(`external-lease:compute:${id}`, {client:'compute',id,state:'active',project:'project-a',machineId:'bx_23456789',expiresAt:70_000});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',state:'leased',leaseClient:'compute',leaseId:id});
  assert.equal(await service.release('compute', id), true);
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'destroying');
});

test('warm boxes expire at the configured reuse hold', async () => {
  const { projectStorage, service, setTime } = setup();
  await projectStorage.put('pool:status:boat-default', {reuseIdleHoldSeconds:120});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',pool:'["a/b","boat-default"]',state:'lease-warm',leaseClient:'compute',createdAt:1,since:10_000});
  setTime(129_999); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'lease-warm');
  setTime(130_000); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'destroying');
});

test('new isolated boxes establish a baseline before becoming active', async () => {
  const { storage, projectStorage, service } = setup();
  const box = {machineId:'bx_23456789',state:'lease-booting',leaseClient:'compute',leaseId:id,generation:0};
  await storage.put(`external-lease:compute:${id}`, {client:'compute',id,state:'booting',project:'project-a',size:'default',machineId:box.machineId,isolation:'external-v2',expiresAt:70_000});
  await projectStorage.put(`box:${box.machineId}`, box);
  service.api.sandbox = async () => ({sandbox:{setupStatus:'done',state:'ready'}});
  service.api.refresh = async () => ({processId:4});
  service.api.refreshResult = async () => ({ok:true,baselineHash:'a'.repeat(64)});
  assert.equal(await service.starts.ready('compute', id), false);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'baselining');
  assert.equal(await service.starts.baselineReady('compute', id), true);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'active');
  assert.equal((await projectStorage.get(`box:${box.machineId}`)).baselineHash, 'a'.repeat(64));
});

test('an abandoned boot completes its baseline for the next lease without another start', async () => {
  const { storage, projectStorage, service } = setup();
  const next = '00000000-0000-4000-8000-000000000002', machineId = 'bx_23456789';
  service.clients.compute.warmReuse = true; service.clients.compute.maxActive = 2;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', {complete:true, at:10_000, runners:[]});
  await storage.put(`external-lease:compute:${id}`, {client:'compute', id, state:'booting', project:'project-a', size:'default', machineId, isolation:'external-v2', createdAt:1, expiresAt:70_000});
  await projectStorage.put(`box:${machineId}`, {machineId, pool:'["a/b","boat-default"]', state:'lease-booting', size:'default', leaseClient:'compute', leaseId:id, generation:0, createdAt:1, since:10_000});
  service.api.sandbox = async () => ({sandbox:{setupStatus:'done', state:'ready'}});
  service.api.refresh = async () => ({processId:4});
  service.api.refreshResult = async () => ({ok:true, baselineHash:'a'.repeat(64)});
  service.api.limits = async () => { throw new Error('must wait for the existing box'); };
  await service.release('compute', id);
  assert.equal(await service.claim('compute', next, 'default', 'external-v2'), null);
  assert.equal((await storage.get(`external-lease:compute:${next}`)).lastReason, 'lease_pool_preparing');
  await service.sweep(); await service.sweep();
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'closed');
  assert.equal((await projectStorage.get(`box:${machineId}`)).state, 'lease-warm');
  assert.equal((await service.claim('compute', next, 'default', 'external-v2')).machineId, machineId);
});

test('an abandoned fenced reset becomes a warm box only after reset succeeds', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.warmReuse = true;
  await storage.put(`external-lease:compute:${id}`, {client:'compute', id, state:'resetting', project:'project-a', size:'default', machineId:'bx_23456789', isolation:'external-v2', processId:7, generation:1, expiresAt:70_000});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789', state:'lease-resetting', leaseClient:'compute', leaseId:id, baselineHash:'a'.repeat(64), generation:1, createdAt:1, since:10_000});
  await service.release('compute', id); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'lease-warm');
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'closed');
});

test('an expired isolated boot is baselined and retained after its client disappears', async () => {
  const { storage, projectStorage, service, setTime } = setup();
  service.clients.compute.warmReuse = true;
  await storage.put(`external-lease:compute:${id}`, {client:'compute', id, state:'booting', project:'project-a', size:'default', machineId:'bx_23456789', isolation:'external-v2', createdAt:1, expiresAt:9_999});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789', pool:'["a/b","boat-default"]', state:'lease-booting', size:'default', leaseClient:'compute', leaseId:id, generation:0, createdAt:1, since:9_000});
  service.api.sandbox = async () => ({sandbox:{setupStatus:'done', state:'ready'}});
  service.api.refresh = async () => ({processId:4});
  service.api.refreshResult = async () => ({ok:true, baselineHash:'a'.repeat(64)});
  setTime(10_000); await service.sweep(); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'lease-warm');
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'closed');
});

test('a failed abandoned reset destroys the unsafe box', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.warmReuse = true;
  service.api.lightResetResult = async () => ({ok:false});
  await storage.put(`external-lease:compute:${id}`, {client:'compute', id, state:'resetting', project:'project-a', size:'default', machineId:'bx_23456789', isolation:'external-v2', processId:7, generation:1, expiresAt:70_000});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789', state:'lease-resetting', leaseClient:'compute', leaseId:id, baselineHash:'a'.repeat(64), generation:1, createdAt:1, since:10_000});
  await service.release('compute', id); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'destroying');
});

test('configured client lease cap allows twelve concurrent reservations', async () => {
  const { service } = setup();
  service.clients.compute.maxActive = 12;
  for (let n = 1; n <= 12; n++) {
    const key = `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
    assert.ok(await service.leases.reserve('compute', key, 12, 60_000));
  }
  assert.equal(await service.leases.reserve('compute','00000000-0000-4000-8000-000000000013',12,60_000),null);
});

test('queued CI claims a clean warm box before another lease', async () => {
  const { projectStorage, service } = setup();
  await projectStorage.put('pool:mode','on');
  await projectStorage.put('pool:snapshot',{complete:true,at:10_000,runners:[]});
  await projectStorage.put('gh-job:9',{status:'queued',pool:'["a/b","boat-default"]'});
  await projectStorage.put('box:bx_23456789',{machineId:'bx_23456789',pool:'["a/b","boat-default"]',originPool:'["a/b","boat-default"]',state:'lease-warm',leaseClient:'compute',createdAt:1,since:10_000,baselineHash:'a'.repeat(64),generation:2,reusable:true});
  await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state,'ready');
});

test('warm lease expires against its own shorter machine lifetime', async () => {
  const { projectStorage, service, setTime } = setup();
  service.clients.compute.warmReuse = true;
  await projectStorage.put('pool:mode','on');
  await projectStorage.put('pool:snapshot',{complete:true,at:110_000,runners:[]});
  await projectStorage.put('box:bx_23456789',{machineId:'bx_23456789',pool:'["a/b","boat-default"]',state:'lease-warm',size:'default',leaseClient:'compute',createdAt:1,since:100_000,machineTtlSeconds:1900,baselineHash:'a'.repeat(64),generation:2,reusable:true});
  setTime(110_000);
  assert.equal(await service.claim('compute',id,'default','external-v2'),null);
  await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state,'destroying');
});


test('CI priority ignores matrix jobs without a GitHub slot but retains runnable work', async () => {
  const { projectStorage, service } = setup();
  const project = service.router.projects.get('project-a');
  project.config.workflowConcurrency = [{ workflow: 'matrix', jobPrefix: 'browser (', maxParallel: 4 }];
  project.config.labels.push('boat-large');
  project.config.sizes['boat-large'] = { machine: 'large' };
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  const base = { pool: '["a/b","boat-large"]', runId: 10, workflowName: 'matrix', jobName: 'browser (shard)', queuedAt: 0 };
  for (let id = 1; id <= 4; id++) await projectStorage.put(`gh-job:${id}`, { ...base, id, status: 'in_progress' });
  await projectStorage.put('gh-job:5', { ...base, id: 5, status: 'queued' });
  assert.equal(await service.ciIdle(), true);
  await projectStorage.put('gh-job:6', { id: 6, status: 'queued', pool: '["a/b","boat-default"]' });
  assert.equal(await service.ciIdle(), false);
  await projectStorage.delete('gh-job:6');
  await projectStorage.put('gh-job:1', { ...base, id: 1, status: 'completed' });
  assert.equal(await service.ciIdle('default'), true);
  assert.equal(await service.ciIdle('large'), false);
  await projectStorage.put('pool:snapshot', { complete: false, at: 10_000 });
  assert.equal(await service.ciIdle(), false);
});

test('legacy isolated lease protocol is not eligible for the external user pool', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.warmReuse = true;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',pool:'["a/b","boat-default"]',state:'lease-warm',size:'default',leaseClient:'compute',leaseIsolation:'ci-v1',createdAt:1,since:10_000,baselineHash:'a'.repeat(64),generation:2,reusable:true});
  assert.equal(await service.claim('compute',id,'default','external-v2'),null);
  assert.equal((await projectStorage.get('box:bx_23456789')).state,'lease-warm');
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state,'reserved');
});

test('only runnable CI demand for the requested size blocks a lease', async () => {
  const { projectStorage, service } = setup();
  const config = service.router.projects.get('project-a').config;
  config.labels = ['boat-default', 'boat-large'];
  config.sizes['boat-large'] = { machine: 'large' };
  await projectStorage.put('pool:mode','on');
  await projectStorage.put('pool:snapshot',{complete:true,at:10_000,runners:[]});
  await projectStorage.put('gh-job:1',{status:'queued',pool:'["a/b","boat-large"]'});
  assert.equal(await service.ciIdle('default'), true);
  assert.equal(await service.ciIdle('large'), false);
});

test('deferred CI permits only an already fenced client warm box', async () => {
  for (const reason of ['local_capacity', 'ledger:minute_cap', 'ledger:hour_cap', 'ledger:day_cap']) {
    const { projectStorage, service } = setup();
    service.clients.compute.warmReuse = true;
    await projectStorage.put('pool:mode', 'on');
    await projectStorage.put('pool:snapshot', {complete:true, at:10_000, runners:[{id:9,status:'online',busy:false}]});
    await projectStorage.put('pool:status:boat-default', {reason});
    await projectStorage.put('gh-job:1', {status:'queued',pool:'["a/b","boat-default"]'});
    await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',pool:'["a/b","boat-default"]',state:'lease-warm',size:'default',leaseClient:'compute',leaseIsolation:'external-v2',createdAt:1,since:10_000,baselineHash:'a'.repeat(64),generation:2});
    await projectStorage.put('box:bx_23456780', {machineId:'bx_23456780',pool:'["a/b","boat-default"]',state:'idle',size:'default',runnerId:9,reusable:true,baselineHash:'a'.repeat(64),everOnline:true,createdAt:1});
    const lease = await service.claim('compute', id, 'default', 'external-v2');
    assert.equal(lease?.machineId, 'bx_23456789', reason);
    assert.equal((await projectStorage.get('box:bx_23456780')).state, 'idle', reason);
  }
});

test('deferred CI cannot cause an external start or fence a CI runner', async () => {
  const { projectStorage, service } = setup();
  service.clients.compute.warmReuse = true;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', {complete:true, at:10_000, runners:[{id:9,status:'online',busy:false}]});
  await projectStorage.put('pool:status:boat-default', {reason:'local_capacity'});
  await projectStorage.put('gh-job:1', {status:'queued',pool:'["a/b","boat-default"]'});
  await projectStorage.put('box:bx_23456780', {machineId:'bx_23456780',pool:'["a/b","boat-default"]',state:'idle',size:'default',runnerId:9,reusable:true,baselineHash:'a'.repeat(64),everOnline:true,createdAt:1});
  service.api.limits = async () => { throw new Error('must not start'); };
  assert.equal(await service.claim('compute', id, 'default', 'external-v2'), null);
  assert.equal((await projectStorage.get('box:bx_23456780')).state, 'idle');
});

test('expired unassigned reservations no longer consume client capacity', async () => {
  const { storage, service } = setup();
  const old = '00000000-0000-4000-8000-000000000002';
  await storage.put(`external-lease:compute:${old}`, {client:'compute',id:old,state:'reserved',createdAt:1,expiresAt:9999});
  const lease = await service.leases.reserve('compute', id, 1, 60000);
  assert.equal(lease.state,'reserved');
  assert.equal((await storage.get(`external-lease:compute:${old}`)).state,'closed');
});

test('expired uncertain starts still consume client capacity', async () => {
  const { storage, service } = setup();
  const old = '00000000-0000-4000-8000-000000000002';
  await storage.put(`external-lease:compute:${old}`, {client:'compute',id:old,state:'starting',createdAt:1,expiresAt:9999});
  assert.equal(await service.leases.reserve('compute', id, 1, 60000),null);
  assert.equal((await storage.get(`external-lease:compute:${old}`)).state,'starting');
});


test('CI-blocked reserved requests free the active lease slot', async () => {
  const { projectStorage, service, storage } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await storage.put(`external-lease:compute:${id}`, { client:'compute', id, state:'reserved', project:'project-a', size:'default', createdAt:1, expiresAt:70_000 });
  await projectStorage.put('gh-job:1', { status:'queued', pool:'["a/b","boat-default"]' });
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'waiting');
  assert.equal(await service.pendingReason('compute', id, 'default'), 'ci_demand_or_snapshot');
  assert.equal(await service.pendingReason('compute', '00000000-0000-4000-8000-000000000002', 'default'), 'ci_demand_or_snapshot');
});


test('sweep frees unassigned reservations but preserves in-flight starts', async () => {
  const { service, storage } = setup();
  const other = '00000000-0000-4000-8000-000000000002';
  await storage.put(`external-lease:compute:${id}`, { client:'compute', id, state:'reserved', project:'project-a', size:'default', createdAt:1, expiresAt:70_000 });
  await storage.put(`external-lease:compute:${other}`, { client:'compute', id:other, state:'starting', project:'project-a', size:'default', createdAt:1, expiresAt:70_000 });
  await service.sweep();
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'waiting');
  assert.equal((await storage.get(`external-lease:compute:${other}`)).state, 'starting');
});


test('sweep releases unadmitted starts and preserves uncertain ledger claims', async () => {
  for (const admitted of [false, true]) {
    const { service, storage } = setup();
    const claimKey = 'abc';
    service.ledger.claim = async () => admitted ? { status:'unknown' } : null;
    await storage.put(`external-lease:compute:${id}`, { client:'compute', id, state:'starting', project:'project-a', size:'default', claimKey, createdAt:1, expiresAt:70_000 });
    await service.sweep();
    assert.equal((await storage.get(`external-lease:compute:${id}`)).state, admitted ? 'starting' : 'waiting');
  }
});


test('release never discards a waiting record with evidence of a box or start', async () => {
  for (const evidence of [{machineId:'bx_23456789'}, {claimKey:'uncertain'}]) {
    const { service, storage } = setup();
    await storage.put(`external-lease:compute:${id}`, {client:'compute', id, state:'waiting', expiresAt:70_000, ...evidence});
    assert.equal(await service.release('compute', id), false);
    assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'waiting');
  }
});

// A warm lease can release its total cap slot for another pool.
test('wrong-size warm lease releases a full project slot for queued CI', async () => {
  const { projectStorage, service } = setup();
  service.router.projects.get('project-a').config.caps.concurrent = 1;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('gh-job:9', { id: 9, status: 'queued', queuedAt: 1000, pool: '["a/b","boat-large"]' });
  await projectStorage.put('box:bx_23456789', { machineId:'bx_23456789', pool:'["a/b","boat-default"]', state:'lease-warm', size:'default', leaseClient:'compute', createdAt:1, since:10_000, baselineHash:'a'.repeat(64), generation:2, reusable:true });
  await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'destroying');
});

test('lease warm box is retained after the longer CI timeout margin but respects lease headroom', async () => {
  const { projectStorage, service, setTime } = setup();
  service.router.projects.get('project-a').config.jobs = { ci: { timeoutMinutes: 150 } };
  await projectStorage.put('pool:status:boat-default', {reuseIdleHoldSeconds:3600});
  await projectStorage.put('box:bx_23456789', {machineId:'bx_23456789',pool:'["a/b","boat-default"]',state:'lease-warm',leaseClient:'compute',createdAt:1,since:7_000_000,machineTtlSeconds:14400,baselineHash:'a'.repeat(64),generation:1,reusable:true});
  setTime(7_010_000); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state,'lease-warm');
  setTime(12_600_002); await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state,'destroying');
});

test('matching returning mirror is preferred over fencing another idle box', async () => {
  const {storage,projectStorage,service}=setup(); const key='a'.repeat(64);
  service.clients.compute.warmReuse=true;
  await projectStorage.put('pool:mode','on');
  await projectStorage.put('pool:snapshot',{complete:true,at:10_000,runners:[{id:9,status:'online',busy:false}]});
  await projectStorage.put('box:bx_23456789',{machineId:'bx_23456789',state:'lease-returning',size:'default',leaseClient:'compute',mirrorKeys:[key],since:9_000});
  await projectStorage.put('box:bx_23456780',{machineId:'bx_23456780',pool:'["a/b","boat-default"]',state:'idle',size:'default',runnerId:9,reusable:true,baselineHash:'a'.repeat(64),everOnline:true,createdAt:1});
  assert.equal(await service.claim('compute',id,'default','external-v2',key),null);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).lastReason,'lease_pool_preparing');
  assert.equal((await projectStorage.get('box:bx_23456780')).state,'idle');
});

test('open queue defers an HTTP lease start to the ordered admission tick', async () => {
  const { storage, projectStorage, service } = setup();
  service.router.account.openStartQueue = true;
  service.ledger.policy.openStartQueue = true;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  let starts = 0;
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async () => { starts++; return { sandbox: { id: 'bx_23456789' } }; };
  await service.claim('compute', id, 'default');
  assert.equal(starts, 0);
  const entries = await service.admissionEntries();
  assert.equal(entries.length, 1);
  await service.admitStart(entries[0]);
  assert.equal(starts, 1);
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'booting');
});

test('lease sizes accept small, default and large but never xlarge', async () => {
  for (const [size, accepted] of [['small', true], ['default', true], ['large', true], ['xlarge', false], ['huge', false]]) {
    const { storage, projectStorage, service } = setup();
    projectStorage.put('pool:mode', 'on');
    await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
    service.api.limits = async () => ({ canStart: false });
    assert.equal(await service.claim('compute', id, size), null, size);
    const lease = await storage.get(`external-lease:compute:${id}`);
    assert.equal(Boolean(lease), accepted, size);
    if (accepted) assert.equal(lease.size, size, size);
  }
});

test('a rolling claim with no ready generation waits and never starts a plain box', async () => {
  const { storage, projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  let starts = 0;
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async () => { starts++; return { sandbox: { id: 'bx_23456789' } }; };
  assert.equal(await service.claim('compute', id, 'default', 'external-v2', null, false, null, true), null);
  const lease = await storage.get(`external-lease:compute:${id}`);
  assert.equal(lease.state, 'waiting');
  assert.equal(lease.rollingSnapshot, true);
  assert.equal(lease.lastReason, 'ci_snapshot_unavailable');
  assert.equal(starts, 0);
  assert.equal(await service.pendingReason('compute', id, 'default'), 'ci_snapshot_unavailable');
});

// A complete snapshot is evidence that the scan loop is alive, and the loop
// rescans every refresh cycle: one minute when the router polls GitHub, fifteen
// when repository webhooks carry the queue. A fixed 90 s bound refused every
// lease outside the first 90 s after each webhook-mode scan.
test('a webhook-mode snapshot is ready for one refresh cycle', async () => {
  const { storage, projectStorage, service, setTime } = setup();
  service.router.account.openStartQueue = true;
  service.router.projects.get('project-a').config.snapshotIntervalMs = 15 * 60_000;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  setTime(10_000 + 10 * 60_000);
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal((await storage.get(`external-lease:compute:${id}`))?.state, 'reserved');
  assert.notEqual(await service.pendingReason('compute', id, 'default'), 'ci_snapshot_unavailable');
});

test('a snapshot older than one webhook refresh cycle and its grace is not ready', async () => {
  const { storage, projectStorage, service, setTime } = setup();
  service.router.account.openStartQueue = true;
  service.router.projects.get('project-a').config.snapshotIntervalMs = 15 * 60_000;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  setTime(10_000 + 15 * 60_000 + 30_000 + 1);
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal(await storage.get(`external-lease:compute:${id}`), undefined);
  assert.equal(await service.pendingReason('compute', id, 'default'), 'ci_snapshot_unavailable');
});

test('a poll-mode project keeps its 90 second snapshot bound', async () => {
  const reserveAt = async age => {
    const { storage, projectStorage, service, setTime } = setup();
    service.router.account.openStartQueue = true;
    await projectStorage.put('pool:mode', 'on');
    await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
    setTime(10_000 + age);
    assert.equal(await service.claim('compute', id, 'default'), null);
    return Boolean(await storage.get(`external-lease:compute:${id}`));
  };
  assert.equal(await reserveAt(90_000), true);
  assert.equal(await reserveAt(90_001), false);
});

test('a webhook snapshot gates an idle CI pool on its own refresh cycle', async () => {
  const { projectStorage, service, setTime } = setup();
  service.router.projects.get('project-a').config.snapshotIntervalMs = 15 * 60_000;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  setTime(10_000 + 10 * 60_000);
  assert.equal(await service.ciIdle('default'), true);
  setTime(10_000 + 15 * 60_000 + 30_001);
  assert.equal(await service.ciIdle('default'), false);
});

test('queued CI reclaims a warm lease box while the webhook snapshot is current', async () => {
  const { projectStorage, service, setTime } = setup();
  service.router.projects.get('project-a').config.snapshotIntervalMs = 15 * 60_000;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  await projectStorage.put('pool:status:boat-default', { reuseIdleHoldSeconds: 3600 });
  await projectStorage.put('gh-job:9', { id: 9, status: 'queued', queuedAt: 9_000, pool: '["a/b","boat-default"]' });
  await projectStorage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: '["a/b","boat-default"]', state: 'lease-warm', size: 'default', leaseClient: 'compute', createdAt: 1, since: 9_000, baselineHash: 'a'.repeat(64), generation: 2, reusable: true });
  setTime(10_000 + 10 * 60_000);
  await service.sweep();
  assert.equal((await projectStorage.get('box:bx_23456789')).state, 'ready');
});

test('a rolling claim boots the stored peek-ci generation it selected', async () => {
  const { storage, projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  const manifestSha256 = 'd'.repeat(64);
  const selection = { baseId: manifestSha256, rollingSnapshot: true, account: 'primary', routerSnapshot: { kind: 'peek-ci', name: rollingName(manifestSha256), snapshotId: 'snapshot-id', manifestSha256 } };
  let request;
  service.api.forIdentity = async () => ({ request: async () => ({ snapshot: { status: 'ready', snapshotId: 'snapshot-id' } }) });
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async job => { request = job; return { sandbox: { id: 'bx_23456789' } }; };
  assert.equal(await service.claim('compute', id, 'default', 'external-v2', null, false, selection, true), null);
  const lease = await storage.get(`external-lease:compute:${id}`);
  assert.deepEqual(lease.routerSnapshot, selection.routerSnapshot);
  assert.equal(lease.state, 'booting');
  assert.deepEqual(request.routerSnapshot, selection.routerSnapshot);
});

// A single-account router has no account switch, so the identity check may not
// depend on one: without this, every snapshot-selected lease stayed reserved
// until it expired, on every tick, and no box was ever created.
test('a single-account router verifies a rolling generation without an account switch', async () => {
  const { storage, projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  const manifestSha256 = 'd'.repeat(64);
  const selection = { baseId: manifestSha256, rollingSnapshot: true, account: 'primary', routerSnapshot: { kind: 'peek-ci', name: rollingName(manifestSha256), snapshotId: 'snapshot-id', manifestSha256 } };
  let asked = null, created = null;
  service.api.request = async (name, path) => { asked = { name, path }; return { snapshot: { status: 'ready', snapshotId: 'snapshot-id' } }; };
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async job => { created = job; return { sandbox: { id: 'bx_23456789' } }; };
  assert.equal(await service.claim('compute', id, 'default', 'external-v2', null, false, selection, true), null);
  const lease = await storage.get(`external-lease:compute:${id}`);
  assert.equal(lease.state, 'booting');
  assert.deepEqual(asked, { name: 'boat', path: '/saved-snapshots/' + encodeURIComponent(selection.routerSnapshot.name) });
  assert.deepEqual(created.routerSnapshot, selection.routerSnapshot);
});

test('a spend ceiling refusal stays pending with no box and no reserved money', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.ttlSeconds = 1800; service.clients.compute.machineTtlSeconds = 1800;
  const spend = { monthlyUsd: 20, machineHourUsd: { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 }, snapshotDayUsd: 0.056, snapshotRetentionDays: 30 };
  const ledger = new AccountLedger(storage, { starts: { minute: 10, hour: 10, day: 10 }, externalClients: service.clients, spend }, () => 10_000);
  service.ledger = ledger; service.starts.ledger = ledger;
  await storage.put('account:ledger', { claims: {}, waiting: [], spendReservations: { seed: { project: 'project-a', kind: 'machine', size: 'default', ttlSeconds: 7200, amountUsd: 19.99, at: 10_000, status: 'reserved' } } });
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  let starts = 0;
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, overagePrices: { vmHourDollars: 0.036 }, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async () => { starts++; return { sandbox: { id: 'bx_23456789' } }; };
  assert.equal(await service.claim('compute', id, 'default'), null);
  assert.equal(starts, 0);
  const lease = await storage.get(`external-lease:compute:${id}`);
  assert.equal(lease.lastReason, 'spend_budget');
  assert.equal(await service.pendingReason('compute', id, 'default'), 'spend_budget');
  const status = await ledger.spendStatus();
  assert.equal(status.records.length, 1, 'no reservation was added');
  assert.equal(status.records[0].amountUsd, 19.99);
  assert.equal(storage.data.has('project:project-a:box:bx_23456789'), false);
});

test('a refused provider create refunds its spend reservation and the lease releases', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.ttlSeconds = 1800; service.clients.compute.machineTtlSeconds = 1800;
  const spend = { monthlyUsd: 20, machineHourUsd: { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 }, snapshotDayUsd: 0.056, snapshotRetentionDays: 30 };
  const ledger = new AccountLedger(storage, { starts: { minute: 10, hour: 10, day: 10 }, externalClients: service.clients, spend }, () => 10_000);
  service.ledger = ledger; service.starts.ledger = ledger;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, overagePrices: { vmHourDollars: 0.036 }, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async () => { throw Object.assign(new Error('refused'), { service: 'boat', status: 402 }); };
  assert.equal(await service.claim('compute', id, 'default'), null);
  const lease = await storage.get(`external-lease:compute:${id}`);
  assert.equal(lease.state, 'closed');
  assert.equal((await ledger.spendStatus()).records.length, 0, 'the pending charge is refunded');
  assert.equal(await service.release('compute', id), true);
});

test('a created lease settles to its elapsed lifetime on the ledger', async () => {
  const { storage, projectStorage, service } = setup();
  service.clients.compute.ttlSeconds = 1800; service.clients.compute.machineTtlSeconds = 1800;
  const spend = { monthlyUsd: 20, machineHourUsd: { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 }, snapshotDayUsd: 0.056, snapshotRetentionDays: 30 };
  const ledger = new AccountLedger(storage, { starts: { minute: 10, hour: 10, day: 10 }, externalClients: service.clients, spend }, () => 10_000);
  service.ledger = ledger; service.starts.ledger = ledger;
  await projectStorage.put('pool:mode', 'on');
  await projectStorage.put('pool:snapshot', { complete: true, at: 10_000, runners: [] });
  service.api.limits = async () => ({ canStart: true, activeSandboxes: 0, maxActiveSandboxes: 10, overagePrices: { vmHourDollars: 0.036 }, machineTypes: [{ type: 'default', available: true }], starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: 10, used: 0 }])) });
  service.api.create = async () => ({ sandbox: { id: 'bx_23456789' } });
  assert.equal(await service.claim('compute', id, 'default'), null);
  const lease = await storage.get(`external-lease:compute:${id}`);
  assert.equal(lease.state, 'booting');
  const reserved = (await ledger.spendStatus()).records[0];
  assert.equal(reserved.amountUsd, 0.018);
  // The box deletion path settles the created claim with conservative elapsed time.
  await ledger.resolve(lease.claimKey, 'created', { elapsedSeconds: 60 });
  const settled = (await ledger.spendStatus()).records[0];
  assert.ok(settled.amountUsd < reserved.amountUsd);
  assert.equal(settled.elapsedSeconds, 60);
});

const otherId = '00000000-0000-4000-8000-000000000002';

test('releasing a rolling lease deletes its box instead of warming it', async () => {
  const { storage, projectStorage, service } = setup();
  await projectStorage.put('pool:mode', 'on');
  service.clients.compute.warmReuse = true;
  const key = 'bx_23456789';
  await storage.put(`project:project-a:box:${key}`, { machineId: key, leaseId: id, leaseClient: 'compute', state: 'leased', generation: 0, createdAt: 1, baselineHash: 'hash' });
  await storage.put(`external-lease:compute:${id}`, { id, client: 'compute', project: 'project-a', state: 'active', machineId: key, expiresAt: 70_000, isolation: 'external-v2', rollingSnapshot: true });
  let resets = 0; service.api.lightReset = async () => { resets++; return { processId: 9 }; };
  assert.equal(await service.release('compute', id), true);
  assert.equal(resets, 0, 'a rolling lease never returns to the warm pool');
  assert.equal((await projectStorage.get(`box:${key}`)).state, 'destroying');
  assert.equal((await storage.get(`external-lease:compute:${id}`)).state, 'cleaning');
});

test('a bounded keep-on-fail hold keeps the box for debugging and deletes it at its bound', async () => {
  const { storage, projectStorage, service, setTime } = setup();
  await projectStorage.put('pool:mode', 'on');
  const key = 'bx_23456789', leaseKey = `external-lease:compute:${id}`, boxKey = `project:project-a:box:${key}`;
  await storage.put(boxKey, { machineId: key, leaseId: id, leaseClient: 'compute', state: 'leased', generation: 0, createdAt: 1, baselineHash: 'hash' });
  await storage.put(leaseKey, { id, client: 'compute', project: 'project-a', state: 'active', machineId: key, expiresAt: 70_000, isolation: 'external-v2' });
  let resets = 0; service.api.lightReset = async () => { resets++; return { processId: 9 }; };
  const requests = [];
  const held = await service.release('compute', id, 900, { request: async (...args) => { requests.push(args); return {}; } });
  assert.equal(held.heldUntil, 910_000);
  assert.deepEqual(requests, [['boat', `/sandboxes/${key}`, { method: 'PATCH', body: { ttlSeconds: 900 } }]]);
  const lease = await storage.get(leaseKey);
  assert.equal(lease.state, 'held');
  assert.equal(lease.heldUntil, 910_000);
  assert.equal(await projectStorage.getAlarm(), 910_000);
  assert.equal((await storage.get(boxKey)).state, 'leased');
  assert.equal(resets, 0, 'a held box is never reset for the warm pool');
  assert.equal(await service.pendingReason('compute', id, 'default'), 'lease_held');
  assert.equal(await service.leases.renew('compute', id, 60_000), null, 'renew is refused during a hold');
  assert.equal(await service.leases.reserve('compute', otherId, 1, 5000), null, 'a hold counts against maxActive');
  setTime(909_999); await service.sweep();
  assert.equal((await storage.get(leaseKey)).state, 'held');
  setTime(910_000); await service.sweep();
  assert.equal((await storage.get(leaseKey)).state, 'cleaning');
  const destroyed = await storage.get(boxKey);
  assert.equal(destroyed.state, 'destroying');
  assert.equal(destroyed.retirementReason, 'hold_expired');
  assert.equal(destroyed.history.some(item => item.event === 'lease_return'), false);
});

test('a held lease is deleted at once when it is released without a keep', async () => {
  const { storage, service } = setup();
  const key = 'bx_23456789', leaseKey = `external-lease:compute:${id}`, boxKey = `project:project-a:box:${key}`;
  await storage.put(boxKey, { machineId: key, leaseId: id, leaseClient: 'compute', state: 'leased', generation: 0 });
  await storage.put(leaseKey, { id, client: 'compute', project: 'project-a', state: 'held', machineId: key, expiresAt: 70_000, heldUntil: 910_000 });
  assert.equal(await service.release('compute', id), true);
  assert.equal((await storage.get(leaseKey)).state, 'cleaning');
  assert.equal((await storage.get(boxKey)).state, 'destroying');
});

test('cancel deletes an owned process and a repeat cancel is idempotent', async () => {
  const { storage, service } = setup();
  const key = 'bx_23456789', leaseKey = `external-lease:compute:${id}`;
  await storage.put(leaseKey, { id, client: 'compute', project: 'project-a', state: 'active', machineId: key, expiresAt: 70_000 });
  const calls = [];
  service.api = { request: async (...args) => { calls.push(args); return {}; } };
  assert.deepEqual(await service.cancel('compute', id, 7), { status: 200, cancelled: true });
  assert.deepEqual(calls, [['boat', `/sandboxes/${key}/commands/7`, { method: 'DELETE' }]]);
  assert.deepEqual(await service.cancel('compute', id, 7), { status: 200, cancelled: false });
  assert.equal(calls.length, 1);
  assert.deepEqual((await storage.get(leaseKey)).cancelledProcessIds, [7]);
});

test('cancel refuses another client, a held lease and a process the provider does not know', async () => {
  const { storage, service } = setup();
  const key = 'bx_23456789', leaseKey = `external-lease:compute:${id}`;
  await storage.put(leaseKey, { id, client: 'compute', project: 'project-a', state: 'active', machineId: key, expiresAt: 70_000 });
  let calls = 0; service.api = { request: async () => { calls++; return {}; } };
  assert.deepEqual(await service.cancel('other', id, 7), { status: 404, reason: 'process_not_found' });
  await storage.put(leaseKey, { id, client: 'compute', project: 'project-a', state: 'held', machineId: key, heldUntil: 70_000 });
  assert.deepEqual(await service.cancel('compute', id, 7), { status: 404, reason: 'process_not_found' });
  await storage.put(leaseKey, { id, client: 'compute', project: 'project-a', state: 'active', machineId: key, expiresAt: 70_000 });
  service.api = { request: async () => { calls++; throw Object.assign(new Error('gone'), { status: 404 }); } };
  assert.deepEqual(await service.cancel('compute', id, 7), { status: 404, reason: 'process_not_found' });
  assert.equal((await storage.get(leaseKey)).cancelledProcessIds, undefined);
  assert.equal(calls, 1);
});
