import test from 'node:test';
import assert from 'node:assert/strict';
import { Storage } from './helpers.mjs';
import { FleetController } from '../src/fleet.mjs';
import { BoxFleet } from '../src/router/box-fleet.mjs';

test('pool verification breaker emits one operator alert at the threshold', async () => {
  const storage = new Storage(), controller = new FleetController(storage, {}, {}, () => 1000, () => {});
  const fleet = new BoxFleet(storage, {}, () => 1000, { emit: controller.emit.bind(controller) });
  for (let i = 1; i <= 3; i++) await fleet.verificationOutcome({ machineId: `machine-${i}`, size: 'large', generation: 0 }, 'online', false);
  await fleet.verificationOutcome({ machineId: 'machine-3', size: 'large', generation: 0 }, 'online', false);
  assert.equal((await storage.get('verification:breaker')).tripped, true);
  const alerts = await storage.get('alerts');
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].event, 'alert_verification_breaker');
  assert.equal(alerts[0].size, 'large');
  assert.equal((await storage.get('verification:breaker')).counts.large, 3);
});
