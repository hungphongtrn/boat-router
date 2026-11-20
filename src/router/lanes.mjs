import { countsTowardCap } from './box-state.mjs';
// Release lane for an Actions JIT pool.
//
// A lane is named by the run's display title (the `run-name` of the workflow),
// which is the only signal that separates a release certification from a
// feature batch, a hotfix batch or a bisect probe: every one of them runs the
// same workflow with the same job names. The `workflow_job` webhook carries
// no run name, so the ingest looks the run up once (`run-name:<runId>` in the
// tenant's storage); the 60 s GitHub snapshot carries it on every run.
//
// Config: `lanes` on the project (from the CI spec `router.boat.lanes`), an
// ordered list of rules; the first rule that matches wins:
//   { lane, priority, runNamePrefix? , match? (regex source), workflowPath?, reservedConcurrent?, maxParallel? }
// A job that matches no rule has no lane and the lowest priority. Ordering is
// (effective priority, queuedAt, id); the effective priority of a queued job
// improves by one level per LANE_AGING_MS so that no lane starves.
// Reservation: `reservedConcurrent` slots of the pool cap are usable only by
// that lane; the other lanes share the rest. No running job is ever preempted.
// Borrowing: while the reserved lane has no job queued or running
// and none was seen for `borrowQuietMinutes`, the other lanes may take up to
// `borrowable` of its reserved slots; the rest of the reservation always stays
// free for a burst. Lending stops the moment demand appears; borrowed slots
// return as their jobs finish (no preemption).
// Runtime switch: `switch:lanes` { mode: 'off' } turns ordering and
// reservation off without a deploy (POST /router/lanes?project=…&mode=off).

export const LANE_AGING_MS = 30 * 60_000;
export const LANE_MAX_PRIORITY = 9;
export const LANES_SWITCH_KEY = 'switch:lanes';
export const RUN_NAME_PREFIX = 'run-name:';
export const BORROW_QUIET_MINUTES_DEFAULT = 10;

const validRule = rule => rule && typeof rule === 'object' && typeof rule.lane === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(rule.lane)
  && Number.isSafeInteger(rule.priority) && rule.priority >= 0 && rule.priority <= LANE_MAX_PRIORITY
  && (typeof rule.runNamePrefix === 'string' ? rule.runNamePrefix.length > 0 && rule.runNamePrefix.length <= 128 : rule.runNamePrefix === undefined)
  && (typeof rule.match === 'string' ? rule.match.length > 0 && rule.match.length <= 256 : rule.match === undefined)
  && (typeof rule.runNamePrefix === 'string' || typeof rule.match === 'string')
  && (rule.workflowPath === undefined || (typeof rule.workflowPath === 'string' && rule.workflowPath.length > 0))
  && (rule.reservedConcurrent === undefined || (Number.isSafeInteger(rule.reservedConcurrent) && rule.reservedConcurrent >= 0))
  && (rule.maxParallel === undefined || (Number.isSafeInteger(rule.maxParallel) && rule.maxParallel >= 1))
  && (rule.borrowable === undefined || (Number.isSafeInteger(rule.borrowable) && rule.borrowable >= 0))
  && (rule.borrowQuietMinutes === undefined || (Number.isSafeInteger(rule.borrowQuietMinutes) && rule.borrowQuietMinutes >= 0 && rule.borrowQuietMinutes <= 1440));

