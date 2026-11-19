// The box lifecycle as one explicit machine.
//
// A `box:<machineId>` record has one `state` from BOX_STATES. Every write that changes
// `state` goes through `transition(box, event, changes, now)`: the event names the edge,
// TRANSITIONS lists the legal source states and the target, and the function stamps
// `since`, `timing`, `exitReason` and a bounded `history`. A box whose state is not a
// legal source returns null (the box moved on; the caller lost a race and does nothing).
// An unknown event is a programming error and throws.
//
// Every state that can hang has a deadline in DEADLINES; `boxDeadline` turns a record and
// a clock into the timeout event that is due. The reservation of a ready, registering or
// idle box for one queued job (`dispatchJobId`/`dispatchAt`) is a sub-state with one
// expiry, RESERVATION_MS, read through `reservationActive`. A reservation for a shard of a
// max-parallel matrix run (`workflowConcurrency`) names one slot of the run, not one shard: it
// moves to another queued shard of the run (`matrix_retarget`) instead of timing out.
//
// Supply is derived from these records (`boxSupply`), never stored: a box counts for the
// planner only in the states and windows below.

export const NONE = null;
export const STAY = 'stay';

export const BOX_STATES = Object.freeze([
  'booting', 'baseline', 'ready', 'registering', 'idle', 'busy', 'finished', 'resetting',
  'local-fencing', 'local-held', 'quarantined', 'retiring', 'destroying', 'unregister', 'purging', 'deleted',
  'lease-booting', 'lease-baselining', 'lease-fencing', 'lease-resetting', 'leased', 'lease-returning', 'lease-warm',
]);
export const TERMINAL_STATES = Object.freeze(['deleted']);
// Boxes held by an external lease client (lease). They share the record key space with the
// JIT pool but are not pool units: they do not count toward the pool cap or a lane.
export const LEASE_STATES = Object.freeze(['lease-booting', 'lease-baselining', 'lease-fencing', 'lease-resetting', 'leased', 'lease-returning', 'lease-warm']);
// States a box leaves only through the provider or an operator; entering one records `exitReason`.
export const EXIT_STATES = Object.freeze(['quarantined', 'retiring', 'destroying', 'unregister', 'purging', 'deleted']);
const LEAVING_LEASE = ['lease-booting', 'lease-baselining', 'lease-resetting', 'lease-returning', 'leased'];

