// A leased box is our own disk reached through Boat, so the client's network
// policy is part of its configuration: only the registries a build needs may be
// reached, and inbound stays Boat-only so nothing from the internet reaches a
// box that runs a client's commands. Validation is pure; the caller passes the
// normalized value into the provider create body and reports the mode in a claim.
export const NETWORK_MODES = Object.freeze(['allow', 'deny', 'open']);
export const NETWORK_ALLOW_MAX = 100;
// Domains (a leading '*' is a wildcard), optional CIDR suffix, no scheme or path.
const ENTRY = /^(?:\*\.)?[a-z0-9](?:[a-z0-9.-]{0,249}[a-z0-9])?(?:\/\d{1,3})?$/;

export function normalizeNetwork(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid network');
  if (Object.keys(value).some(key => !['mode', 'allow', 'inbound'].includes(key))) throw new TypeError('invalid network field');
  if (!NETWORK_MODES.includes(value.mode)) throw new TypeError('invalid network mode');
  const allow = value.allow ?? [];
  if (!Array.isArray(allow) || allow.length > NETWORK_ALLOW_MAX) throw new TypeError('invalid network allow');
  for (const entry of allow) {
    if (typeof entry !== 'string' || entry.length > 253 || !ENTRY.test(entry)) throw new TypeError('invalid network allow entry');
  }
  const inbound = value.inbound ?? null;
  if (inbound !== null && inbound !== 'boat-only') throw new TypeError('invalid network inbound');
  return { mode: value.mode, allow: [...allow], ...(inbound ? { inbound } : {}) };
}

// The claim response names the policy a client's leases are created with, never
// the allow list: a client already knows what its own configuration allows.
export function networkSummary(value) {
  const network = normalizeNetwork(value);
  return network ? { mode: network.mode, inbound: network.inbound ?? null } : null;
}
