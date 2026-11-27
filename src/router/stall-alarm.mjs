export const STALL_MS = 15 * 60_000;
const LIVE = new Set(['booting', 'baseline', 'ready', 'registering', 'idle', 'busy', 'finished', 'resetting', 'local-fencing', 'local-held']);

// Quarantined/cleanup boxes occupy budget but cannot serve queued work. Include
// them in diagnostics rather than letting two stranded boxes silence the alarm.
export async function observeRouterStall(storage, { project, pool, demand, boxes, creates, now, enabled, logger }) {
  const key = `pool:stall:${pool}`;
  const scoped = boxes.filter(box => box.pool === pool);
  const live = scoped.filter(box => LIVE.has(box.state)).length;
  const recentCreate = creates.some(item => item.pool === pool && item.state !== 'pending' && Number.isFinite(item.callingAt) && now - item.callingAt < STALL_MS);
  if (!enabled || demand <= 0 || live > 0 || recentCreate) { await storage.delete(key); return; }
  const previous = await storage.get(key), since = previous?.since ?? now;
  const due = now - since >= STALL_MS && (!Number.isFinite(previous?.loggedAt) || now - previous.loggedAt >= STALL_MS);
  if (due) logger?.(JSON.stringify({ event: 'router_stalled', level: 'error', project, pool, D: demand, liveBoxes: live, occupiedBoxes: scoped.filter(box => box.state !== 'deleted').length, quarantinedBoxes: scoped.filter(box => box.state === 'quarantined').length, stalled_ms: now - since }));
  await storage.put(key, { since, ...(due ? { loggedAt: now } : previous?.loggedAt !== undefined ? { loggedAt: previous.loggedAt } : {}) });
}
