import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { FleetController } from '../src/fleet.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { Router } from '../src/router/core.mjs';
import { observe } from '../src/router/pool-observations.mjs';

async function setup() {
  const clock = { now: 10_000_000 }, created = [];
  const ledger = new AccountLedger(new Storage(), { id: 'account', margin: 0, requireConcurrency: true }, () => clock.now);
  const suites = [];
  for (const id of ['held', 'healthy']) {
    const cfg = { id, repo: `example/${id}`, account: 'account', labels: ['work'], sizes: { work: { machine: 'large' } }, caps: {}, reuse: { mode: 'off' } };
    const storage = new Storage(), env = { ENABLED: 'true' };
    await storage.put('pool:migrated', { done: true });
    await storage.put('pool:snapshot', { at: clock.now, complete: id === 'healthy', runners: [] });
    await observe(storage, { id: 1, repo: cfg.repo, label: 'work', status: 'queued', queuedAt: clock.now - 60_000 }, clock.now - 60_000);
    const api = {
      limits: async () => ({ canStart: true, observedAt: clock.now, activeSandboxes: created.length, maxActiveSandboxes: 20,
        startLimits: { perMinute: 100, perHour: 1000, perDay: 10000 },
        starts: { minute: { limit: 100, used: 0, remaining: 100 }, hour: { limit: 1000, used: 0, remaining: 1000 }, day: { limit: 10000, used: 0, remaining: 10000 } }, machineTypes: [{ type: 'large', available: true }] }),
      create: async unit => { created.push(unit.pool); return { sandbox: { id: 'bx_22222222' } }; },
      sandbox: async () => ({ sandbox: { state: 'ready', setupStatus: 'done' } }),
      configure: async (_box, save) => save(1), start: async () => ({ success: true }),
    };
    const controller = new FleetController(storage, {}, {}, () => clock.now, () => {});
    const fleet = new BoxFleet(storage, api, () => clock.now, { budget: new SharedBudget(ledger, id, () => clock.now), project: cfg, installation: 1, emit: controller.emit.bind(controller) });
    const opts = { mode: 'on', env, project: cfg };
    suites.push({ config: cfg, storage, fleet,
      prepare: () => fleet.tick({ ...opts, prepareOnly: true }), admissionEntries: () => fleet.admissionEntries(),
      admitStart: (key, ctx) => fleet.admitQueued(key, { ...opts, preparationFailed: ctx.startPreparationFailed }),
      tick: ctx => fleet.tick({ ...opts, preprepared: true, preparationFailed: ctx.startPreparationFailed, skipAdmission: ctx.globalAdmission }) });
  }
  return { clock, created, suites, router: { projects: new Map(suites.map(s => [s.config.id, s])), ledger, now: () => clock.now } };
}

test('incomplete snapshot holds stale demand for 40 minutes while another pool admits', async () => {
  const { clock, created, suites, router } = await setup();
  const [held, healthy] = suites;
  await held.fleet.prepare(JSON.stringify([held.config.repo, 'work']), 'large', 1, clock.now - 120_000);
  for (let i = 0; i < 40; i++) {
    assert.ok((await Router.prototype.runTick.call(router)).every(result => result.ok));
    if (i === 0) await observe(healthy.storage, { id: 1, repo: healthy.config.repo, label: 'work', status: 'in_progress' }, clock.now);
    clock.now += 60_000;
  }
  assert.equal(created.filter(pool => pool === JSON.stringify([held.config.repo, 'work'])).length, 0);
  assert.equal(created.filter(pool => pool === JSON.stringify([healthy.config.repo, 'work'])).length, 1);
  assert.equal((await held.storage.get('pool:status:work')).reason, 'snapshot_incomplete');
});

test('snapshot hold alerts once after five minutes and resets on recovery', async () => {
  const { clock, suites, router } = await setup(), held = suites[0];
  for (let i = 0; i <= 5; i++) { await Router.prototype.runTick.call(router); clock.now += 60_000; }
  assert.equal((await held.storage.get('alerts') ?? []).length, 0);
  await Router.prototype.runTick.call(router);
  clock.now += 60_000;
  await Router.prototype.runTick.call(router);
  assert.deepEqual((await held.storage.get('alerts')).map(a => [a.event, a.pool]), [['alert_snapshot_incomplete', JSON.stringify([held.config.repo, 'work'])]]);
  await held.storage.put('pool:snapshot', { complete: true, runners: [] });
  await Router.prototype.runTick.call(router);
  await held.storage.put('pool:snapshot', { complete: false });
  await Router.prototype.runTick.call(router);
  clock.now += 301_000;
  await Router.prototype.runTick.call(router);
  assert.equal((await held.storage.get('alerts')).length, 2);
});
