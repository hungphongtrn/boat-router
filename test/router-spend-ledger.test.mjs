import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import worker from '../src/worker.mjs';
import { Fleet } from '../src/fleet.mjs';
import { AccountLedger } from '../src/router/ledger.mjs';
import { SharedBudget } from '../src/router/shared-budget.mjs';
import { admissionReadiness, normalizeSpendPolicy, spendAmount, SPEND_WINDOW_MS } from '../src/router/spend-ledger.mjs';

const spend = {
  monthlyUsd: 20,
  machineHourUsd: { small: 0.018, default: 0.036, large: 0.072, xlarge: 0.2 },
  snapshotDayUsd: 0.056,
  snapshotRetentionDays: 30,
};
const policy = { starts: { minute: 12, hour: 60, day: 260 }, spend };
const limits = now => ({
  observedAt: now, canStart: true, nextStartDollars: 0, overagePrices: { vmHourDollars: 0.036 },
  startLimits: { perMinute: 12, perHour: 60, perDay: 260 },
  starts: Object.fromEntries(['minute', 'hour', 'day'].map(name => [name, { limit: { minute: 12, hour: 60, day: 260 }[name], used: 0, remaining: { minute: 12, hour: 60, day: 260 }[name] }])),
});

test('the tariff is per size and the ceiling covers one reservation', () => {
  const normalized = normalizeSpendPolicy(spend);
  assert.equal(spendAmount(normalized, { kind: 'machine', size: 'default', ttlSeconds: 7200 }), 0.072);
  assert.equal(spendAmount(normalized, { kind: 'machine', size: 'large', ttlSeconds: 7200 }), 0.144);
  assert.equal(spendAmount(normalized, { kind: 'machine', size: 'small', ttlSeconds: 7200 }), 0.036);
  assert.equal(spendAmount(normalized, { kind: 'storage', days: 30 }), 1.68);
});

test('the $20 ceiling refuses a maximum-lifetime reservation and admits parallel starts once', async () => {
  const now = () => 1_000_000, storage = new Storage();
  const ledger = new AccountLedger(storage, policy, now);
  const day = await ledger.reserveSpend('project-a', 'month', { kind: 'machine', size: 'default', ttlSeconds: 30 * 86_400 });
  assert.equal(day.ok, false);
  assert.equal(day.reason, 'spend_budget');

  const results = await Promise.all(Array.from({ length: 80 }, (_, index) =>
    ledger.reserveSpend('project-a', `parallel-${index}`, { kind: 'machine', size: 'default', ttlSeconds: 28800 })));
  const admitted = results.filter(result => result.ok);
  assert.equal(admitted.length, Math.floor(20 / 0.288));
  assert.ok(results.filter(result => !result.ok).every(result => result.reason === 'spend_budget'));
  const status = await ledger.spendStatus();
  assert.ok(status.spentUsd <= 20);
  assert.equal(new Set(admitted.map(result => result.amountUsd)).size, 1);
});

test('a retried key is idempotent, and a missing cost or quote refuses admission', async () => {
  const now = () => 1_000_000, storage = new Storage();
  const ledger = new AccountLedger(storage, policy, now);
  const first = await ledger.reserveSpend('project-a', 'same', { kind: 'machine', size: 'default', ttlSeconds: 7200 });
  const again = await ledger.reserveSpend('project-a', 'same', { kind: 'machine', size: 'default', ttlSeconds: 7200 });
  assert.equal(first.ok, true);
  assert.equal(again.recovered, true);
  assert.equal((await ledger.spendStatus()).records.length, 1);

  const budget = new SharedBudget(ledger, 'project-a', now);
  await budget.enqueue('no-cost');
  assert.equal((await ledger.admit('project-a', await budget.claimKey('no-cost'), limits(now()), {})).reason, 'spend_cost_required');

  await budget.enqueue('no-quote');
  const noQuote = limits(now()); delete noQuote.overagePrices;
  assert.equal((await ledger.admit('project-a', await budget.claimKey('no-quote'), noQuote, { pool: true, cost: { kind: 'machine', size: 'default', ttlSeconds: 7200 } })).reason, 'spend_quote');

  await budget.enqueue('high-quote');
  const high = limits(now()); high.overagePrices = { vmHourDollars: 0.05 };
  assert.equal((await ledger.admit('project-a', await budget.claimKey('high-quote'), high, { pool: true, cost: { kind: 'machine', size: 'default', ttlSeconds: 7200 } })).reason, 'spend_quote');
});

