// A complete pool snapshot is evidence that the scan loop is alive and has read
// the whole queue; its age only has to stay inside one refresh cycle plus a
// grace for tick scheduling. The cycle is one minute while the router polls
// GitHub and fifteen minutes once repository webhooks carry the queue, so a
// fixed 90 s bound refused every lease outside the first 90 s after each scan.
export const POLL_SNAPSHOT_INTERVAL_MS = 60_000;
export const WEBHOOK_SNAPSHOT_INTERVAL_MS = 15 * 60_000;
export const SNAPSHOT_GRACE_MS = 30_000;

export function snapshotIntervalMs(config) {
  const interval = config?.snapshotIntervalMs;
  return Number.isSafeInteger(interval) && interval > 0 ? interval : POLL_SNAPSHOT_INTERVAL_MS;
}

export function snapshotFresh(snapshot, now, config) {
  return snapshot?.complete === true && Number.isFinite(snapshot.at) && snapshot.at <= now && now - snapshot.at <= snapshotIntervalMs(config) + SNAPSHOT_GRACE_MS;
}
