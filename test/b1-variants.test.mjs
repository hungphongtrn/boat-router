// Round-2 B1 variants. Run from the repo folder: node --test test/b1-variants.test.mjs
// A small GitHub simulator: an online, idle, never-used JIT runner gets the OLDEST queued job
// with its label (ephemeral: one job per runner). Jobs finish after their duration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, event } from './helpers.mjs';
import { runnerName } from '../src/domain.mjs';

function sim({ ids, boot = {}, duration = {}, brokenRunners = new Set(), failBoot = new Set(), maxSteps = 2000 }) {
  const f = fixture();
  const gh = new Map(ids.map(id => [id, { id, status: 'queued', runner_name: null, endAt: null }]));
  const bootAt = new Map(); // machineId -> time setup finishes
  const used = new Set();   // runner names that already took a job
  const log = [];
  const sync = id => f.fake.jobs.set(id, { id, status: gh.get(id).status, runner_name: gh.get(id).runner_name });
  async function world() {
    // Machines finish booting.
    for (const [mid, m] of f.fake.machines) {
      if (!bootAt.has(mid)) {
        const owner = [...f.storage.data].find(([k, v]) => k.startsWith('job:') && v.machineId === mid)?.[1];
        bootAt.set(mid, f.now() + (boot[owner?.id] ?? 0));
      }
      m.setupStatus = failBoot.has(mid) ? 'failed' : f.now() >= bootAt.get(mid) ? 'done' : 'running';
    }
    // Online runners pick the oldest queued job.
    for (const [k, rec] of [...f.storage.data]) {
      if (!k.startsWith('job:') || rec.phase !== 'running' || !rec.runnerId) continue;
      const name = runnerName(rec.id, rec.generation);
      if (used.has(name) || brokenRunners.has(name) || !f.fake.machines.has(rec.machineId)) continue;
      const next = [...gh.values()].filter(j => j.status === 'queued').sort((a, b) => a.id - b.id)[0];
      if (!next) continue;
      used.add(name); next.status = 'in_progress'; next.runner_name = name; next.endAt = f.now() + (duration[next.id] ?? 60_000);
      const r = f.fake.runners.get(rec.runnerId); if (r) r.busy = true;
      sync(next.id); log.push(`${f.now()} ${next.id} -> ${name}`);
      await f.controller.ingest(event(next.id, 'boat-default', 'in_progress', name));
    }
    // Jobs complete.
    for (const j of gh.values()) {
      if (j.status !== 'in_progress' || f.now() < j.endAt) continue;
      j.status = 'completed'; sync(j.id); log.push(`${f.now()} ${j.id} done`);
      for (const r of f.fake.runners.values()) if (r.name === j.runner_name) r.busy = false;
      await f.controller.ingest(event(j.id, 'boat-default', 'completed', j.runner_name));
    }
  }
  let started = false;
  async function run(steps = 2000) {
    if (!started) { started = true; for (const id of ids) await f.controller.ingest(event(id)); }
    for (let i = 0; i < Math.min(steps, maxSteps); i++) {
      f.clock.time += 15_000; await f.controller.tick(); await world();
      const open = [...f.storage.data.keys()].filter(k => k.startsWith('due:')).length;
      if (open === 0 && [...gh.values()].every(j => j.status === 'completed')) break;
    }
    const state = {
      github: Object.fromEntries([...gh].map(([id, j]) => [id, `${j.status}@${j.runner_name}`])),
      records: Object.fromEntries(ids.map(id => [id, f.storage.data.get(`job:${id}`)?.phase])),
      starts: f.fake.starts, liveMachines: [...f.fake.machines.keys()], dueKeys: [...f.storage.data.keys()].filter(k => k.startsWith('due:')),
      alerts: (f.storage.data.get('alerts') ?? []).map(a => `${a.event}:${a.job_id ?? ''}`), log,
    };
    return { f, gh, state };
  }
  return { f, gh, run, failBoot, ids };
}
const settled = (state) => {
  console.log(JSON.stringify(state));
  for (const [id, s] of Object.entries(state.github)) assert.match(s, /^completed@/, `GitHub job ${id} never ran: ${JSON.stringify(state)}`);
  assert.deepEqual(state.liveMachines, [], `machine leaked: ${JSON.stringify(state)}`);
  assert.deepEqual(state.dueKeys, [], `records still active: ${JSON.stringify(state)}`);
};

