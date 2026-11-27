import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet, placementEvidence } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { Router } from '../src/router/core.mjs';

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
let serial = 0;
const sandboxId = () => { let n = serial++, s = ''; for (let i = 0; i < 8; i++) { s += ALPHABET[n % ALPHABET.length]; n = Math.floor(n / ALPHABET.length); } return `bx_${s}`; };

test('boat placement records current admission evidence without guessing stale reports', () => {
  const capacity = { at: 1000, offers: 0, reasons: { per_mini_slots: 2, cooldown: 1 } };
  assert.deepEqual(placementEvidence(capacity, 2000).categories, ['per_mini_slots', 'cooldown']);
  assert.equal(placementEvidence(capacity, 2000).reason, 'multiple_admission_limits');
  assert.equal(placementEvidence({ ...capacity, offers: 1 }, 2000).reason, 'no_claim_in_time');
  assert.equal(placementEvidence(capacity, 32000).reason, 'no_recent_agent_report');
  assert.equal(placementEvidence(capacity, 2000, false).reason, 'project_disabled');
});

function limitsAt(now, active = 0) {
  return { canStart: true, observedAt: now, activeSandboxes: active, maxActiveSandboxes: 50,
    startLimits: { perMinute: 100, perHour: 1000, perDay: 10000 },
    starts: { minute: { limit: 100, used: 0, remaining: 100 }, hour: { limit: 1000, used: 0, remaining: 1000 }, day: { limit: 10000, used: 0, remaining: 10000 } },
    machineTypes: [{ type: 'large', available: true }, { type: 'default', available: true }] };
}

function project(id, repo, label = 'work-large', size = 'large') {
  return { id, repo, account: 'account', labels: [label], sizes: { [label]: { machine: size } }, caps: {}, reuse: { mode: 'off' } };
}

function fakeApi(clock, created) {
  return {
    limits: async () => limitsAt(clock.now),
    create: async unit => { const id = sandboxId(); created.push({ id, pool: unit.pool }); return { sandbox: { id } }; },
    sandbox: async () => ({ sandbox: { state: 'running', setupStatus: 'pending' } }),
  };
}

async function setupProject(cfg, ledger, clock, created, jobs) {
  const storage = new Storage();
  await storage.put('pool:migrated', { done: true });
  await storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [] });
  const pool = JSON.stringify([cfg.repo, cfg.labels[0]]);
  for (const { id, queuedAt } of jobs) await storage.put(`gh-job:${id}`, { id, pool, status: 'queued', queuedAt, observedAt: queuedAt, source: 'webhook' });
  const budget = new SharedBudget(ledger, cfg.id, () => clock.now);
  const fleet = new BoxFleet(storage, fakeApi(clock, created), () => clock.now, { budget, project: cfg, installation: 1 });
  return { storage, fleet, cfg };
}

// Mirrors Router.runTick in pool mode: prepare all projects, then tick all.
async function routerTick(projects) {
  const opts = p => ({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: p.cfg });
  for (const p of projects) await p.fleet.tick({ ...opts(p), prepareOnly: true });
  for (const p of projects) await p.fleet.tick({ ...opts(p), preprepared: true });
}

