import test from 'node:test';
import assert from 'node:assert/strict';
import { event, fixture } from './helpers.mjs';

test('configuration registers the recorded runner identity', async () => {
  const f = fixture();
  const job = { ...event(), machineId: 'bx_23456789', generation: 1, runnerIdentity: 'boat-ci-j101-g2' };
  let saved;
  await f.api.configure(job, id => { saved = id; });
  assert.equal(f.fake.runners.get(saved).name, job.runnerIdentity);
});