// Validation errors of a lane list, for the spec validator and validateSuite.
export function validateLanes(lanes, concurrent) {
  const errors = [];
  if (lanes === undefined) return errors;
  if (!Array.isArray(lanes)) return ['lanes must be an array'];
  const names = new Set();
  let reserved = 0;
  lanes.forEach((rule, index) => {
    if (!validRule(rule)) { errors.push(`lanes[${index}]: invalid rule`); return; }
    if (rule.match !== undefined) { try { new RegExp(rule.match); } catch { errors.push(`lanes[${index}].match: invalid pattern`); } }
    if (rule.reservedConcurrent !== undefined) {
      if (names.has(rule.lane)) errors.push(`lanes[${index}].reservedConcurrent: declare the reservation on the lane's first rule`);
      reserved += rule.reservedConcurrent;
    }
    if (rule.borrowable !== undefined) {
      if (rule.reservedConcurrent === undefined) errors.push(`lanes[${index}].borrowable: only a reserved lane lends slots`);
      else if (rule.borrowable > rule.reservedConcurrent) errors.push(`lanes[${index}].borrowable: ${rule.borrowable} exceeds the reservation ${rule.reservedConcurrent}`);
    } else if (rule.borrowQuietMinutes !== undefined) errors.push(`lanes[${index}].borrowQuietMinutes: needs borrowable`);
    names.add(rule.lane);
  });
  if (Number.isSafeInteger(concurrent) && reserved > concurrent) errors.push(`lanes: reserved ${reserved} exceeds the pool cap ${concurrent}`);
  return errors;
}

export function laneRules(config) {
  const lanes = config?.lanes;
  return Array.isArray(lanes) && !validateLanes(lanes, config?.caps?.concurrent).length ? lanes : [];
}

const compiled = new Map();
const pattern = source => {
  let regexp = compiled.get(source);
  if (!regexp) { regexp = new RegExp(source); compiled.set(source, regexp); }
  return regexp;
};

// The lane fields of a job from its run name, or {} when nothing matches.
export function laneFor(config, { runName, workflowPath } = {}) {
  if (typeof runName !== 'string' || !runName) return {};
  for (const rule of laneRules(config)) {
    if (rule.workflowPath !== undefined && rule.workflowPath !== workflowPath) continue;
    if (rule.runNamePrefix !== undefined && !runName.startsWith(rule.runNamePrefix)) continue;
    if (rule.match !== undefined && !pattern(rule.match).test(runName)) continue;
    return { lane: rule.lane, lanePriority: rule.priority, ...(rule.maxParallel === undefined ? {} : { laneMaxParallel: rule.maxParallel }) };
  }
  return {};
}

// Reserved slots per lane: { release: 12 }.
export function reservedByLane(config) {
  const reserved = {};
  for (const rule of laneRules(config)) if (rule.reservedConcurrent !== undefined && !(rule.lane in reserved)) reserved[rule.lane] = rule.reservedConcurrent;
  return reserved;
}

export function lanePriorityOf(job) {
  return Number.isSafeInteger(job?.lanePriority) && job.lanePriority >= 0 ? job.lanePriority : LANE_MAX_PRIORITY + 1;
}

// Effective priority after aging: one level per LANE_AGING_MS queued, never below 0.
export function laneRank(job, now) {
  const queuedAt = job?.queuedAt;
  const aged = Number.isFinite(queuedAt) && Number.isFinite(now) && now > queuedAt ? Math.floor((now - queuedAt) / LANE_AGING_MS) : 0;
  return Math.max(0, lanePriorityOf(job) - aged);
}

// A unit without an id (every create) ties on the id, so pending creates keep their account-queue
// order among themselves and a job of the same rank and age never sorts before a create (the old
// `String(id).localeCompare('undefined')` made every job sort first; review R1 F1).
const idOrder = (a, b) => a === undefined || b === undefined ? 0 : typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b));

// (lane rank, queuedAt, id). With lanes off the rank is constant and the order is the old FIFO.
export function laneComparator(now, enabled = true) {
  return (a, b) => (enabled ? laneRank(a, now) - laneRank(b, now) : 0) || a.queuedAt - b.queuedAt || idOrder(a.id, b.id);
}

// Whether a pending create gives its slot to a candidate job: the create sorts after the job, or on a
// full tie the create holds the place of a job with a higher id (`orderJobId`, an ordering hint only:
// the create is bound to no job, GitHub assigns the runner). The outcome is the same on every tick.
export function createYieldsTo(job, create, byLane) {
  return (byLane(job, create) || idOrder(job.id, create.orderJobId)) < 0;
}

