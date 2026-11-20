// A definite GitHub refusal before a runner id was saved is not an uncertain
// start. Require a later complete snapshot and a short reconciliation window;
// never release capacity just because the planner cannot use the box.
const REJECTED = new Set([400, 401, 403, 404, 422]);
export function registrationRejected(error, box) {
  return !box?.runnerId && error?.service === 'github' && REJECTED.has(error.status);
}

export async function rejectedRegistrationAbsent(storage, box, snapshot, now) {
  if (box.orphan || box.runnerId || box.failureReason !== 'registration_uncertain' || snapshot.complete !== true || !Number.isFinite(snapshot.at) || snapshot.at < box.since || now - box.since < 120_000) return false;
  if ((snapshot.runners ?? []).some(runner => runner.name === box.runnerName) || (snapshot.jobs ?? []).some(job => job.status === 'in_progress' && job.runnerName === box.runnerName)) return false;
  if (box.registrationRejected === true) return true;
  // Recover pre-fix records from their durable, generation-specific evidence.
  const failure = await storage.get(`verification:attempt:failure:${box.machineId}:${box.generation}`);
  if (failure?.kind !== 'registration_uncertain' || failure.phase !== 'registering' || failure.at > box.since) return false;
  try { return registrationRejected(JSON.parse(failure.message), box); }
  catch { return false; }
}
