import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';
import { rejectedRegistrationAbsent, registrationRejected } from '../src/router/registration-recovery.mjs';
import { observeRouterStall, STALL_MS } from '../src/router/stall-alarm.mjs';

test('two definitively rejected registrations release quarantined slots through normal cleanup', async () => {
  const storage = new Storage(), now = () => 200_000;
  const project = { id: 'peek', repo: 'hungphongtrn/peek', caps: { concurrent: 2 } };
  const fleet = new BoxFleet(storage, { sandbox: async () => ({ sandbox: { state: 'idle' } }), destroy: async () => ({ operation: { id: 'op' } }), deletion: async () => ({ operation: { status: 'completed' } }) }, now, { project });
  for (const id of ['bx_23456789', 'bx_3456789a']) {
    const runnerName = `boat-peek-${id}-g10`;
    await storage.put(`box:${id}`, { machineId: id, state: 'quarantined', generation: 10, runnerName, runnerId: null, since: 0, failureReason: 'registration_uncertain' });
    await storage.put(`verification:attempt:failure:${id}:10`, { at: 0, kind: 'registration_uncertain', phase: 'registering', message: JSON.stringify({ step: 're-register runner', service: 'github', status: 403 }) });
  }
  assert.equal(await fleet.concurrentCapReached(project), true);
  const snapshot = { complete: true, at: now(), runners: [], jobs: [] };
  for (const id of ['bx_23456789', 'bx_3456789a']) {
    await fleet.stepBox(id, snapshot);
    assert.equal((await storage.get(`box:${id}`)).state, 'destroying', 'fresh absence after a definite rejection must not wait one hour');
    await fleet.stepBox(id, snapshot);
    await fleet.stepBox(id, snapshot);
  }
  assert.equal(await fleet.concurrentCapReached(project), false);
});

test('ambiguous failures, saved runners, stale/incomplete snapshots and running jobs keep quarantine', async () => {
  const box = { machineId: 'bx_23456789', runnerName: 'runner', runnerId: null, since: 0, generation: 10, failureReason: 'registration_uncertain', registrationRejected: true };
  const snapshot = { complete: true, at: 200_000, runners: [], jobs: [] };
  for (const changes of [{ runnerId: 1 }, { orphan: true }, { since: 199_000 }, { registrationRejected: false }]) assert.equal(await rejectedRegistrationAbsent(new Storage(), { ...box, ...changes }, snapshot, 200_000), false);
  for (const changes of [{ complete: false }, { at: -1 }, { at: undefined }, { runners: [{ name: 'runner', busy: false }] }, { jobs: [{ runnerName: 'runner', status: 'in_progress' }] }]) assert.equal(await rejectedRegistrationAbsent(new Storage(), box, { ...snapshot, ...changes }, 200_000), false);
  for (const status of [0, 408, 409, 429, 500, 502]) assert.equal(registrationRejected({ service: 'github', status }, box), false);
  assert.equal(registrationRejected({ service: 'boat', status: 403 }, box), false);
  assert.equal(registrationRejected({ service: 'github', status: 403 }, { ...box, runnerId: 1 }), false);
});

test('stall alarm logs after 15 minutes, survives reload, throttles, and resets on capacity', async () => {
  const storage = new Storage(), logs = [], pool = 'pool';
  const input = { project: 'peek', pool, demand: 15, boxes: [{ pool, state: 'quarantined' }, { pool, state: 'quarantined' }], creates: [], enabled: true, logger: value => logs.push(JSON.parse(value)) };
  await observeRouterStall(storage, { ...input, now: 0 });
  await observeRouterStall(storage, { ...input, now: STALL_MS - 1 });
  assert.equal(logs.length, 0);
  await observeRouterStall(storage, { ...input, now: STALL_MS });
  assert.equal(logs[0].event, 'router_stalled');
  assert.equal(logs[0].occupiedBoxes, 2);
  assert.equal(logs[0].liveBoxes, 0);
  await observeRouterStall(storage, { ...input, now: STALL_MS + 1 });
  assert.equal(logs.length, 1);
  await observeRouterStall(storage, { ...input, now: 2 * STALL_MS });
  assert.equal(logs.length, 2);
  await observeRouterStall(storage, { ...input, now: 2 * STALL_MS + 1, boxes: [{ pool, state: 'busy' }] });
  assert.equal(await storage.get(`pool:stall:${pool}`), undefined);
  await observeRouterStall(storage, { ...input, now: 3 * STALL_MS, demand: 0 });
  assert.equal(await storage.get(`pool:stall:${pool}`), undefined);
});
