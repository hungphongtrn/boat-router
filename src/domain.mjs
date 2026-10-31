import { repositories, smokeRepository } from '../config/policy.mjs';
export const SIZES = Object.freeze({ 'boat-default': 'default', 'boat-large': 'large', 'boat-xlarge': 'xlarge' });
export const REPOSITORIES = new Set(repositories);
export function selectJob(payload, allowSmoke = false) {
  const repo = payload?.repository?.full_name;
  const j = payload?.workflow_job;
  if (!REPOSITORIES.has(repo) && !(allowSmoke && repo === smokeRepository)) return null;
  if (!['queued', 'in_progress', 'completed'].includes(payload.action)) return null;
  if (!Number.isSafeInteger(j?.id) || j.id <= 0 || !Number.isSafeInteger(payload.installation?.id)) return null;
  if (!Array.isArray(j.labels) || j.labels.length !== 1 || !Object.hasOwn(SIZES, j.labels[0])) return null;
  return { id: j.id, repo, installation: payload.installation.id, label: j.labels[0], size: SIZES[j.labels[0]],
    status: payload.action, runnerName: j.runner_name ?? null };
}
export function runnerName(id, generation = 0) { return `boat-ci-j${id}${generation ? `-g${generation}` : ''}`; }
export function jobRunnerName(job) { return job.runnerIdentity ?? runnerName(job.id, job.generation); }
export function reservationId(name) {
  const m = /^boat-ci-j([1-9][0-9]*)(?:-g[1-9][0-9]*)?$/.exec(name ?? '');
  return m && Number.isSafeInteger(Number(m[1])) ? Number(m[1]) : null;
}
export class ApiError extends Error {
  constructor(service, status, code = 'request_failed', retrySeconds = 0) {
    super(`${service} HTTP ${status}`);
    Object.assign(this, { service, status, code, retrySeconds });
  }
}
export function isSizeRefusal(error) {
  return error.service === 'boat' && ['machine_class_plan_required', 'trial_machine_class_not_allowed'].includes(error.code);
}
export function isPlanRefusal(error) {
  return error.service === 'boat' && (error.status === 402 ||
    ['trial_compute_limit_reached', 'trial_auto_stop_required', 'billing_required', 'team_member_cap_reached'].includes(error.code));
}
export function backoff(attempt, minimumSeconds = 0, random = Math.random) {
  return Math.max(minimumSeconds * 1000, Math.min(900_000, 5000 * 2 ** Math.min(attempt, 8))) + Math.floor(random() * 3000);
}
export function logEvent(logger, event, job, detail = {}) {
  const record = { event, job_id: job?.id ?? null, machine_id: job?.machineId ?? null };
  for (const key of ['size', 'requested_size', 'phase', 'status', 'retry_ms', 'assigned_job_id', 'operation_id', 'runner_name', 'pool']) {
    if (detail[key] !== undefined) record[key] = detail[key];
  }
  logger(JSON.stringify(record));
  return record;
}