export const TRANSITIONS = Object.freeze({
  // Entry
  admit: { from: [NONE], to: 'booting' },
  adopt_orphan: { from: [NONE], to: 'quarantined' },
  migrate_legacy: { from: [NONE], to: ['booting', 'baseline', 'idle', 'resetting', 'destroying', 'unregister', 'purging', 'quarantined'] },
  lease_start: { from: [NONE], to: 'lease-booting' },
  // Boot and baseline
  boot_limited: { from: ['booting'], to: STAY },
  boot_resumed: { from: ['booting'], to: STAY },
  boot_done: { from: ['booting'], to: 'ready' },
  baseline_start: { from: ['booting'], to: 'baseline' },
  boot_failed: { from: ['booting'], to: 'destroying' },
  boot_timeout: { from: ['booting'], to: 'destroying' },
  baseline_submitted: { from: ['baseline'], to: STAY },
  baseline_done: { from: ['baseline'], to: 'ready' },
  baseline_failed: { from: ['baseline'], to: 'destroying' },
  baseline_timeout: { from: ['baseline'], to: 'destroying' },
  drain: { from: ['booting', 'baseline', 'ready', 'resetting'], to: 'destroying' },
  // Ready: warm and disconnected
  reserve: { from: ['ready'], to: STAY },
  fresh_health: { from: ['ready'], to: STAY },
  release_reservation: { from: ['ready', 'registering', 'idle'], to: STAY },
  // a reservation for a max-parallel matrix shard moves to another queued shard of the same run.
  matrix_retarget: { from: ['registering', 'idle'], to: STAY },
  cross_size_handoff: { from: ['ready'], to: STAY },
  return_to_origin: { from: ['ready'], to: STAY },
  register: { from: ['ready'], to: 'registering' },
  direct_online: { from: ['ready'], to: 'idle' },
  retire_ready: { from: ['ready'], to: 'destroying' },
  // Registering: JIT runner configured, then started
  runner_registered: { from: ['registering'], to: STAY },
  start: { from: ['registering'], to: 'idle' },
  registration_failed: { from: ['registering'], to: 'quarantined' },
  registration_timeout: { from: ['registering'], to: 'quarantined' },
  reservation_timeout: { from: ['registering', 'idle'], to: 'local-fencing' },
  fence_local: { from: ['registering', 'idle'], to: 'local-fencing' },
  // Idle: runner registered, waiting for GitHub
  observe: { from: ['idle'], to: STAY },
  job_started: { from: ['idle', 'quarantined'], to: 'busy' },
  job_finished: { from: ['idle'], to: 'finished' },
  fence_after_job: { from: ['idle', 'busy'], to: 'retiring' },
  offline_timeout: { from: ['idle'], to: 'retiring' },
  retire_idle: { from: ['idle'], to: 'retiring' },
  retarget: { from: ['idle'], to: 'retiring' },
  retire_direct: { from: ['idle'], to: 'destroying' },
  direct_lease: { from: ['idle'], to: 'busy' },
  lease_fence: { from: ['idle', 'local-held'], to: 'lease-fencing' },
  // Busy: a job runs on the box
  busy_observed: { from: ['busy'], to: STAY },
  runner_gone: { from: ['busy'], to: 'finished' },
  ttl_expired: { from: ['busy'], to: 'destroying' },
  setup_hang: { from: ['busy'], to: 'destroying' },
  direct_release: { from: ['busy'], to: 'finished' },
  // Local fencing: the runner is removed so a mini can take the job
  local_fence_busy: { from: ['local-fencing'], to: 'busy' },
  local_fenced: { from: ['local-fencing'], to: 'local-held' },
  retire_held: { from: ['local-held'], to: 'destroying' },
  release_held: { from: ['local-held'], to: 'finished' },
  // Finished: the job ended; reset or retire
  await_result: { from: ['finished'], to: STAY },
  retire_finished: { from: ['finished'], to: 'destroying' },
  reset_start: { from: ['finished'], to: 'resetting' },
  reset_submitted: { from: ['resetting'], to: STAY },
  reset_done: { from: ['resetting'], to: 'ready' },
  reset_failed: { from: ['resetting'], to: 'destroying' },
  reset_timeout: { from: ['resetting'], to: 'destroying' },
  reuse_off: { from: ['resetting'], to: 'destroying' },
  // Quarantined: the runner state is uncertain
  quarantine_runner_found: { from: ['quarantined'], to: 'retiring' },
  sandbox_missing: { from: ['quarantined'], to: 'deleted' },
  quarantine_release: { from: ['quarantined'], to: 'destroying' },
  quarantine_timeout: { from: ['quarantined'], to: 'destroying' },
  operator_recover: { from: ['quarantined'], to: 'deleted' },
  // Retiring: fencing the runner before the box leaves
  fence_busy: { from: ['retiring'], to: 'busy' },
  fenced_finished: { from: ['retiring'], to: 'finished' },
  fenced_destroy: { from: ['retiring'], to: 'destroying' },
  retire_timeout: { from: ['retiring'], to: STAY },
  // Destroying, unregister, purging: provider cleanup
  destroy_requested: { from: ['destroying'], to: 'purging' },
  destroy_unregister: { from: ['destroying'], to: 'unregister' },
  destroy_timeout: { from: ['destroying'], to: STAY },
  unregistered: { from: ['unregister'], to: 'purging' },
  unregister_timeout: { from: ['unregister'], to: STAY },
  purged: { from: ['purging'], to: 'deleted' },
  purge_timeout: { from: ['purging'], to: STAY },
  // External leases (lease)
  lease_baseline_start: { from: ['lease-booting'], to: 'lease-baselining' },
  lease_process: { from: ['lease-baselining', 'lease-resetting', 'lease-returning'], to: STAY },
  lease_activate: { from: ['lease-booting', 'lease-baselining', 'lease-resetting', 'lease-warm'], to: 'leased' },
  lease_park: { from: ['lease-baselining', 'lease-resetting', 'lease-returning'], to: 'lease-warm' },
  lease_fence_busy: { from: ['lease-fencing'], to: 'busy' },
  lease_reset_start: { from: ['lease-fencing'], to: 'lease-resetting' },
  lease_return: { from: ['leased'], to: 'lease-returning' },
  lease_update: { from: ['leased'], to: STAY },
  lease_destroy: { from: LEAVING_LEASE, to: 'destroying' },
  lease_warm_reclaim: { from: ['lease-warm'], to: 'ready' },
  lease_warm_expire: { from: ['lease-warm'], to: 'destroying' },
});

