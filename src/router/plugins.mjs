import { validateLanes } from './lanes.mjs';
export const HOOKS = Object.freeze(['selectEvent', 'plan', 'classifyResult', 'triage', 'riskTier', 'resolveConflict', 'prepareMachine', 'publishGate', 'notice']);
const ids = /^[a-z0-9][a-z0-9-]{0,62}$/;
const repo = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateSuite(config, hooks = {}) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) return ['suite must be an object'];
  if (!ids.test(config.id ?? '')) errors.push('invalid suite id');
  if (!repo.test(config.repo ?? '')) errors.push('invalid repository');
  if (!ids.test(config.account ?? '')) errors.push('invalid account');
  if (config.machineTtlSeconds !== undefined && (!Number.isSafeInteger(config.machineTtlSeconds) || config.machineTtlSeconds < 300 || config.machineTtlSeconds > 86400)) errors.push('invalid machine TTL');
  if (config.liveness !== undefined && typeof config.liveness?.enabled !== 'boolean') errors.push('invalid liveness switch');
  if (config.dispatchOnly !== undefined && typeof config.dispatchOnly !== 'boolean') errors.push('invalid dispatch-only switch');
  if (config.poolModeDefault !== undefined && config.poolModeDefault !== 'on') errors.push('invalid pool mode default');
  if (config.installation !== undefined && (!Number.isSafeInteger(config.installation) || config.installation < 1)) errors.push('invalid installation');
  for (const local of [config.localFirst, config.externalClaimer]) if (local !== undefined) {
    if (!local || typeof local.enabled !== 'boolean' || !local.labels || typeof local.labels !== 'object' || Array.isArray(local.labels) || Object.entries(local.labels).some(([label, kind]) => !config.labels?.includes(label) || typeof kind !== 'string' || !kind) || [local.offerSeconds ?? 30, local.claimSeconds ?? 900, local.retireAlertSeconds ?? 300].some(value => !Number.isSafeInteger(value) || value < 1 || value > 86400)) errors.push('invalid local first config');
    if (local?.holdWarmOnLocal !== undefined && typeof local.holdWarmOnLocal !== 'boolean' || local?.capacitySeconds !== undefined && (!Number.isSafeInteger(local.capacitySeconds) || local.capacitySeconds < 1 || local.capacitySeconds > 600)) errors.push('invalid local capacity config');
    if (local?.registeredHoldSeconds !== undefined && (!Number.isSafeInteger(local.registeredHoldSeconds) || local.registeredHoldSeconds < 0 || local.registeredHoldSeconds > 180)) errors.push('invalid registered local hold');
  }
  if (config.localFirst?.localOnly !== undefined && (config.localFirst.enabled !== true || !Array.isArray(config.localFirst.localOnly) || config.localFirst.localOnly.some(label => !config.localFirst.labels?.[label]))) errors.push('invalid local only labels');
  if (!['on', 'off'].includes(config.reuse?.mode)) errors.push('invalid reuse mode');
  if (config.dockerAccess === true && config.reuse?.mode === 'on' && config.reuse?.docker !== true) errors.push('reuse with docker access needs the Docker reset (reuse.docker)');
  if (config.reuse?.docker !== undefined && (typeof config.reuse.docker !== 'boolean' || (config.reuse.docker && config.dockerAccess !== true))) errors.push('invalid docker reuse');
  if (config.setupWatchdog !== undefined && (!config.setupWatchdog || typeof config.setupWatchdog.enabled !== 'boolean' || !Number.isSafeInteger(config.setupWatchdog.minutes) || config.setupWatchdog.minutes < 1 || config.setupWatchdog.minutes > 60)) errors.push('invalid setup watchdog');
  if (config.lanes !== undefined && validateLanes(config.lanes, config.caps?.concurrent).length) errors.push('invalid lanes');
  if (config.dockerAccess !== undefined && typeof config.dockerAccess !== 'boolean') errors.push('invalid docker access');
  if (config.reuse?.maxJobs !== undefined && (!Number.isSafeInteger(config.reuse.maxJobs) || config.reuse.maxJobs < 1)) errors.push('invalid maximum jobs');
  if (config.reuse?.maxAgeSeconds !== undefined && (!Number.isSafeInteger(config.reuse.maxAgeSeconds) || config.reuse.maxAgeSeconds < 1)) errors.push('invalid maximum age');
  if (config.reuse?.idleHoldSeconds !== undefined && (!Number.isSafeInteger(config.reuse.idleHoldSeconds) || config.reuse.idleHoldSeconds < 0)) errors.push('invalid idle hold');
  for (const floor of [config.reuse?.diskFloorKiB, config.reuse?.homeDiskFloorKiB]) if (floor !== undefined && (!floor || typeof floor !== 'object' || Array.isArray(floor) || Object.entries(floor).some(([size, value]) => !['small', 'default', 'large', 'xlarge'].includes(size) || !Number.isSafeInteger(value) || value < 4194304))) errors.push('invalid disk floor');
  if (!Array.isArray(config.labels) || config.labels.some(x => typeof x !== 'string' || !x)) errors.push('invalid labels');
  // Boat labels: extra runs-on labels every Boat runner of the tenant registers with; never a pool or size label.
  if (config.boatLabels !== undefined && (!Array.isArray(config.boatLabels) || new Set(config.boatLabels).size !== config.boatLabels.length || config.boatLabels.some(x => typeof x !== 'string' || !ids.test(x) || x.startsWith('boat-size-') || config.labels?.includes(x)))) errors.push('invalid boat labels');
  if (!config.jobs || typeof config.jobs !== 'object' || Array.isArray(config.jobs)) errors.push('invalid jobs');
  if (!config.landing || !['runner', 'land-first', 'candidate-queue'].includes(config.landing.engine)) errors.push('invalid landing engine');
  const policies = config.landing?.candidateQueue?.policies;
  if (policies !== undefined && (!Array.isArray(policies) || policies.some(sha => typeof sha !== 'string' || !/^[a-f0-9]{40}$/.test(sha)))) errors.push('invalid workflow policy hashes');
  if (config.caps?.startsPerDay != null && (!Number.isSafeInteger(config.caps.startsPerDay) || config.caps.startsPerDay < 1)) errors.push('invalid project day cap');
  for (const [name, hook] of Object.entries(hooks)) {
    if (!HOOKS.includes(name) || typeof hook !== 'function') errors.push(`invalid hook ${name}`);
  }
  return errors;
}
