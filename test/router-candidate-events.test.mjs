import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCandidateRun } from '../src/router/candidate-events.mjs';

test('candidate cancellation applies only to the exact configured CI workflow and repository', () => {
  const config = { repo: 'owner/project', landing: { candidateQueue: { workflow: '.github/workflows/ci.yml' } } };
  const payload = { action: 'completed', installation: { id: 7 }, repository: { full_name: config.repo }, workflow_run: {
    id: 123, run_attempt: 1, head_sha: 'a'.repeat(40), path: '.github/workflows/ci.yml', event: 'push',
    repository: { full_name: config.repo }, head_repository: { full_name: config.repo }, head_branch: '_mq/candidates/one', conclusion: 'cancelled' } };
  assert.equal(selectCandidateRun('workflow_run', payload, config).conclusion, 'cancelled');
  assert.equal(selectCandidateRun('workflow_run', { ...payload, workflow_run: { ...payload.workflow_run, path: '.github/workflows/nightly.yml' } }, config), null);
  assert.equal(selectCandidateRun('workflow_run', { ...payload, workflow_run: { ...payload.workflow_run, head_repository: { full_name: 'fork/project' } } }, config), null);
});
