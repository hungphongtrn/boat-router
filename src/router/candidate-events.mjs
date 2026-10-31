// Candidate results are scoped to the configured workflow and trusted repo.
// The queue engine must opt in before using these events.
export function selectCandidateRun(name, payload, config) {
  if (name !== 'workflow_run' || !['requested', 'in_progress', 'completed'].includes(payload?.action)) return null;
  const run = payload.workflow_run, repo = config?.repo, installation = payload.installation?.id;
  const workflow = config?.landing?.candidateQueue?.workflow;
  if (typeof repo !== 'string' || !repo || payload.repository?.full_name !== repo || !Number.isSafeInteger(installation) || installation < 1 ||
      !Number.isSafeInteger(run?.id) || run.id < 1 || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1 ||
      typeof run.head_sha !== 'string' || !/^[a-f0-9]{40}$/.test(run.head_sha) ||
      typeof workflow !== 'string' || !workflow || run.path !== workflow || run.event !== 'push' ||
      run.repository?.full_name !== repo || run.head_repository?.full_name !== repo ||
      typeof run.head_branch !== 'string' || !run.head_branch.startsWith('_mq/candidates/')) return null;
  return { kind: 'queue-run', repo, installation, id: run.id, attempt: run.run_attempt, headSha: run.head_sha,
    ref: run.head_branch, completed: payload.action === 'completed', conclusion: run.conclusion ?? null };
}