test('a confirmed deletion settles elapsed machine time; ambiguity keeps the maximum', async () => {
  const now = () => 1_000_000, storage = new Storage();
  const ledger = new AccountLedger(storage, policy, now);
  await ledger.reserveSpend('project-a', 'deleted', { kind: 'machine', size: 'default', ttlSeconds: 7200 });
  await ledger.reserveSpend('project-a', 'ambiguous', { kind: 'machine', size: 'default', ttlSeconds: 7200 });
  assert.equal(await ledger.settleSpend('deleted', 'created', { elapsedSeconds: 600 }), true);
  assert.equal(await ledger.settleSpend('ambiguous', 'unknown'), true);
  const status = await ledger.spendStatus();
  const records = Object.fromEntries(status.records.map(record => [record.key, record]));
  assert.equal(records.deleted.amountUsd, 0.006);
  assert.equal(records.deleted.elapsedSeconds, 600);
  assert.equal(records.ambiguous.amountUsd, 0.072);
  assert.equal(records.ambiguous.status, 'unknown');
});

test('uncertain VM spend stays reserved until the last possible billed second rolls off', async () => {
  const start = 1_000_000;
  let clock = start;
  const ledger = new AccountLedger(new Storage(), policy, () => clock);
  await ledger.reserveSpend('project-a', 'uncertain', { kind: 'machine', size: 'default', ttlSeconds: 7200 });
  await ledger.settleSpend('uncertain', 'unknown');
  clock = start + SPEND_WINDOW_MS;
  const status = await ledger.spendStatus();
  assert.equal(status.spentUsd, 0.072);
  assert.equal(status.nextRollOffAt, clock + 7_200_000);
  clock = status.nextRollOffAt;
  assert.equal((await ledger.spendStatus()).spentUsd, 0);
});

test('storage keeps its charge, renews every window, and settles actual days when deleted', async () => {
  let clock = 1_000_000;
  const now = () => clock, storage = new Storage();
  const ledger = new AccountLedger(storage, policy, now);
  await ledger.reserveSpend('project-a', 'snapshot:ci-base', { kind: 'storage', days: 30 });
  assert.equal((await ledger.spendStatus()).spentUsd, 1.68);

  clock += SPEND_WINDOW_MS;
  assert.equal((await ledger.spendStatus()).spentUsd, 1.68, 'a retained snapshot still costs in the next window');

  clock += 2 * 86_400_000;
  assert.equal(await ledger.confirmStorageDeleted('snapshot:ci-base', { elapsedSeconds: 2 * 86_400 }), true);
  const settled = await ledger.spendStatus();
  assert.equal(settled.spentUsd, 0.112, 'the confirmed deletion keeps the two days already charged');
  assert.equal(settled.records[0].status, 'settled');
  assert.equal(settled.records[0].elapsedDays, 2);
});

test('the public readiness category exposes only ready, exhausted or unavailable', () => {
  assert.deepEqual(admissionReadiness(null, 0.072), { ready: true, admission: 'ready' });
  assert.deepEqual(admissionReadiness({ enabled: true, remainingUsd: 0.05 }, 0.072), { ready: false, admission: 'exhausted' });
  assert.deepEqual(admissionReadiness({ enabled: true, remainingUsd: 19 }, 0.072), { ready: true, admission: 'ready' });
  assert.deepEqual(admissionReadiness({ enabled: true, remainingUsd: Number.NaN }, 0.072), { ready: false, admission: 'unavailable' });
});

