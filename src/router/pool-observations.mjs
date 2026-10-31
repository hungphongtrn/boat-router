import { snapshot } from './github-snapshot.mjs';
import { poolKey } from './pool.mjs';
import { selectWorkflowJob } from './select.mjs';
import { recordDuration } from './wait-for-busy.mjs';

export async function observe(storage, event, at, source = 'webhook') {
  return storage.transaction(async tx => {
    const key = `gh-job:${event.id}`, previous = await tx.get(key);
    if (previous && (previous.observedAt > at || (previous.observedAt === at && previous.source === 'webhook' && source === 'snapshot'))) return;
    if (source === 'webhook' && previous && previous.source !== 'legacy' && ((previous.status === 'completed' && event.status !== 'completed') || (previous.status === 'in_progress' && event.status === 'queued'))) return;
    const queuedAt = event.queuedAt ?? previous?.queuedAt ?? at;
    const job = { ...previous, id: event.id, pool: poolKey(event.repo, event.label), status: event.status,
      runnerName: event.runnerName ?? null, runId: event.runId ?? null,
      jobName: event.jobName ?? previous?.jobName ?? null, startedAt: event.startedAt ?? previous?.startedAt ?? null,
      completedAt: event.completedAt ?? previous?.completedAt ?? null, conclusion: event.conclusion ?? previous?.conclusion ?? null,
      queuedAt, observedAt: at, source, missing: false };
    if (job.status === 'completed' && !previous?.durationRecorded) await recordDuration(tx, job);
    await tx.put(key, job);
  });
}

async function all(storage, prefix) {
  const values = []; let startAfter = '';
  for (;;) {
    const page = await storage.list({ prefix, startAfter, limit: 128 });
    values.push(...page.values());
    if (page.size < 128) return values;
    startAfter = [...page.keys()].at(-1);
  }
}

async function saveSnapshot(storage, value) {
  const { pages, etags, partial, ...metadata } = value;
  const serialized = JSON.stringify({ pages, etags, partial });
  const chunks = serialized.match(/[\s\S]{1,100000}/g) ?? [];
  let snapshot = { ...metadata, format: 2, cacheChunks: chunks.length };
  if (new TextEncoder().encode(JSON.stringify(snapshot)).length > 1_000_000) {
    snapshot = { at: value.at, complete: false, rateRemaining: value.rateRemaining, format: 2, cacheChunks: 0 };
    chunks.length = 0;
  }
  await storage.transaction(async tx => {
    const old = await tx.get('pool:snapshot');
    for (let i = 0; i < chunks.length; i++) await tx.put(`pool:snapshot-cache:${i}`, chunks[i]);
    for (let i = chunks.length; i < (old?.cacheChunks ?? 0); i++) await tx.delete(`pool:snapshot-cache:${i}`);
    await tx.put('pool:snapshot', snapshot);
    await tx.put('pool:snapshot-complete', snapshot.complete === true);
  });
  return snapshot.complete === true;
}

async function readScan(storage) {
  return storage.transaction(async tx => {
  const stored = await tx.get('pool:snapshot') ?? {};
  if (stored.format !== 2) return {};
  const chunks = [];
  for (let i = 0; i < stored.cacheChunks; i++) {
    const chunk = await tx.get(`pool:snapshot-cache:${i}`);
    if (typeof chunk !== 'string') return {};
    chunks.push(chunk);
  }
  try { return { ...stored, ...JSON.parse(chunks.join('') || '{}') }; }
  catch { return {}; }
  });
}

export async function reconcile(storage, api, config, installation, now = Date.now) {
  const tickStart = now(), previous = await readScan(storage);
  const start = previous.partial?.startedAt ?? tickStart;
  const view = await snapshot((_repo, path, etag) => api.snapshotPage({ repo: config.repo, installation }, path, etag), config.repo, previous);
  if (!view.complete) {
    await saveSnapshot(storage, { ...previous, at: tickStart, complete: false, rateRemaining: view.rateRemaining, partial: view.partial ? { ...view.partial, startedAt: start } : null });
    return false;
  }
  const observedAt = start;
  const observed = new Set();
  for (const job of view.jobs) {
    let event;
    try { event = selectWorkflowJob('workflow_job', { action: job.status, repository: { full_name: config.repo }, installation: { id: installation }, workflow_job: job }, config); }
    catch (error) { if (!(error instanceof TypeError)) throw error; continue; }
    if (!event) continue;
    observed.add(event.id);
    const queuedAt = Date.parse(job.created_at ?? '');
    await observe(storage, { ...event, ...(Number.isFinite(queuedAt) ? { queuedAt } : {}) }, observedAt, 'snapshot');
  }
  const absent = (await all(storage, 'gh-job:')).filter(job => ['queued', 'in_progress'].includes(job.status) && job.observedAt < observedAt && !observed.has(job.id));
  for (const job of absent) {
    await storage.transaction(async tx => {
      const current = await tx.get(`gh-job:${job.id}`);
      if (['queued', 'in_progress'].includes(current?.status) && current.observedAt < observedAt) await tx.put(`gh-job:${job.id}`, { ...current, missing: true });
    });
  }
  for (const job of absent.slice(0, Math.min(10, Math.max(0, 40 - view.calls)))) {
    try {
      const actual = await api.getJob({ repo: config.repo, installation, id: job.id }, job.id);
      const event = selectWorkflowJob('workflow_job', { action: actual.status, repository: { full_name: config.repo }, installation: { id: installation }, workflow_job: actual }, config);
      if (event) await observe(storage, event, start, 'snapshot');
    } catch { /* Keep the missing record until a later confirmation. */ }
  }
  return saveSnapshot(storage, { ...view, at: tickStart });
}
