import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPool } from '../src/router/replay.mjs';

test('replay reuses only an idle machine in the same project and retires at the job limit', async () => {
  const jobs = [
    { id: 'a', project: 'project-a', start: 0, end: 10 },
    { id: 'b', project: 'project-b', start: 10, end: 20 },
    { id: 'c', project: 'project-a', start: 10, end: 30 },
    { id: 'd', project: 'project-a', start: 15, end: 25 },
    { id: 'e', project: 'project-a', start: 30, end: 40 },
  ];
  assert.deepEqual(await replayPool(jobs, { maxJobs: 2 }), {
    "project-a": { completed: 4, starts: 2 }, "project-b": { completed: 1, starts: 1 },
  });
});

test('replay enforces idle and age limits and rejects duplicate identities', async () => {
  const jobs = [ { id: 'a', project: 'project-a', start: 0, end: 1 }, { id: 'b', project: 'project-a', start: 12, end: 13 } ];
  assert.equal((await replayPool(jobs, { idleHoldMs: 10 }))['project-a'].starts, 2);
  await assert.rejects(replayPool([...jobs, jobs[0]]), /duplicate/);
});