test('a disconnected warm box books only unclaimed runnable work', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.dispatchOnly = true;
  cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, registeredHoldSeconds: 180 };
  const ledger = new AccountLedger(new Storage(), { margin: 0 }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, [], [{ id: 1, queuedAt: 1 }, { id: 2, queuedAt: 2 }]);
  p.fleet.getLocalCapacity = () => ({ at: clock.now, offers: 0, reasons: { per_mini_slots: 1 } });
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  for (const id of [1, 2]) await p.storage.put(`box:${id}`, { machineId: String(id), pool, state: 'ready', since: clock.now, generation: 0, createdAt: 10, bootDoneObservedAt: 20, timing: { ready: 30 } });
  await p.storage.put('local-runner:one', { host: 'mini-3', label: 'work-large', jobId: 1, state: 'started', at: clock.now - 10, startedAt: clock.now - 5 });
  assert.equal((await p.fleet.reserveReady('1')).dispatchJobId, 2);
  assert.equal((await p.storage.get('placement:2')).reason, 'per_mini_slots');
  const placement = await p.storage.get('placement:2');
  assert.deepEqual([placement.boxCreatedAt, placement.bootDoneObservedAt, placement.boxReadyAt, placement.at], [10, 20, 30, clock.now]);
  assert.equal(await p.fleet.reserveReady('2'), null);
  // If GitHub assigns the first runner a different equivalent job, that
  // runner's reservation is consumed and its former job can be booked.
  await p.storage.put('box:1', { ...(await p.storage.get('box:1')), state: 'busy' });
  assert.equal((await p.fleet.reserveReady('2')).dispatchJobId, 2);
});

test('a ready box does not connect without a queued job', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha'); cfg.dispatchOnly = true;
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], []);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:1', { machineId: '1', pool, state: 'ready', since: clock.now, generation: 0 });
  let registrations = 0; p.fleet.api.configure = async () => { registrations++; };
  await p.fleet.stepBox('1', { complete: true, runners: [], jobs: [] });
  assert.equal(registrations, 0);
  assert.equal((await p.storage.get('box:1')).state, 'ready');
});

test('a legacy box uses its conservative TTL before accepting a new job', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.dispatchOnly = true; cfg.machineTtlSeconds = 43200;
  cfg.jobs = { build: { timeoutMinutes: 60 } }; cfg.reuse = { mode: 'on', idleHoldSeconds: 900 };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: clock.now - 1000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:one', { machineId: 'one', pool, state: 'ready', since: clock.now, createdAt: clock.now - 2_400_000, generation: 1, reusable: true, baselineHash: 'ok', runnerFenced: true });
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, preprepared: true });
  assert.equal((await p.storage.get('box:one')).retirementReason, 'ttl_headroom');
});

test('finished boxes with an old provisioner retire before reset', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.provisionerFingerprint = 'current';
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], []);
  await p.storage.put('box:one', { machineId: 'one', state: 'finished', since: clock.now, generation: 0, reusable: true, baselineHash: 'ok', provisionerFingerprint: 'old' });
  let resets = 0; p.fleet.api.lightReset = async () => { resets++; };
  await p.fleet.stepBox('one', { complete: true, runners: [], jobs: [] }, { reuseEnabled: true });
  assert.equal((await p.storage.get('box:one')).retirementReason, 'provisioner_changed');
  assert.equal(resets, 0);
  await p.storage.put('box:one', { machineId: 'one', state: 'finished', since: clock.now, generation: 0, reusable: true, baselineHash: 'ok', provisionerFingerprint: 'current' });
  p.fleet.api.lightReset = async () => { resets++; return { processId: 42 }; };
  await p.fleet.stepBox('one', { complete: true, runners: [], jobs: [] }, { reuseEnabled: true });
  assert.equal((await p.storage.get('box:one')).state, 'resetting');
  assert.equal(resets, 1);
});

test('surplus ready boxes retire after the hold even while another job is queued', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.dispatchOnly = true;
  cfg.machineTtlSeconds = 86400;
  cfg.reuse = { mode: 'on', idleHoldSeconds: 900, holdPolicy: { enabled: false } };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: clock.now - 1000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  for (const id of ['one', 'two']) await p.storage.put(`box:${id}`, { machineId: id, pool, state: 'ready', since: clock.now - 900_000, createdAt: clock.now - 1_000_000, generation: 1, reusable: true, baselineHash: 'ok', runnerFenced: true });
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, preprepared: true });
  const boxes = [...(await p.storage.list({ prefix: 'box:' })).values()];
  assert.equal(boxes.filter(box => box.state === 'destroying' && box.retirementReason === 'idle_hold_expired').length, 1);
});

