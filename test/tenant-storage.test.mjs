import test from 'node:test';
import assert from 'node:assert/strict';
import { TenantStorage } from '../src/router/tenant-storage.mjs';
import { Storage } from './helpers.mjs';

test('tenant operations and transactions cannot see or overwrite other projects', async () => {
  const base = new Storage();
  const a = new TenantStorage(base, 'project-a');
  const b = new TenantStorage(base, 'project-b');
  await a.put('suite:run:1', { value: 'a' });
  await b.put('suite:run:1', { value: 'b' });
  await a.transaction(async tx => {
    assert.equal((await tx.get('suite:run:1')).value, 'a');
    await tx.put('suite:run:2', { value: 'a2' });
    await tx.delete('suite:run:1');
  });
  assert.deepEqual([...await a.list({ prefix: 'suite:run:' })], [['suite:run:2', { value: 'a2' }]]);
  assert.deepEqual([...await b.list({ prefix: 'suite:run:' })], [['suite:run:1', { value: 'b' }]]);
  assert.equal(await base.get('suite:run:1'), undefined);
  assert.throws(() => new TenantStorage(base, 'project-b:escape'), TypeError);
});


test('tenant alarms retain the earliest wakeup under concurrent requests', async () => {
  const base = new Storage();
  const a = new TenantStorage(base, 'project-a'), b = new TenantStorage(base, 'project-b');
  await Promise.all([a.setAlarm(1000), b.setAlarm(2000)]);
  assert.equal(await base.getAlarm(), 1000);
  await Promise.all([a.setAlarm(3000), b.setAlarm(500)]);
  assert.equal(await base.getAlarm(), 500);
});