test('V1: three-job reverse chain (103 fast, 102 medium, 101 slow; 101 short)', async () => {
  const { run } = sim({ ids: [101, 102, 103], boot: { 101: 10 * 60_000, 102: 5 * 60_000, 103: 0 },
    duration: { 101: 30_000, 102: 20 * 60_000, 103: 5 * 60_000 } });
  const { state } = await run(); settled(state);
  assert.equal(state.starts, 3, 'no replacement should be needed when every machine serves some job');
});

test('V1b: four jobs, all reverse (machines ready newest-first)', async () => {
  const { run } = sim({ ids: [101, 102, 103, 104], boot: { 101: 12 * 60_000, 102: 8 * 60_000, 103: 4 * 60_000, 104: 0 },
    duration: { 101: 30_000, 102: 30_000, 103: 30_000, 104: 30_000 } });
  const { state } = await run(); settled(state);
});

test('V2: intended job cancelled while its machine is mid-setup, then cleanup completes', async () => {
  const { f, gh, run } = sim({ ids: [101], boot: { 101: 8 * 60_000 } });
  await run(1); // ingest + one tick: machine created and booting
  gh.get(101).status = 'completed'; f.fake.jobs.set(101, { id: 101, status: 'completed', runner_name: null });
  await f.controller.ingest(event(101, 'boat-default', 'completed'));
  const { state } = await run(); // continue
  settled(state);
  const destroyAt = f.logs.map(l => JSON.parse(l)).find(e => e.event === 'destroy');
  console.log('destroy event', JSON.stringify(destroyAt));
});

test('V3: 101 runs on j102 while m101 boots; cancel 102 retires the spare m101', async () => {
  const { f, gh, run } = sim({ ids: [101, 102], boot: { 101: 10 * 60_000, 102: 0 }, duration: { 101: 30_000 } });
  await run(12);
  assert.equal(gh.get(101).runner_name, 'boat-ci-j102');
  gh.get(102).status = 'completed'; f.fake.jobs.set(102, { id: 102, status: 'completed', runner_name: null });
  await f.controller.ingest(event(102, 'boat-default', 'completed'));
  const machine = f.storage.data.get('job:101').machineId;
  await run(1); assert.ok(f.fake.deletes.includes(machine), 'cancellation must retire the newly unneeded machine');
  const { state } = await run(); settled(state);
  assert.ok(!state.alerts.some(a => a.startsWith('alert_assignment_timeout:101')));
});

test('V4: 101 runs on j102; runner j101 never takes work (broken); timeout fires; 102 still gets a runner', async () => {
  const { run } = sim({ ids: [101, 102], boot: { 101: 10 * 60_000, 102: 0 }, duration: { 101: 30_000, 102: 60_000 },
    brokenRunners: new Set(['boat-ci-j101']) });
  const { state } = await run(); settled(state);
  assert.equal(state.github[102], 'completed@boat-ci-j102-g1');
});

