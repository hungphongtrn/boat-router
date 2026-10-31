import { jobRunnerName } from '../domain.mjs';

export async function verifyAttentionRecovery(api, job, id) {
  try {
    const actual = await api.getJob(job, id);
    if (actual?.status !== 'queued' || actual.runner_name) return false;
    try { await api.sandbox(job); return false; } catch (error) { if (error?.status !== 404) return false; }
    if (job.runnerId) {
      try { await api.runner(job); return false; } catch (error) { if (error?.status !== 404) return false; }
    } else {
      const pattern = new RegExp(`^boat-ci-j${id}-g[0-9]+$`), ids = new Set();
      let total;
      for (let page = 1; page <= 10; page++) {
        const result = await api.github(job, `/actions/runners?per_page=100&page=${page}`);
        if (!Array.isArray(result?.runners) || !Number.isSafeInteger(result.total_count) || result.total_count < 0 || result.total_count > 1000 || (total !== undefined && total !== result.total_count)) return false;
        total = result.total_count;
        for (const runner of result.runners) {
          if (!Number.isSafeInteger(runner?.id) || typeof runner.name !== 'string' || ids.has(runner.id) || pattern.test(runner.name) || runner.name === jobRunnerName(job)) return false;
          ids.add(runner.id);
        }
        if (ids.size === total) break;
        if (result.runners.length !== 100 || ids.size > total) return false;
      }
      if (ids.size !== total) return false;
    }
  } catch { return false; }
  return true;
}