test('ready idle box uses the scarcity hold and reports an overdue sample', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.dispatchOnly = true; cfg.machineTtlSeconds = 86400; cfg.reuse = { mode: 'on', idleHoldSeconds: 900, holdPolicy: { enabled: false } };
  const ledger = new AccountLedger(new Storage(), {}, () => clock.now);
  await ledger.storage.put(ledger.key, { pacingStatus: { sampledAt: clock.now, effectiveStartsPerHour: 1 } });
  const p = await setupProject(cfg, ledger, clock, [], []);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:one', { machineId: 'one', pool, state: 'ready', since: clock.now - 900_000, createdAt: clock.now - 1_000_000, reusable: true, baselineHash: 'ok', runnerFenced: true });
  const account = { reuse: { enabled: true }, poolPacing: { enabled: true, mode: 'dynamic' } };
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account, project: cfg, preprepared: true };
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('box:one')).state, 'ready');
  clock.now += 2_701_000;
  await ledger.storage.put(ledger.key, { pacingStatus: { sampledAt: clock.now, effectiveStartsPerHour: 1 } });
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('pool:status:work-large')).idleBoxesOverHold, 1);
  assert.equal((await p.storage.get('box:one')).retirementReason, 'idle_hold_expired');
});

test('a new large job cancels a small reservation before the large box registers', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha'); cfg.dispatchOnly = true;
  cfg.labels.push('work-default'); cfg.sizes['work-default'] = { machine: 'default' };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: clock.now - 1000 }]);
  const large = JSON.stringify([cfg.repo, 'work-large']), small = JSON.stringify([cfg.repo, 'work-default']);
  await p.storage.put('gh-job:2', { id: 2, pool: small, status: 'queued', queuedAt: clock.now - 2000 });
  await p.storage.put('box:one', { machineId: 'one', pool: small, originPool: large, size: 'large', state: 'ready', since: clock.now, generation: 1 });
  let registrations = 0; p.fleet.api.configure = async () => { registrations++; };
  await p.fleet.stepBox('one', { complete: true, runners: [], jobs: [] });
  const box = await p.storage.get('box:one');
  assert.equal(registrations, 0); assert.equal(box.pool, large); assert.equal(box.dispatchJobId, null);
});

test('an incomplete snapshot permits only bounded, individually confirmed dispatch', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha'); cfg.dispatchOnly = true;
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: 1 }, { id: 2, queuedAt: 2 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('pool:snapshot', { complete: false });
  await p.storage.put('pool:snapshot-hold:work-large', { since: clock.now });
  for (const id of [1, 2]) await p.storage.put(`box:${id}`, { machineId: String(id), pool, state: 'ready', since: clock.now });
  let checks = 0; p.fleet.api.getJob = async (_job, id) => { checks++; return { id, status: 'queued', runner_name: null }; };
  assert.equal(await p.fleet.reserveReady('1'), null); assert.equal(checks, 0);
  clock.now += 180_000;
  assert.equal((await p.fleet.reserveReady('1')).dispatchJobId, 1);
  assert.equal(await p.fleet.reserveReady('2'), null);
});

test('an unreserved connected Boat runner is fenced, and a reserved runner expires after three minutes', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha'); cfg.dispatchOnly = true;
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: 1 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [{ id: 7, name: 'boat-test', status: 'online', busy: false }] });
  await p.storage.put('box:one', { machineId: 'one', pool, state: 'idle', since: clock.now, runnerId: 7, runnerName: 'boat-test', createdAt: clock.now });
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account: {}, project: cfg, preprepared: true };
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('box:one')).state, 'local-fencing');
  await p.storage.put('box:one', { ...(await p.storage.get('box:one')), state: 'idle', dispatchJobId: 1, dispatchAt: clock.now });
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('box:one')).state, 'idle');
  clock.now += 180_000;
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('box:one')).state, 'local-fencing');
});

