// The adapter returns { status, data, etag, rateRemaining }. Cached pages are
// required for 304 responses; partial reads must never look complete.
const fields = {
  workflow_runs: ['id', 'updated_at', 'status', 'run_attempt', 'head_sha'],
  jobs: ['id', 'status', 'conclusion', 'labels', 'created_at', 'started_at', 'completed_at', 'runner_name', 'run_id', 'head_branch', 'head_sha', 'run_attempt', 'workflow_name', 'name'],
  runners: ['id', 'name', 'status', 'busy', 'labels'],
};

function compact(row, keys) {
  return Object.fromEntries(keys.filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}

export async function snapshot(api, repo, { etags = {}, pages: cached = {}, partial = null, budget = 40 } = {}) {
  const pages = {}, nextEtags = {}, jobs = [], runners = [], runs = new Map();
  let calls = 0, rateRemaining = null, progress = null;
  async function get(path, field) {
    if (calls >= budget) throw new Error('snapshot_budget');
    calls++;
    const response = await api(repo, path, etags[path] ?? null);
    if (Number.isFinite(response.rateRemaining)) rateRemaining = response.rateRemaining;
    const data = response.status === 304 ? cached[path] : response.data;
    if ((response.status !== 200 && response.status !== 304) || !data || typeof data !== 'object') throw new Error('snapshot_page');
    if (!Array.isArray(data[field])) throw new Error('snapshot_shape');
    const clean = { total_count: data.total_count, [field]: data[field].map(row => compact(row, fields[field])) };
    if (field === 'runners') for (const runner of clean.runners) if (Array.isArray(runner.labels)) runner.labels = runner.labels.map(label => typeof label === 'string' ? label : { name: label.name });
    pages[path] = clean;
    if (response.etag ?? etags[path]) nextEtags[path] = response.etag ?? etags[path];
    return clean;
  }
  async function list(path, field) {
    const rows = []; let total;
    for (let page = 1; ; page++) {
      const data = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, field);
      if (!Array.isArray(data[field]) || !Number.isSafeInteger(data.total_count) || data.total_count < 0) throw new Error('snapshot_shape');
      if (total === undefined) total = data.total_count;
      if (total !== data.total_count) throw new Error('snapshot_changed');
      rows.push(...data[field]);
      if (rows.length === total) return rows;
      if (rows.length > total || data[field].length !== 100) throw new Error('snapshot_incomplete');
    }
  }
  try {
    for (const status of ['queued', 'in_progress']) {
      for (const run of await list(`/actions/runs?status=${status}`, 'workflow_runs')) {
        if (!Number.isSafeInteger(run.id) || run.id < 1) throw new Error('snapshot_shape');
        runs.set(run.id, run);
      }
    }
    progress = { runJobs: { ...partial?.runJobs } };
    for (const id of Object.keys(progress.runJobs)) if (!runs.has(Number(id))) delete progress.runJobs[id];
    for (const run of runs.values()) {
      const signature = JSON.stringify(run), saved = partial?.runJobs?.[run.id];
      const entry = saved?.signature === signature ? saved : { signature, jobs: await list(`/actions/runs/${run.id}/jobs?filter=latest`, 'jobs') };
      progress.runJobs[run.id] = entry;
      jobs.push(...entry.jobs);
    }
    runners.push(...await list('/actions/runners', 'runners'));
    return { complete: true, jobs, runners, etags: nextEtags, pages, rateRemaining, calls };
  } catch (error) {
    return { complete: false, jobs: [], runners: [], etags, pages: cached, rateRemaining, calls, ...(error.message === 'snapshot_budget' && progress ? { partial: progress } : {}) };
  }
}
