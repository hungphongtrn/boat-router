import { runMaxParallel } from './lanes.mjs';

// GitHub reports matrix jobs waiting for a max-parallel slot as queued. They
// cannot accept a runner until a slot opens, so do not provision for them yet.
// a lane may name its own per-run cap (the land tool dispatches
// each lane with its own max_parallel input); the rule's value is the default.
// With the lane switch off (`laneCaps` false) only the rule's cap applies, so
// `POST /router/lanes?mode=off` is a full revert to the pre-lane planner.
export const matchesWorkflowRule = (job, rule) => (typeof rule.workflowPath === 'string' ? job.workflowPath === rule.workflowPath : typeof rule.workflow === 'string' && job.workflowName === rule.workflow) && typeof rule.jobPrefix === 'string' && job.jobName?.startsWith(rule.jobPrefix);

export function runnableDemand(jobs, rules, complete, { laneCaps = true } = {}) {
  if (!complete || !Array.isArray(rules) || !rules.length) return jobs;
  const allowed = new Set();
  for (const rule of rules) {
    if ((typeof rule.workflow !== 'string' && typeof rule.workflowPath !== 'string') || typeof rule.jobPrefix !== 'string' || !Number.isSafeInteger(rule.maxParallel) || rule.maxParallel < 1) continue;
    const matching = jobs.filter(job => matchesWorkflowRule(job, rule) && Number.isSafeInteger(job.runId) && !job.missing);
    const runs = new Set(matching.map(job => job.runId));
    for (const run of runs) {
      const group = matching.filter(job => job.runId === run);
      const cap = group.map(job => runMaxParallel(job, rule, laneCaps)).find(Number.isSafeInteger) ?? rule.maxParallel;
      const slots = Math.max(0, cap - group.filter(job => job.status === 'in_progress').length);
      for (const job of group.filter(job => job.status === 'queued').sort((a, b) => a.queuedAt - b.queuedAt || a.id - b.id).slice(0, slots)) allowed.add(job.id);
    }
  }
  return jobs.filter(job => job.status !== 'queued' || !rules.some(rule => matchesWorkflowRule(job, rule) && Number.isSafeInteger(rule.maxParallel) && rule.maxParallel > 0 && Number.isSafeInteger(job.runId)) || allowed.has(job.id));
}