test('GET /health carries the readiness category and nothing paid', async () => {
  const fleet = new Fleet({ storage: new Storage(), waitUntil() {} }, {
    PLUGIN_ROUTER: 'true', ENABLED: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a',
  });
  const health = async (enabled = 'true') => {
    const response = await fleet.fetch(new Request('https://fleet/health', { headers: { 'X-Boat-CI-Enabled': enabled } }));
    assert.equal(response.status, 200);
    return response.json();
  };
  let body = await health();
  assert.deepEqual({ ready: body.ready, admission: body.admission }, { ready: true, admission: 'ready' });
  for (const field of ['capUsd', 'spentUsd', 'remainingUsd', 'policy', 'records', 'amountUsd']) assert.equal(body[field], undefined);

  fleet.router.ledger.spend = { machineHourUsd: { default: 0.036 } };
  fleet.router.ledger.spendStatus = async () => ({ enabled: true, remainingUsd: 0 });
  body = await health();
  assert.deepEqual({ ready: body.ready, admission: body.admission }, { ready: false, admission: 'exhausted' });

  fleet.router.ledger.spendStatus = async () => ({ enabled: true, remainingUsd: 20 });
  fleet.router.accountLimits = async () => { throw new Error('provider unreachable'); };
  body = await health();
  assert.deepEqual({ ready: body.ready, admission: body.admission }, { ready: false, admission: 'unavailable' });
  fleet.router.accountLimits = async () => ({ canStart: true });
  body = await health();
  assert.deepEqual({ ready: body.ready, admission: body.admission }, { ready: true, admission: 'ready' });
  body = await health('false');
  assert.deepEqual({ ready: body.ready, admission: body.admission }, { ready: false, admission: 'unavailable' });

  fleet.router.ledger.spendStatus = async () => { throw new Error('ledger unavailable'); };
  body = await health();
  assert.deepEqual({ ready: body.ready, admission: body.admission }, { ready: false, admission: 'unavailable' });
});


test('spend reserve and settle work while start scheduling is paused', async () => {
  const token = 'a'.repeat(32);
  const fleet = new Fleet({ storage: new Storage(), waitUntil() {} }, {
    PLUGIN_ROUTER: 'true', ENABLED: 'false', BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'peek',
    SETUP_BOOTSTRAP: JSON.stringify({ controlHash: createHash('sha256').update(token).digest('hex') }),
  });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const reserve = await fleet.fetch(new Request('https://fleet/router/spend/reserve', {
    method: 'POST', headers, body: JSON.stringify({ project: 'peek', key: 'first-refresh', cost: { kind: 'machine', size: 'default', ttlSeconds: 5400 } }),
  }));
  assert.equal(reserve.status, 200);
  assert.equal((await reserve.json()).ok, true);
  const status = await fleet.fetch(new Request('https://fleet/router/spend', { headers }));
  assert.equal(status.status, 200);
  assert.equal((await status.json()).reservedUsd, 0.054);
  const settle = await fleet.fetch(new Request('https://fleet/router/spend/settle', {
    method: 'POST', headers, body: JSON.stringify({ key: 'first-refresh', status: 'not_created' }),
  }));
  assert.equal(settle.status, 200);
  assert.equal((await settle.json()).ok, true);
});