test('registered local claim fences only one warm runner and leaves excess demand runnable', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha');
  cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, registeredHoldSeconds: 180 };
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, [{ id: 1, queuedAt: clock.now - 1000 }, { id: 2, queuedAt: clock.now - 1000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  const runners = [7, 8].map(id => ({ id, name: `boat-${id}`, status: 'online', busy: false }));
  await p.storage.put('pool:snapshot', { at: clock.now, complete: true, runners });
  for (const id of [7, 8]) await p.storage.put(`box:bx_2345678${id}`, { machineId: `bx_2345678${id}`, pool, state: 'idle', runnerId: id, runnerName: `boat-${id}`, reusable: true, baselineHash: 'a'.repeat(64), createdAt: clock.now - 1000, since: clock.now, everOnline: true });
  await p.storage.put('local-runner:local-one', { name: 'local-one', label: 'work-large', jobId: 1, host: 'mini-1', state: 'started', at: clock.now - 40_000, startedAt: clock.now - 35_000 });
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, preprepared: true });
  const boxes = [...(await p.storage.list({ prefix: 'box:' })).values()];
  assert.equal(boxes.filter(box => box.state === 'local-fencing').length, 1);
  assert.equal(boxes.filter(box => box.state === 'idle').length, 1);
});

test('idle mini capacity does not block a ready Boat box', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha');
  cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, capacitySeconds: 90 };
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, [{ id: 1, queuedAt: 1 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('local-room:work-large', clock.now);
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool, state: 'ready', since: clock.now, generation: 0 });
  let registered = 0;
  p.fleet.api.configure = async (_box, save) => { registered++; await save(1); };
  p.fleet.api.start = async () => ({ success: true });
  await routerTick([p]);
  assert.equal(registered, 1);
  assert.equal(created.length, 0);
});

test('a fenced warm box is reset before it returns to Boat service', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha');
  cfg.reuse = { mode: 'on' };
  cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, holdWarmOnLocal: true, capacitySeconds: 90 };
  cfg.machineTtlSeconds = 86400;
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, [{ id: 1, queuedAt: clock.now - 31_000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool, originPool: pool, state: 'local-held', runnerFenced: true, runnerId: 1, generation: 0, createdAt: clock.now, since: clock.now, reusable: true, baselineHash: 'a'.repeat(64) });
  let resets = 0;
  p.fleet.api.lightReset = async () => { resets++; return { processId: 42 }; };
  const opts = { mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true }, waitForBusyBox: { enabled: true } }, project: cfg, preprepared: true };
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('box:bx_23456789')).state, 'finished');
  await p.fleet.tick(opts);
  assert.equal((await p.storage.get('box:bx_23456789')).state, 'resetting');
  assert.equal(resets, 1);
});

test('idle mini capacity does not fence a warm Boat runner', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha'); cfg.reuse = { mode: 'on' };
  cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, holdWarmOnLocal: true, offerSeconds: 90 };
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, []);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('local-room:work-large', clock.now);
  await p.storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [{ id: 1, name: 'warm', status: 'online', busy: false }] });
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool, originPool: pool, state: 'idle', runnerId: 1, runnerName: 'warm', generation: 0, createdAt: clock.now, since: clock.now, reusable: true, baselineHash: 'a'.repeat(64) });
  let removals = 0; p.fleet.api.removeRunner = async () => { removals++; };
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, preprepared: true });
  assert.equal((await p.storage.get('box:bx_23456789')).state, 'idle');
  assert.equal(removals, 0);
});

test('a ready Boat box registers immediately for unclaimed demand', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha'); cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, offerSeconds: 90 };
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, [{ id: 1, queuedAt: clock.now }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool, state: 'ready', since: clock.now, generation: 0 });
  let registered = 0; p.fleet.api.configure = async (_box, save) => { registered++; await save(1); }; p.fleet.api.start = async () => ({ success: true });
  await routerTick([p]); assert.equal(registered, 1);
});

