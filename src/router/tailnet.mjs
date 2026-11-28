// A peek-dev lease is the one lease that carries a Tailnet identity. The router
// mints one ephemeral, preauthorized, single-use auth key for the box, hands it
// over only in the create body's environment, and deletes the device and the key
// when the lease ends. Everything here is pure: URL shapes, request bodies, the
// device match and the retry bound. The HTTP calls live in src/apis.mjs.

export const DEV_KEY_TTL_SECONDS = 300;
export const DEV_TAG = 'tag:boat-dev';
export const DEFAULT_TAILNET = '-';
export const DEFAULT_TAILNET_API_URL = 'https://api.tailscale.com';
export const DEV_ENV_KEYS = Object.freeze(['TAILSCALE_AUTHKEY', 'PEEK_DEV_HOSTNAME']);

const LEASE_ID = /^[a-f0-9-]{36}$/;
const HOSTNAME = /^peek-dev-[a-f0-9]{8}$/;

export function devHostname(leaseId) {
  if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId)) throw new TypeError('invalid dev lease id');
  return `peek-dev-${leaseId.slice(0, 8)}`;
}

export function validDevHostname(hostname) {
  return typeof hostname === 'string' && HOSTNAME.test(hostname);
}

// List the names a preflight must report. The client gate is a configuration
// fact, not a secret, so it rides the same list as the missing variables.
export function missingDevCredentials(env, client) {
  const missing = [];
  if (client?.tailnet !== true) missing.push('client_not_tailnet_enabled');
  if (typeof env?.TAILSCALE_OAUTH_CLIENT_ID !== 'string' || !env.TAILSCALE_OAUTH_CLIENT_ID) missing.push('TAILSCALE_OAUTH_CLIENT_ID');
  if (typeof env?.TAILSCALE_OAUTH_CLIENT_SECRET !== 'string' || !env.TAILSCALE_OAUTH_CLIENT_SECRET) missing.push('TAILSCALE_OAUTH_CLIENT_SECRET');
  return missing;
}

export function oauthForm(env) {
  const clientId = env?.TAILSCALE_OAUTH_CLIENT_ID, clientSecret = env?.TAILSCALE_OAUTH_CLIENT_SECRET;
  if (typeof clientId !== 'string' || !clientId || typeof clientSecret !== 'string' || !clientSecret) throw new TypeError('missing tailscale oauth credentials');
  return new URLSearchParams({ client_id: clientId, client_secret: clientSecret }).toString();
}

export function tailnetName(env) {
  const value = env?.TAILSCALE_TAILNET;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_TAILNET;
}

// Only an explicit https origin is accepted: the environment must never turn
// the OAuth exchange into a plaintext or schemeless request.
export function tailnetApiUrl(env) {
  const value = env?.TAILSCALE_API_URL;
  if (value === undefined || value === null || value === '') return DEFAULT_TAILNET_API_URL;
  if (typeof value !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(value) || value.endsWith('/')) throw new TypeError('invalid tailscale api url');
  return value;
}

export function keyRequestBody(leaseId) {
  if (typeof leaseId !== 'string' || !LEASE_ID.test(leaseId)) throw new TypeError('invalid dev lease id');
  return {
    capabilities: { devices: { create: { reusable: false, ephemeral: true, preauthorized: true, tags: [DEV_TAG] } } },
    expirySeconds: DEV_KEY_TTL_SECONDS,
    description: `peek-dev ${leaseId}`,
  };
}

// The create environment carries exactly the key and the hostname the box
// should present while joining. Anything else would widen the lease's identity.
export function devCreateEnv(authKey, hostname) {
  if (typeof authKey !== 'string' || !authKey || !validDevHostname(hostname)) throw new TypeError('invalid dev create environment');
  return { TAILSCALE_AUTHKEY: authKey, PEEK_DEV_HOSTNAME: hostname };
}

// Every device the join left behind, matched on the lease's own hostname and
// the Tailscale-suffixed variants it appends when a name collides. Only a
// device carrying the dev tag belongs to this lease.
export function cleanupPlan(hostname, keyId, devices) {
  if (typeof hostname !== 'string' || !hostname) return { deviceIds: [], keyId: typeof keyId === 'string' && keyId ? keyId : null };
  const escaped = hostname.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
  const pattern = new RegExp('^' + escaped + '(-\\d+)?$');
  const deviceIds = (Array.isArray(devices) ? devices : [])
    .filter(device => device && typeof device.id === 'string' && device.id && typeof device.hostname === 'string' && pattern.test(device.hostname) && Array.isArray(device.tags) && device.tags.includes(DEV_TAG))
    .map(device => device.id);
  return { deviceIds: [...new Set(deviceIds)], keyId: typeof keyId === 'string' && keyId ? keyId : null };
}

export function devCleanupKey(client, id) {
  return `dev-cleanup:${client}:${id}`;
}

// Bounded exponential backoff from five seconds up to one hour.
export function devRetryDelayMs(attempts) {
  const count = Number.isSafeInteger(attempts) && attempts > 0 ? attempts : 1;
  return Math.min(60 * 60_000, 5_000 * 2 ** Math.min(count - 1, 10));
}