// Whether the lane ordering, reservation and per-lane caps apply: the project declares lanes and the
// runtime switch is not off. `storage` is the project's storage.
export async function lanesSwitchOn(storage, config) {
  if (!laneRules(config).length) return false;
  return (await storage.get(LANES_SWITCH_KEY))?.mode !== 'off';
}

export function sortByLane(jobs, now, enabled = true) {
  return [...jobs].sort(laneComparator(now, enabled));
}

// Borrowing terms per reserved lane: { release: { borrowable: 8, quietMs: 600000 } }. A lane without
// `borrowable` lends nothing.
export function borrowableByLane(config) {
  const terms = {};
  for (const rule of laneRules(config)) {
    if (rule.reservedConcurrent === undefined || rule.borrowable === undefined || rule.lane in terms) continue;
    terms[rule.lane] = { borrowable: Math.min(rule.borrowable, rule.reservedConcurrent), quietMs: (rule.borrowQuietMinutes ?? BORROW_QUIET_MINUTES_DEFAULT) * 60_000 };
  }
  return terms;
}

// The last moment a lane had demand in the job records: `now` while a job of the lane is queued or in
// progress (and not missing from the snapshot); otherwise the latest completion or observation of a
// job of the lane; -Infinity when the records hold no job of the lane.
export function laneDemandAt(jobs, lane, now) {
  let last = -Infinity;
  for (const job of jobs) {
    if (job?.lane !== lane) continue;
    if (['queued', 'in_progress'].includes(job.status) && !job.missing) return now;
    for (const at of [job.completedAt, job.observedAt]) if (Number.isFinite(at) && at > last) last = at;
  }
  return last;
}

// Which reserved slots the other lanes may borrow this tick. `lend` is the count per lane (0 or
// `borrowable`); `lanes` carries the decision per lane for the view and the log.
export function laneLending(config, jobs, now) {
  const lend = {}, lanes = {};
  for (const [lane, terms] of Object.entries(borrowableByLane(config))) {
    const lastDemandAt = laneDemandAt(jobs, lane, now);
    const demand = lastDemandAt === now;
    const quietUntil = Number.isFinite(lastDemandAt) ? lastDemandAt + terms.quietMs : -Infinity;
    const lending = !demand && now >= quietUntil && terms.borrowable > 0;
    lend[lane] = lending ? terms.borrowable : 0;
    lanes[lane] = { borrowable: terms.borrowable, quietMinutes: terms.quietMs / 60_000, lending, reason: demand ? 'demand' : now < quietUntil ? 'recent' : 'quiet',
      lastDemandAt: Number.isFinite(lastDemandAt) ? lastDemandAt : null, quietUntil: !demand && Number.isFinite(quietUntil) && now < quietUntil ? quietUntil : null };
  }
  return { lend, lanes };
}

// Shared-slot arithmetic: the slots the non-reserved lanes hold (units without a reserved lane plus a
// reserved lane's units beyond its effective reservation) against the shared cap (the pool cap minus
// every reservation not on loan).
export function laneShared({ used, cap, reserved, lend = {} }) {
  const total = Object.values(used).reduce((sum, count) => sum + count, 0);
  const effective = name => Math.max(0, reserved[name] - (lend[name] ?? 0));
  const reservedTotal = Object.keys(reserved).reduce((sum, name) => sum + effective(name), 0);
  const reservedUsed = Object.entries(used).filter(([name]) => reserved[name] !== undefined).reduce((sum, [, count]) => sum + count, 0);
  const reservedOverflow = Object.entries(used).filter(([name]) => reserved[name] !== undefined).reduce((sum, [name, count]) => sum + Math.max(0, count - effective(name)), 0);
  const sharedUsed = total - reservedUsed + reservedOverflow;
  const sharedCap = Number.isSafeInteger(cap) ? cap - reservedTotal : Infinity;
  return { total, sharedUsed, sharedCap };
}

