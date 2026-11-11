import { validMachineSize } from './sizes.mjs';
import { laneFor } from './lanes.mjs';

export function selectWorkflowJob(name, payload, config) {
  if (name !== 'workflow_job' || !config.triggers?.some(trigger => trigger.on === name && trigger.executor === 'actions-jit')) return null;
  const job = payload?.workflow_job, installation = payload?.installation?.id;
  if (payload?.repository?.full_name !== config.repo || !Number.isSafeInteger(installation) || installation < 1 || !Number.isSafeInteger(job?.id) || job.id < 1) return null;
  if (!['queued', 'in_progress', 'completed'].includes(payload.action) || !Array.isArray(job.labels) || job.labels.some(label => typeof label !== 'string')) return null;
  const sizeLabels = job.labels.filter(value => value.startsWith('boat-size-'));
  const projectLabels = job.labels.filter(value => config.labels.includes(value));
  if (!sizeLabels.length && !projectLabels.length) return null;
  if (sizeLabels.length && job.labels.length !== 1) throw new TypeError('Use one Boat runner label per job');
  // A pool label combined only with the project's Boat labels (every Boat runner of the tenant carries them, no
  // mini runner does) is a Boat-only job of that pool: GitHub never hands it to a mini runner, and the router
  // neither offers nor holds it. Any other combination is not this tenant's job.
  const boatLabels = Array.isArray(config.boatLabels) ? config.boatLabels : [];
  const extraLabels = job.labels.filter(value => !config.labels.includes(value));
  if (!sizeLabels.length && (projectLabels.length !== 1 || extraLabels.some(value => !boatLabels.includes(value)))) return null;
  const label = sizeLabels.length ? job.labels[0] : projectLabels[0];
  const boatOnly = !sizeLabels.length && extraLabels.length > 0;
  const size = sizeLabels.length ? label.slice('boat-size-'.length) : config.sizes?.[label]?.machine;
  if (!validMachineSize(size)) throw new TypeError('Unknown Boat size; use small, default, large, or xlarge');
  // the run name (snapshot `run_name` from the run's display title) names the job's lane.
  const workflowPath = typeof job.workflow_path === 'string' && job.workflow_path.length <= 255 ? job.workflow_path : undefined;
  const runName = typeof job.run_name === 'string' && job.run_name.length > 0 && job.run_name.length <= 255 ? job.run_name : undefined;
  return { id: job.id, repo: config.repo, installation, label, labels: job.labels, size, status: payload.action, runnerName: job.runner_name ?? null, ...(boatOnly ? { boatOnly: true } : {}),
    ...(runName ? { runName, ...laneFor(config, { runName, workflowPath }) } : {}),
    ...(Number.isSafeInteger(job.run_id) && job.run_id > 0 ? { runId: job.run_id } : {}),
    ...(typeof job.head_branch === 'string' && job.head_branch.length <= 255 ? { branch: job.head_branch } : {}),
    ...(typeof job.head_sha === 'string' && /^[a-f0-9]{40}$/.test(job.head_sha) ? { headSha: job.head_sha } : {}),
    ...(Number.isSafeInteger(job.run_attempt) && job.run_attempt > 0 ? { runAttempt: job.run_attempt } : {}),
    ...(typeof job.workflow_path === 'string' && job.workflow_path.length <= 255 ? { workflowPath: job.workflow_path } : {}),
    ...(typeof job.workflow_name === 'string' && job.workflow_name.length <= 255 ? { workflowName: job.workflow_name } : {}),
    ...(typeof job.name === 'string' && job.name.length <= 255 ? { jobName: job.name } : {}),
    ...(Number.isFinite(Date.parse(job.started_at)) ? { startedAt: Date.parse(job.started_at) } : {}),
    ...(Number.isFinite(Date.parse(job.completed_at)) ? { completedAt: Date.parse(job.completed_at) } : {}),
    ...(typeof job.conclusion === 'string' ? { conclusion: job.conclusion } : {}) };
}