export const HISTORY_LIMIT = 24;

// Returns the next record, or null when `box` is not in a source state of `event`.
// `options.from` narrows the accepted source to the state the caller observed.
export function transition(box, event, changes = {}, now = Date.now(), options = {}) {
  const rule = TRANSITIONS[event];
  if (!rule) throw new TypeError(`unknown box event: ${event}`);
  const current = box ? box.state : NONE;
  if (options.from !== undefined && current !== options.from) return null;
  if (!rule.from.includes(current)) return null;
  const { state: requested, ...fields } = changes;
  const to = rule.to === STAY ? current : Array.isArray(rule.to) ? requested : rule.to;
  if (Array.isArray(rule.to) && !rule.to.includes(to)) throw new TypeError(`${event} cannot enter ${to}`);
  if (current === NONE && typeof fields.machineId !== 'string') throw new TypeError(`${event} needs a machine id`);
  const base = box ?? {};
  const next = { ...base, ...fields, state: to };
  if ((current === 'busy' && to !== 'busy') || ['reset_start', 'reset_done', 'register', 'start', 'job_started'].includes(event)) next.runnerAbsentSince = null;
  if (to !== current) {
    next.since = Object.hasOwn(fields, 'since') ? fields.since : now;
    next.timing = { ...(base.timing ?? {}), [to]: now };
    next.history = [...(base.history ?? []), { event, from: current, to, at: now }].slice(-HISTORY_LIMIT);
    if (base.stuckAlertedAt !== undefined) next.stuckAlertedAt = null;
    if (EXIT_STATES.includes(to)) next.exitReason = fields.retirementReason ?? fields.failureReason ?? base.retirementReason ?? base.failureReason ?? event;
    else if (base.exitReason !== undefined) next.exitReason = null;
  } else if (EXIT_STATES.includes(to) && (fields.retirementReason || fields.failureReason)) {
    next.exitReason = fields.retirementReason ?? fields.failureReason;
  }
  return next;
}

// Reads the record at `key`, applies the event and writes the result in the caller's store or transaction.
export async function applyTransition(store, key, event, changes = {}, now = Date.now(), options = {}) {
  const box = await store.get(key);
  const next = transition(box ?? NONE, event, changes, now, options);
  if (next) await store.put(key, next);
  return next;
}