test('a surplus fenced box releases its slot for another pool', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha');
  cfg.labels.push('work-default');
  cfg.sizes['work-default'] = { machine: 'default' };
  cfg.caps.concurrent = 1;
  cfg.localFirst = { enabled: true, labels: { 'work-large': 'generic' }, holdWarmOnLocal: true, offerSeconds: 90 };
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, []);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool, state: 'local-held', runnerFenced: true, reusable: true, baselineHash: 'a'.repeat(64), createdAt: clock.now - 120_000, since: clock.now - 120_000 });
  await p.storage.put('gh-job:1', { id: 1, pool: JSON.stringify([cfg.repo, 'work-default']), status: 'queued', queuedAt: clock.now - 120_000 });
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: {}, project: cfg, preprepared: true });
  assert.equal((await p.storage.get('box:bx_23456789')).state, 'destroying');
});

test('R1-B1: ten uncovered jobs with ample limits are all admitted in one router tick', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { id: 'account', margin: 0.05, requireConcurrency: true }, () => clock.now);
  const jobs = Array.from({ length: 10 }, (_, i) => ({ id: 1000 + i, queuedAt: 1_000_000 + i * 1000 }));
  const p = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, jobs);
  await routerTick([p]);
  const perTick = [created.length];
  for (let i = 0; i < 10 && created.length < 10; i++) { clock.now += 60_000; await routerTick([p]); perTick.push(created.length); }
  assert.equal(perTick[0], 10, `only ${perTick[0]} of 10 admitted in the first tick; ${perTick.length} ticks to reach ${created.length}`);
});



test('router admits interleaved projects in account FIFO order in one tick', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const a = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, Array.from({ length: 5 }, (_, i) => ({ id: 10 + i, queuedAt: i * 2 + 1 })));
  const b = await setupProject(project('beta', 'example/beta'), ledger, clock, created, Array.from({ length: 5 }, (_, i) => ({ id: 20 + i, queuedAt: i * 2 })));
  const suites = [a, b].map(p => ({ config: p.cfg, storage: p.storage,
    prepare: () => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, prepareOnly: true }),
    admissionEntries: () => p.fleet.admissionEntries(),
    admitStart: (key, ctx) => p.fleet.admitQueued(key, { mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preparationFailed: ctx.startPreparationFailed }),
    tick: ctx => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preprepared: true, skipAdmission: ctx.globalAdmission }) }));
  const router = { projects: new Map(suites.map(p => [p.config.id, p])), ledger, now: () => clock.now };
  const result = await Router.prototype.runTick.call(router);
  assert.ok(result.every(item => item.ok));
  assert.equal(created.length, 10);
  assert.deepEqual(created.map(item => JSON.parse(item.pool)[0]), Array.from({ length: 10 }, (_, i) => i % 2 ? 'example/alpha' : 'example/beta'));
});

test('ten ready sandboxes register and start in the second router tick', async () => {
  const clock = { now: 10_000_000 }, created = [], started = [];
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(project('sample', 'example/project'), ledger, clock, created,
    Array.from({ length: 10 }, (_, i) => ({ id: i + 1, queuedAt: clock.now + i })));
  p.fleet.api.sandbox = async () => ({ sandbox: { state: 'ready', setupStatus: 'done' } });
  p.fleet.api.configure = async (box, save) => { await save(created.findIndex(item => item.id === box.machineId) + 1); };
  p.fleet.api.start = async box => { started.push(box.machineId); return { success: true }; };
  await routerTick([p]);
  clock.now += 60_000;
  await routerTick([p]);
  assert.equal(created.length, 10);
  assert.equal(new Set(started).size, 10);
});

