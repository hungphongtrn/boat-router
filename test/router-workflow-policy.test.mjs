import test from 'node:test';
import assert from 'node:assert/strict';
import { registeredWorkflow, assessPolicyRetirement } from '../src/router/workflow-policy.mjs';

test('workflow policy needs an exact registered blob and complete stable open-head inventory', () => {
  const old = 'a'.repeat(40), current = 'b'.repeat(40), sha = 'c'.repeat(40), registry = [old, current];
  assert.equal(registeredWorkflow(registry, old), true);
  assert.equal(registeredWorkflow(registry, old.slice(0, 8)), false);
  assert.equal(registeredWorkflow(registry, 'd'.repeat(40)), false);
  const used = { complete: true, stable: true, heads: [{ pr: 1, headSha: sha, workflowBlob: old }] };
  assert.equal(assessPolicyRetirement(registry, old, used).reason, 'policy_in_use');
  assert.equal(assessPolicyRetirement(registry, old, { ...used, complete: false }).reason, 'inventory_uncertain');
  assert.equal(assessPolicyRetirement(registry, old, { ...used, stable: false }).reason, 'inventory_uncertain');
  assert.equal(assessPolicyRetirement(registry, old, { ...used, heads: [{ pr: 1, headSha: sha, workflowBlob: current }] }).ok, true);
});