// Whether a job of `lane` may take one more slot. `used` counts the boxes and creates per lane
// (`null` for units without a lane); `cap` is the pool cap, `reserved` the per-lane reservation,
// `lend` the reserved slots on loan this tick.
// A reserved lane may use every slot; the other lanes share cap minus every reservation not on loan.
export function laneRoom({ lane, used, cap, reserved, lend = {} }) {
  if (!Number.isSafeInteger(cap)) return true;
  const { total, sharedUsed, sharedCap } = laneShared({ used, cap, reserved, lend });
  if (total >= cap) return false;
  if (lane && reserved[lane] !== undefined) return true;
  return sharedUsed < sharedCap;
}

// The reserved slots the other lanes hold right now, regardless of whether lending is still on: the
// count the lanes view shows as `borrowed`.
export function borrowedSlots({ used, cap, reserved }) {
  if (!Number.isSafeInteger(cap)) return 0;
  const { sharedUsed, sharedCap } = laneShared({ used, cap, reserved });
  const fullReservation = Object.values(reserved).reduce((sum, count) => sum + count, 0);
  return Math.min(fullReservation, Math.max(0, sharedUsed - sharedCap));
}

// Counts the units (boxes not deleted, creates) per lane. A box with a job running on it carries
// the lane of that job, even when the job has none (GitHub hands a box stamped for one lane to any
// runnable job of the label; review R1 B1); a box without a running job carries the lane it was
// created or reserved for.
export function laneUsage(boxes, creates, jobs = []) {
  const used = {};
  const add = lane => { const key = lane ?? 'none'; used[key] = (used[key] ?? 0) + 1; };
  const byRunner = new Map(jobs.filter(job => job.status === 'in_progress' && job.runnerName).map(job => [job.runnerName, job]));
  for (const box of boxes) {
    if (!countsTowardCap(box)) continue;
    const running = box.runnerName ? byRunner.get(box.runnerName) : null;
    add(running ? (running.lane ?? null) : (box.lane ?? null));
  }
  for (const create of creates) add(create.lane ?? null);
  return used;
}

// Per-run parallel cap of a job: the lane's maxParallel when the lane names one and the lane caps
// apply, else the rule's.
export function runMaxParallel(job, rule, laneCaps = true) {
  return laneCaps && Number.isSafeInteger(job?.laneMaxParallel) && job.laneMaxParallel >= 1 ? job.laneMaxParallel : rule.maxParallel;
}

export function runNameKey(runId) { return `${RUN_NAME_PREFIX}${runId}`; }

// Resolves the run name for a webhook event through the per-run cache, then attaches the lane.
// A failed lookup leaves the event without a lane; the next snapshot names it.
export async function attachLane(storage, api, config, event, now) {
  const needsName = laneRules(config).length && !event?.runName;
  const needsPath = !event?.workflowPath && config.workflowConcurrency?.some(rule => rule.workflowPath && event?.jobName?.startsWith(rule.jobPrefix));
  if ((!needsName && !needsPath) || !Number.isSafeInteger(event?.runId)) return event;
  const key = runNameKey(event.runId);
  let cached = await storage.get(key);
  if (!cached || typeof cached.name !== 'string') {
    let name = null;
    let path;
    try {
      const run = await api.getRun({ repo: event.repo, installation: event.installation }, event.runId);
      if (typeof run?.display_title === 'string' && run.display_title.length <= 255) name = run.display_title;
      else if (typeof run?.name === 'string' && run.name.length <= 255) name = run.name;
      // The webhook carries no workflow path; the run does (`path`, sometimes with an `@ref` suffix), so a
      // rule bound to a workflow matches from the first shard instead of waiting for the snapshot.
      if (typeof run?.path === 'string' && run.path.length <= 255) path = run.path.split('@')[0];
    } catch { return event; }
    if (name === null) return event;
    cached = { name, at: now, ...(path ? { path } : {}) };
    await storage.put(key, cached);
  }
  const workflowPath = event.workflowPath ?? cached.path;
  const runName = event.runName ?? cached.name;
  return { ...event, runName, ...(workflowPath ? { workflowPath } : {}), ...laneFor(config, { runName, workflowPath }) };
}