test('V5 (latency, not a leak): 102 replacement waits on a NEW job\'s booting machine, so 103 is serialized behind 102', async () => {
  const { f, gh, run, failBoot, ids } = sim({ ids: [101, 102], boot: { 101: 5 * 60_000, 102: 0, 103: 3 * 60_000 },
    duration: { 101: 20 * 60_000, 102: 20 * 60_000, 103: 60_000 } });
  await run(2); failBoot.add(f.storage.data.get('job:101').machineId); // m101 bootstrap fails; 101 runs on j102
  await run(70); // ~17.5 min: 101 still running on j102
  ids.push(103); gh.set(103, { id: 103, status: 'queued', runner_name: null, endAt: null });
  await f.controller.ingest(event(103));
  const { state } = await run(); settled(state);
  const t = s => Number(state.log.find(l => l.includes(s)).split(' ')[0]);
  console.log('103 queued minutes:', (t('103 ->') - t('101 ->') - 70 * 15_000) / 60_000, 'starts', state.starts);
});

test('R1: cancel during boot retires the machine on the next reconciliation', async () => {
  const { f, gh, run } = sim({ ids: [101], boot: { 101: 8 * 60_000 } });
  await run(1); const machine = f.storage.data.get('job:101').machineId; const cancelledAt = f.now();
  gh.get(101).status = 'completed'; f.fake.jobs.set(101, { id: 101, status: 'completed', conclusion: 'cancelled', runner_name: null });
  await f.controller.ingest(event(101, 'boat-default', 'completed')); await run(1);
  assert.deepEqual(f.fake.deletes, [machine]); assert.equal(f.fake.machines.size, 0);
  assert.equal(f.now() - cancelledAt, 15_000);
  const { state } = await run(); settled(state); assert.equal(state.starts, 1);
  assert.equal(f.fake.runners.size, 0); assert.ok(!state.alerts.some(a => a.startsWith('alert_assignment_timeout')));
});

test("R2: replacement starts beside a new job's machine when both jobs need capacity", async () => {
  const { f, gh, run, failBoot, ids } = sim({ ids: [101, 102], boot: { 101: 5 * 60_000, 103: 10 * 60_000 },
    duration: { 101: 20 * 60_000, 102: 20 * 60_000, 103: 60_000 } });
  await run(2); failBoot.add(f.storage.data.get('job:101').machineId); await run(70);
  ids.push(103); gh.set(103, { id: 103, status: 'queued', runner_name: null, endAt: null });
  const queuedAt = f.now(); await f.controller.ingest(event(103)); await run(20);
  assert.equal(gh.get(102).status, 'in_progress'); assert.equal(gh.get(102).runner_name, 'boat-ci-j102-g1');
  const { state } = await run(); settled(state); assert.equal(f.fake.runners.size, 0);
  const assignedAt = Number(state.log.find(line => line.includes('103 ->')).split(' ')[0]);
  assert.ok(assignedAt - queuedAt <= 15 * 60_000, ' must not wait for  to finish');
});

test('R3: a busy runner survives surplus retirement while its assignment webhook is delayed', async () => {
  const { f, gh, run } = sim({ ids: [101, 102], boot: { 101: 2 * 60_000 }, duration: { 101: 30_000 },
    brokenRunners: new Set(['boat-ci-j101']) });
  await run(16);
  const owner = f.storage.data.get('job:101'); assert.equal(owner.phase, 'running');
  gh.get(102).status = 'in_progress'; gh.get(102).runner_name = 'boat-ci-j101'; gh.get(102).endAt = f.now() + 2 * 60_000;
  f.fake.jobs.set(102, { id: 102, status: 'in_progress', runner_name: 'boat-ci-j101' });
  f.fake.runners.get(owner.runnerId).busy = true; await run(5);
  assert.ok(f.fake.machines.has(owner.machineId), 'unknown busy work must survive the finished intent');
  assert.equal(gh.get(102).status, 'in_progress');
  const { state } = await run(); settled(state); assert.equal(state.starts, 2); assert.equal(f.fake.runners.size, 0);
});