test('pool readback reports the daily admission limit and recovers when capacity returns', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(project('alpha', 'example/alpha'), ledger, clock, created, [{ id: 1, queuedAt: 1 }, { id: 2, queuedAt: 2 }]);
  let full = true;
  p.fleet.api.limits = async () => {
    const limits = limitsAt(clock.now);
    if (full) limits.starts.day = { limit: 10000, used: 10000, remaining: 0 };
    return limits;
  };
  const suite = { config: p.cfg, storage: p.storage,
    prepare: () => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, prepareOnly: true }),
    admissionEntries: () => p.fleet.admissionEntries(),
    admitStart: (key, ctx) => p.fleet.admitQueued(key, { mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preparationFailed: ctx.startPreparationFailed }),
    tick: ctx => p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, project: p.cfg, preprepared: true, skipAdmission: ctx.globalAdmission }) };
  const router = { projects: new Map([['alpha', suite]]), ledger, now: () => clock.now };
  await Router.prototype.runTick.call(router);
  assert.equal((await p.storage.get('pool:status:work-large')).reason, 'ledger:day_cap');
  assert.equal(created.length, 0);
  assert.equal((await ledger.storage.get('account:ledger')).waiting.length, 2);
  full = false;
  clock.now += 60_000;
  await Router.prototype.runTick.call(router);
  assert.equal(created.length, 2);
  assert.equal((await p.storage.get('pool:status:work-large')).reason, null);
});

test('a larger idle reusable box is fenced and retargeted for same-project demand', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha');
  cfg.labels.push('work-default'); cfg.sizes['work-default'] = { machine: 'default' }; cfg.reuse = { mode: 'on' }; cfg.caps.concurrent = 1;
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, []);
  const large = JSON.stringify([cfg.repo, 'work-large']), small = JSON.stringify([cfg.repo, 'work-default']);
  await p.storage.put('pool:snapshot', { at: clock.now, complete: true, runners: [{ id: 1, name: 'warm-large', status: 'online', busy: false }] });
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool: large, originPool: large, size: 'large', state: 'idle', runnerId: 1, runnerName: 'warm-large', generation: 0, createdAt: clock.now, since: clock.now, reusable: true, everOnline: true, baselineHash: 'a'.repeat(64) });
  await p.storage.put('gh-job:1', { id: 1, pool: small, status: 'queued', queuedAt: clock.now, source: 'webhook' });
  let fences = 0; const logs = []; p.fleet.logger = line => logs.push(JSON.parse(line)); p.fleet.api.removeRunner = async () => { fences++; };
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, prepareOnly: true });
  const box = await p.storage.get('box:bx_23456789');
  assert.equal(box.state, 'finished'); assert.equal(box.pool, small); assert.equal(box.runnerFenced, true);
  assert.equal(fences, 1); assert.equal(created.length, 0);
  assert.equal(logs.filter(entry => entry.event === 'cross_size_handoff').length, 1);
});

test('a ready large box records its handoff to default demand', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.dispatchOnly = true; cfg.reuse = { mode: 'on' };
  cfg.labels.push('work-default'); cfg.sizes['work-default'] = { machine: 'default' };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], []);
  const large = JSON.stringify([cfg.repo, 'work-large']), small = JSON.stringify([cfg.repo, 'work-default']);
  await p.storage.put('box:one', { machineId: 'one', pool: large, originPool: large, size: 'large', state: 'ready', since: clock.now, createdAt: clock.now, reusable: true, baselineHash: 'ok' });
  await p.storage.put('gh-job:1', { id: 1, pool: small, status: 'queued', queuedAt: clock.now, source: 'webhook' });
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, prepareOnly: true });
  const box = await p.storage.get('box:one');
  assert.equal(box.pool, small); assert.equal(box.crossSizeHandoffs, 1); assert.equal(box.lastCrossSizeAt, clock.now);
});