// Deadlines for the states that can hang. `clock` names the timestamp the age is measured
// from; `once` means the event only alerts and must not fire again until the state changes.
export const RESERVATION_MS = 180_000;
export const MISSING_RESULT_GRACE_MS = 120_000;
// A busy box whose runner is no longer listed while its job still reads in progress: for this long the
// job list is assumed to lag the runner list (the job just ended); after it the record is stale.
export const RUNNER_GONE_GRACE_MS = 120_000;
export const DEADLINES = Object.freeze({
  booting: { afterMs: 900_000, event: 'boot_timeout', clock: 'boot' },
  baseline: { afterMs: 300_000, event: 'baseline_timeout' },
  registering: { afterMs: 120_000, event: 'registration_timeout' },
  idle: { afterMs: 120_000, event: 'offline_timeout', clock: 'offline' },
  resetting: { afterMs: 300_000, event: 'reset_timeout' },
  quarantined: { afterMs: 3_600_000, event: 'quarantine_timeout' },
  retiring: { afterMs: 600_000, event: 'retire_timeout', once: true },
  destroying: { afterMs: 600_000, event: 'destroy_timeout', once: true },
  unregister: { afterMs: 600_000, event: 'unregister_timeout', once: true },
  purging: { afterMs: 900_000, event: 'purge_timeout', once: true },
});

export function boxDeadline(box, now, { reuseEnabled = true } = {}) {
  if (box.state === 'resetting' && !reuseEnabled) return 'reuse_off';
  const rule = DEADLINES[box.state];
  if (!rule) return null;
  if (rule.once && Number.isFinite(box.stuckAlertedAt)) return null;
  let start = box.since;
  if (rule.clock === 'boot') start = box.since + (box.bootPausedMs ?? 0);
  if (rule.clock === 'offline') {
    if (box.busy || box.online) return null;
    start = box.offlineSince ?? box.startedAt ?? box.since;
  }
  return Number.isFinite(start) && now - start >= rule.afterMs ? rule.event : null;
}

// The reservation sub-state: a ready, registering or idle box holds one queued job for RESERVATION_MS.
export function reservationActive(box, now) {
  return ['ready', 'registering', 'idle'].includes(box?.state) && Number.isSafeInteger(box.dispatchJobId) && Number.isFinite(box.dispatchAt) && now < box.dispatchAt + RESERVATION_MS;
}
export function reservationExpired(box, now) {
  return Number.isFinite(box?.dispatchAt) && now >= box.dispatchAt + RESERVATION_MS;
}

// A JIT pool unit for the concurrency cap: every recorded box except deleted ones and lease boxes.
export function countsTowardCap(box) {
  return box.state !== 'deleted' && !LEASE_STATES.includes(box.state);
}

// Supply windows: a box is supply for the planner only in these states and for these times.
export const SUPPLY_WINDOWS = Object.freeze({ bootSoftSeconds: 300, registerSeconds: 120, resetSoftSeconds: 120, onlineGraceSeconds: 120, createSoftSeconds: 120 });

export function boxSupply(unit, now, cfg = {}) {
  const seconds = key => (cfg[key] ?? SUPPLY_WINDOWS[key]) * 1000;
  const within = (at, ms) => Number.isFinite(at) && now < at + ms;
  switch (unit.state) {
    case 'booting': case 'baseline': return within(unit.since, seconds('bootSoftSeconds'));
    case 'ready': return true;
    case 'registering': return within(unit.since, seconds('registerSeconds'));
    case 'resetting': return within(unit.since, seconds('resetSoftSeconds'));
    // A reusable box whose job has ended resets in the next ticks and covers the next queued
    // job; a stale record (runner gone for longer than RUNNER_GONE_GRACE_MS, no job result) is not.
    case 'busy': case 'finished': return unit.resetPending === true;
    case 'idle': return !unit.busy && (unit.online === true || (!unit.everOnline && within(unit.startedAt ?? unit.since, seconds('onlineGraceSeconds'))));
    default: return false;
  }
}

// Graph helpers for the property tests and for operators.
export function edges() {
  const list = [];
  for (const [event, rule] of Object.entries(TRANSITIONS)) {
    for (const from of rule.from) {
      const targets = rule.to === STAY ? [from] : Array.isArray(rule.to) ? rule.to : [rule.to];
      for (const to of targets) list.push({ event, from, to });
    }
  }
  return list;
}