test('R4: cancelling one job retires its machine when the other queued job already has capacity', async () => {
  const { f, gh, run } = sim({ ids: [101, 102], boot: { 101: 8 * 60_000, 102: 8 * 60_000 } });
  await run(1); const first = f.storage.data.get('job:101').machineId; const second = f.storage.data.get('job:102').machineId;
  gh.get(101).status = 'completed'; f.fake.jobs.set(101, { id: 101, status: 'completed', runner_name: null });
  await f.controller.ingest(event(101, 'boat-default', 'completed')); await run(1);
  assert.deepEqual(f.fake.deletes, [first]); assert.ok(f.fake.machines.has(second));
  const { state } = await run(); settled(state); assert.equal(state.starts, 2); assert.equal(f.fake.runners.size, 0);
});

for (const [scope, other] of [
  ['repository', { ...event(102), repo: 'example-owner/project-c', installation: 2 }],
  ['size', event(102, 'boat-large')],
]) {
  test(`R5: cancellation ignores queued demand in a different ${scope}`, async () => {
    const f = fixture(); f.env.MAX_ACTIVE = '1'; await f.controller.ingest(event()); await f.controller.tick();
    const machine = f.storage.data.get('job:101').machineId;
    await f.controller.ingest(other); await f.controller.ingest(event(101, 'boat-default', 'completed')); await f.controller.tick();
    assert.deepEqual(f.fake.deletes, [machine]); await f.pump(12);
    assert.equal(f.fake.starts, 2); assert.equal(f.storage.data.get('job:102').phase, 'running');
    f.fake.jobs.set(102, { id: 102, status: 'completed', runner_name: 'boat-ci-j102' });
    await f.controller.ingest({ ...other, status: 'completed', runnerName: 'boat-ci-j102' }); await f.pump();
    assert.equal(f.fake.machines.size, 0); assert.equal(f.fake.runners.size, 0);
    assert.equal(f.storage.data.get('job:101').phase, 'done'); assert.equal(f.storage.data.get('job:102').phase, 'done');
    assert.equal((await f.storage.list({ prefix: 'due:' })).size, 0);
  });
}

test('R6: known cancellation cleans up during a GitHub job-status outage', async () => {
  const f = fixture(); await f.controller.ingest(event()); await f.controller.tick();
  const machine = f.storage.data.get('job:101').machineId;
  f.clock.time += 60_000; f.fake.jobOutage = true;
  f.fake.jobs.set(101, { id: 101, status: 'completed', conclusion: 'cancelled' });
  await f.controller.ingest(event(101, 'boat-default', 'completed')); await f.controller.tick();
  assert.deepEqual(f.fake.deletes, [machine]); await f.pump();
  assert.equal(f.storage.data.get('job:101').phase, 'done');
  assert.equal(f.fake.machines.size, 0); assert.equal(f.fake.runners.size, 0);
});

test('R7: queued demand beyond the first active-record page preserves needed capacity', async () => {
  const f = fixture(); f.env.MAX_ACTIVE = '1'; await f.controller.ingest(event()); await f.controller.tick();
  const machine = f.storage.data.get('job:101').machineId;
  for (let id = 200; id < 330; id++) await f.controller.ingest(event(id, 'boat-large'));
  await f.controller.ingest(event(999)); await f.controller.ingest(event(101, 'boat-default', 'completed')); await f.controller.tick();
  assert.ok(f.fake.machines.has(machine), 'same-size demand on the next page must retain the machine');
  assert.equal(f.fake.starts, 1);
  for (let id = 200; id < 330; id++) await f.controller.ingest(event(id, 'boat-large', 'completed'));
  await f.controller.ingest(event(999, 'boat-default', 'completed', 'boat-ci-j101')); await f.pump(60, 5000);
  assert.equal(f.fake.machines.size, 0); assert.equal(f.fake.runners.size, 0); assert.equal(f.fake.starts, 1);
  assert.equal((await f.storage.list({ prefix: 'due:' })).size, 0);
  assert.ok([101,999,...Array.from({ length: 130 }, (_, i) => 200 + i)].every(id => f.storage.data.get(`job:${id}`).phase === 'done'));
});
