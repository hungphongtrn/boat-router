import { validMachineSize } from './sizes.mjs';

export function selectWorkflowJob(name, payload, config) {
  if (name !== 'workflow_job' || !config.triggers?.some(trigger => trigger.on === name && trigger.executor === 'actions-jit')) return null;
  const job = payload?.workflow_job, installation = payload?.installation?.id;
  if (payload?.repository?.full_name !== config.repo || !Number.isSafeInteger(installation) || installation < 1 || !Number.isSafeInteger(job?.id) || job.id < 1) return null;
  if (!['queued', 'in_progress', 'completed'].includes(payload.action) || !Array.isArray(job.labels) || job.labels.some(label => typeof label !== 'string')) return null;
  const sizeLabels = job.labels.filter(value => value.startsWith('boat-size-'));
  const projectLabels = job.labels.filter(value => config.labels.includes(value));
  if (!sizeLabels.length && !projectLabels.length) return null;
  if (sizeLabels.length && job.labels.length !== 1) throw new TypeError('Use one Boat runner label per job');
  if (job.labels.length !== 1 || projectLabels.length > 1) return null;
  const label = job.labels[0];
  const size = sizeLabels.length ? label.slice('boat-size-'.length) : config.sizes?.[label]?.machine;
  if (!validMachineSize(size)) throw new TypeError('Unknown Boat size; use small, default, large, or xlarge');
  return { id: job.id, repo: config.repo, installation, label, labels: job.labels, size, status: payload.action, runnerName: job.runner_name ?? null,
    ...(Number.isSafeInteger(job.run_id) && job.run_id > 0 ? { runId: job.run_id } : {}),
    ...(typeof job.head_branch === 'string' && job.head_branch.length <= 255 ? { branch: job.head_branch } : {}),
    ...(typeof job.head_sha === 'string' && /^[a-f0-9]{40}$/.test(job.head_sha) ? { headSha: job.head_sha } : {}),
    ...(Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 ? { runAttempt: job.run_attempt } : {}),
    ...(typeof job.workflow_name === 'string' && job.workflow_name.length <= 255 ? { workflowName: job.workflow_name } : {}),
    ...(typeof job.name === 'string' && job.name.length <= 255 ? { jobName: job.name } : {}),
    ...(Number.isFinite(Date.parse(job.started_at)) ? { startedAt: Date.parse(job.started_at) } : {}),
    ...(Number.isFinite(Date.parse(job.completed_at)) ? { completedAt: Date.parse(job.completed_at) } : {}),
    ...(typeof job.conclusion === 'string' ? { conclusion: job.conclusion } : {}) };
}