test('an uncertain old local fence does not hold uncovered demand', async () => {
  const clock = { now: 10_000_000 }, created = [];
  const cfg = project('alpha', 'example/alpha'); cfg.reuse = { mode: 'on' };
  const ledger = new AccountLedger(new Storage(), { margin: 0, requireConcurrency: true }, () => clock.now);
  const p = await setupProject(cfg, ledger, clock, created, [{ id: 1, queuedAt: clock.now }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:bx_23456789', { machineId: 'bx_23456789', pool, originPool: pool, state: 'local-fencing', runnerId: 1, runnerName: 'old', generation: 0, createdAt: clock.now, since: clock.now, reusable: true, baselineHash: 'a'.repeat(64) });
  p.fleet.api.removeRunner = async () => { throw new Error('unavailable'); };
  await routerTick([p]);
  assert.equal(created.length, 1);
  assert.equal((await p.storage.get('box:bx_23456789')).state, 'local-fencing');
});

test('placement evidence includes browser Git Pro admission failures', () => {
  const capacity = { at: 1000, offers: 0, reasons: { lease_browser_git_copy: 1, lease_launch_exit_98: 1 } };
  assert.deepEqual(placementEvidence(capacity, 2000).categories, ['browser_git_copy', 'lease_exit_98']);
});

test('an idle retirement cancels when a job landed after the demand snapshot', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.machineTtlSeconds = 86400; cfg.reuse = { mode: 'on', idleHoldSeconds: 900 };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: clock.now - 1000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:one', { machineId: 'one', pool, state: 'idle', since: clock.now - 900_000, onlineAt: clock.now - 900_000, createdAt: clock.now - 1_000_000, generation: 1, reusable: true, baselineHash: 'ok', runnerFenced: false, runnerId: 7, runnerName: 'boat-one' });
  // The snapshot this retirement was planned from saw no queued job.
  assert.equal(await p.fleet.retire('one', 'idle_hold_expired', { queuedSnapshot: 0 }), false);
  const box = await p.storage.get('box:one');
  assert.equal(box.state, 'idle');
  assert.equal(box.exitReason ?? null, null);
  assert.equal(box.history.at(-1).event, 'retire_cancel');
});

test('a retirement the snapshot already covered still fences the runner', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.machineTtlSeconds = 86400; cfg.reuse = { mode: 'on', idleHoldSeconds: 900 };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: clock.now - 1000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  p.fleet.api.removeRunner = async () => ({});
  await p.storage.put('box:one', { machineId: 'one', pool, state: 'idle', since: clock.now - 900_000, onlineAt: clock.now - 900_000, createdAt: clock.now - 1_000_000, generation: 1, reusable: true, baselineHash: 'ok', runnerFenced: false, runnerId: 7, runnerName: 'boat-one' });
  assert.equal(await p.fleet.retire('one', 'idle_hold_expired', { queuedSnapshot: 1 }), true);
  assert.equal((await p.storage.get('box:one')).state, 'destroying');
});

test('a retiring box comes back when the pool still wants a box and a job is queued', async () => {
  const clock = { now: 10_000_000 }, cfg = project('alpha', 'example/alpha');
  cfg.machineTtlSeconds = 86400; cfg.reuse = { mode: 'on', idleHoldSeconds: 900 };
  const p = await setupProject(cfg, new AccountLedger(new Storage(), {}, () => clock.now), clock, [], [{ id: 1, queuedAt: clock.now - 1000 }]);
  const pool = JSON.stringify([cfg.repo, 'work-large']);
  await p.storage.put('box:one', { machineId: 'one', pool, state: 'retiring', since: clock.now - 5000, createdAt: clock.now - 1_000_000, generation: 1, reusable: true, baselineHash: 'ok', runnerFenced: false, retirementReason: 'idle_hold_expired', runnerId: 7, runnerName: 'boat-one' });
  await p.fleet.tick({ mode: 'on', env: { ENABLED: 'true' }, account: { reuse: { enabled: true } }, project: cfg, preprepared: true });
  const box = await p.storage.get('box:one');
  assert.equal(box.state, 'idle');
  assert.equal(box.retirementReason, null);
  assert.equal(box.history.at(-1).event, 'retire_cancel');
  assert.equal((await p.storage.list({ prefix: 'create:' })).size, 0, 'the kept box covers the job instead of a new create');
});