test('worker.fetch forwards all four /router/spend* paths with control auth enforcement', async () => {
  const token = 'b'.repeat(32);
  const fleet = new Fleet({ storage: new Storage(), waitUntil() {} }, {
    PLUGIN_ROUTER: 'true', ENABLED: 'false', BOAT_WALLET: 'peek', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'peek',
    SETUP_BOOTSTRAP: JSON.stringify({ controlHash: createHash('sha256').update(token).digest('hex') }),
  });
  const workerEnv = { ENABLED: 'false', FLEET: { idFromName: () => 'id', get: () => fleet } };

  for (const [method, path] of [
    ['GET', '/router/spend'],
    ['POST', '/router/spend/reserve'],
    ['POST', '/router/spend/settle'],
    ['POST', '/router/spend/storage-deleted'],
  ]) {
    const unauth = await worker.fetch(new Request(`https://worker${path}`, { method }), workerEnv);
    assert.equal(unauth.status, 401, `${method} ${path} should enforce control auth, not 404`);
  }

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const reserve = await worker.fetch(new Request('https://worker/router/spend/reserve', {
    method: 'POST', headers, body: JSON.stringify({ project: 'peek', key: 'worker-machine', cost: { kind: 'machine', size: 'default', ttlSeconds: 5400 } }),
  }), workerEnv);
  assert.equal(reserve.status, 200);
  assert.equal((await reserve.json()).ok, true);

  const status = await worker.fetch(new Request('https://worker/router/spend', { headers }), workerEnv);
  assert.equal(status.status, 200);
  assert.equal((await status.json()).reservedUsd, 0.054);

  const settle = await worker.fetch(new Request('https://worker/router/spend/settle', {
    method: 'POST', headers, body: JSON.stringify({ key: 'worker-machine', status: 'not_created' }),
  }), workerEnv);
  assert.equal(settle.status, 200);
  assert.equal((await settle.json()).ok, true);

  const reserveStorage = await worker.fetch(new Request('https://worker/router/spend/reserve', {
    method: 'POST', headers, body: JSON.stringify({ project: 'peek', key: 'snapshot:worker-test', cost: { kind: 'storage', days: 30 } }),
  }), workerEnv);
  assert.equal(reserveStorage.status, 200);
  assert.equal((await reserveStorage.json()).ok, true);

  const storageDeleted = await worker.fetch(new Request('https://worker/router/spend/storage-deleted', {
    method: 'POST', headers, body: JSON.stringify({ key: 'snapshot:worker-test', elapsedSeconds: 86_400 }),
  }), workerEnv);
  assert.equal(storageDeleted.status, 200);
  assert.equal((await storageDeleted.json()).ok, true);
});

test('worker.fetch forwards /health query string so size=default reports exhausted when only small fits', async () => {
  const fleet = new Fleet({ storage: new Storage(), waitUntil() {} }, {
    PLUGIN_ROUTER: 'true', ENABLED: 'true', BOAT_WALLET: 'example-account', BOAT_PROVIDER_WALLET: 'team_test', ROUTER_PROJECTS: 'project-a',
  });
  fleet.router.accountLimits = async () => ({ canStart: true });
  fleet.router.ledger.spend = { machineHourUsd: { small: 0.018, default: 0.036 } };
  const lifetime = Math.max(7200, ...[...fleet.router.projects.values()].map(project => Number(project.config?.machineTtlSeconds ?? 0)).filter(Number.isSafeInteger));
  const smallCost = spendAmount(fleet.router.ledger.spend, { kind: 'machine', size: 'small', ttlSeconds: lifetime });
  const defaultCost = spendAmount(fleet.router.ledger.spend, { kind: 'machine', size: 'default', ttlSeconds: lifetime });
  fleet.router.ledger.spendStatus = async () => ({ enabled: true, remainingUsd: (smallCost + defaultCost) / 2 });
  const workerEnv = { ENABLED: 'true', FLEET: { idFromName: () => 'id', get: () => fleet } };

  const smallRes = await worker.fetch(new Request('https://worker/health'), workerEnv);
  assert.equal(smallRes.status, 200);
  const smallBody = await smallRes.json();
  assert.deepEqual({ ready: smallBody.ready, admission: smallBody.admission }, { ready: true, admission: 'ready' });

  const defaultRes = await worker.fetch(new Request('https://worker/health?size=default'), workerEnv);
  assert.equal(defaultRes.status, 200);
  const defaultBody = await defaultRes.json();
  assert.deepEqual({ ready: defaultBody.ready, admission: defaultBody.admission }, { ready: false, admission: 'exhausted' });
});
