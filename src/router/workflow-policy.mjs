const SHA = /^[a-f0-9]{40}$/;

export function registeredWorkflow(registry, blob) {
  return Array.isArray(registry) && SHA.test(blob ?? '') && registry.includes(blob);
}

// The caller must obtain a complete inventory and prove that the open heads
// did not change during the scan. Uncertain or partial scans never retire a
// policy. This function does not alter the registry.
export function assessPolicyRetirement(registry, blob, inventory) {
  if (!registeredWorkflow(registry, blob)) return { ok: false, reason: 'unknown_policy' };
  if (inventory?.complete !== true || inventory?.stable !== true || !Array.isArray(inventory.heads)) return { ok: false, reason: 'inventory_uncertain' };
  const prs = new Set();
  for (const head of inventory.heads) {
    if (!Number.isSafeInteger(head?.pr) || head.pr < 1 || prs.has(head.pr) || !SHA.test(head.headSha ?? '') || !SHA.test(head.workflowBlob ?? '')) return { ok: false, reason: 'inventory_uncertain' };
    prs.add(head.pr);
    if (head.workflowBlob === blob) return { ok: false, reason: 'policy_in_use' };
  }
  return { ok: true };
}
