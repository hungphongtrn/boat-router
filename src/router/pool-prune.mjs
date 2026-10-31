const RETENTION = 7 * 86400_000;

export async function prunePool(storage, now) {
  const last = await storage.get('pool:pruned-at');
  if (Number.isFinite(last) && now - last < 86400_000) return;
  for (const prefix of ['runner:', 'pool:drain-only:', 'gh-job:', 'legacy:', 'verification:attempt:', 'box:']) {
    let cursor = '';
    for (;;) {
      const page = await storage.list({ prefix, startAfter: cursor, limit: 128 });
      for (const [key] of page) await storage.transaction(async tx => {
        const value = await tx.get(key);
        if (!value) return;
        let at, terminal = true;
        if (prefix === 'runner:' || prefix === 'pool:drain-only:') {
          const machineId = prefix === 'runner:' ? value.machineId : key.slice(prefix.length);
          const box = machineId && await tx.get(`box:${machineId}`);
          terminal = box?.state === 'deleted'; at = box?.since;
        } else if (prefix === 'box:') { terminal = value.state === 'deleted'; at = value.since; }
        else if (prefix === 'gh-job:') { terminal = value.status === 'completed'; at = value.observedAt; }
        else at = value.at;
        if (terminal && Number.isFinite(at) && now - at >= RETENTION) await tx.delete(key);
      });
      if (page.size < 128) break;
      cursor = [...page.keys()].at(-1);
    }
  }
  await storage.put('pool:pruned-at', now);
}
