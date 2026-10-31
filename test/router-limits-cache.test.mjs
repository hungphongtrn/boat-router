import test from 'node:test';
import assert from 'node:assert/strict';
import { cachedLimits } from '../src/router/install.mjs';

test('tenants share a limits read and back off after a provider failure', async () => {
  let time = 1000, reads = 0, finish;
  const gate = new Promise(resolve => { finish = resolve; });
  const limits = cachedLimits(async () => { reads++; if (reads === 1) { await gate; return { canStart: true }; } throw new Error('provider unavailable'); }, () => time);
  const first = limits(), second = limits();
  assert.equal(reads, 1);
  time += 100; finish();
  assert.deepEqual(await first, { canStart: true, observedAt: 1000 });
  assert.deepEqual(await second, { canStart: true, observedAt: 1000 });
  time += 1;
  await assert.rejects(limits(), /provider unavailable/);
  await assert.rejects(limits(), /provider unavailable/);
  assert.equal(reads, 2);
  time += 30000;
  await assert.rejects(limits(), /provider unavailable/);
  assert.equal(reads, 3);
});

test('an unavailable start is refreshed for the next batch', async () => {
  let time = 1000, reads = 0;
  const limits = cachedLimits(async () => { reads++; return { canStart: false }; }, () => time);
  await limits(); time += 59999; await limits();
  assert.equal(reads, 2);
  time++; await limits();
  assert.equal(reads, 3);
});
