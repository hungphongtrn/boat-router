const STATES = new Set(['starting', 'pending', 'ready', 'idle', 'running', 'error', 'cancelled', 'archived', 'stopped']);
const SETUP_STATES = new Set(['pending', 'starting', 'running', 'done', 'failed', 'cancelled']);
export const PHASES = new Set(['apt_update', 'apt_install', 'actions_apt_install', 'node_toolcache', 'ffmpeg_download', 'docker_ready', 'git_download', 'powershell_download', 'shellcheck_download', 'runner_download', 'ready', 'reuse_helper_download', 'reuse_helper_check', 'snapshot_verify', 'snapshot_tailnet', 'snapshot_helper']);
export const SETUP_ERROR_CATEGORIES = new Set(['unknown', 'download_http_5xx', 'download_http_4xx', 'download_rate_limited', 'download_network', 'download_timeout', 'checksum_mismatch', 'apt_network', 'apt_integrity', 'apt_lock', 'command_missing', 'docker_not_ready', 'provider_limited']);
const CATEGORIES = new Map([
  ['RATE_LIMITED', 'rate_limited'], ['RATE_LIMIT', 'rate_limited'], ['TOO_MANY_REQUESTS', 'rate_limited'],
  ['RESOURCE_EXHAUSTED', 'rate_limited'], ['QUOTA_EXCEEDED', 'rate_limited'], ['LIMIT_EXCEEDED', 'rate_limited'], ['429', 'rate_limited'],
  ['TIMEOUT', 'timeout'], ['TIMED_OUT', 'timeout'], ['DEADLINE_EXCEEDED', 'timeout'],
  ['NETWORK_ERROR', 'network'], ['NETWORK_UNAVAILABLE', 'network'], ['CONNECTION_RESET', 'network'],
  ['CONNECTION_REFUSED', 'network'], ['TEMPORARY_FAILURE', 'unavailable'], ['SERVICE_UNAVAILABLE', 'unavailable'],
  ['UNAVAILABLE', 'unavailable'], ['INTERNAL_ERROR', 'unavailable'],
  ['INVALID_ARGUMENT', 'configuration'], ['INVALID_CONFIG', 'configuration'], ['CONFIGURATION_ERROR', 'configuration'],
  ['CHECKSUM_MISMATCH', 'integrity'], ['INTEGRITY_ERROR', 'integrity'],
]);
const TRANSIENT = new Set(['timeout', 'network', 'unavailable']);
// Output-derived categories that a fresh box is likely to get past.
const TRANSIENT_SETUP = new Set(['download_http_5xx', 'download_rate_limited', 'download_network', 'download_timeout', 'apt_network', 'apt_lock', 'docker_not_ready']);
export const LINE_LIMIT = 200;

function codeOf(value) {
  if (value && typeof value === 'object') value = value.code ?? value.errorCode ?? value.statusCode ?? value.status ?? value.type;
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || value.length > 80 || !/^[A-Za-z0-9_ -]+$/.test(value)) return null;
  return value.trim().toUpperCase().replace(/[ -]+/g, '_');
}

export function setupProviderFields(value) {
  const sandbox = value?.sandbox ?? value ?? {};
  const categories = [sandbox.setupError, sandbox.error, sandbox.errorCode, sandbox.setupErrorCode]
    .map(codeOf).map(code => CATEGORIES.get(code));
  const category = ['rate_limited', 'integrity', 'configuration'].find(item => categories.includes(item)) ?? categories.find(Boolean) ?? 'unknown';
  return {
    state: STATES.has(sandbox.state) ? sandbox.state : 'unknown',
    setupStatus: SETUP_STATES.has(sandbox.setupStatus) ? sandbox.setupStatus : 'unknown',
    providerErrorCategory: category,
    retryEligible: TRANSIENT.has(category),
  };
}

// Raw setup output is untrusted. A line is kept in a bounded, printable form with
// every secret-shaped value replaced: bearer and basic credentials, env-style
// assignments whose name suggests a secret, URL userinfo and query strings, known
// token formats, and any long opaque token-like run. Our fixed phase markers are
// returned verbatim; everything else is text that has been through this filter,
// so the result is safe to store, list and relay to an operator.
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASS(?:WORD|WD|PHRASE)?|CREDENTIAL|AUTH|JIT|COOKIE|SESSION|SIGNATURE|PRIVATE)[A-Za-z0-9_]*)\s*[=:]\s*\S.*$/i;
export function sanitizeSetupLine(value) {
  if (typeof value !== 'string') return '[redacted]';
  const match = /^BOAT_SETUP_PHASE ([a-z_]+)$/.exec(value);
  if (match && PHASES.has(match[1])) return `BOAT_SETUP_PHASE ${match[1]}`;
  let line = value.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!line) return '';
  line = line
    .replace(/\b(Bearer|Basic|token|Token)\s+[A-Za-z0-9_\-+/=.]{8,}/g, '$1 [redacted]')
    .replace(SECRET_ASSIGNMENT, '$1=[redacted]')
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s?#]*)\?[^\s]*/gi, '$1?[redacted]')
    .replace(/\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/g, '[redacted]')
    .replace(/\bAKIA[0-9A-Z]{12,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{5,})?/g, '[redacted]')
    .replace(/(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}(?![A-Za-z0-9_-])/g, '[redacted]');
  if (line.length > LINE_LIMIT) line = `${line.slice(0, LINE_LIMIT - 3)}...`;
  return line;
}

export function setupOutputTail(value, limit = 20) {
  const raw = typeof value === 'string' || Array.isArray(value) ? value : value?.lines ?? value?.logs ?? value?.output;
  let lines;
  if (typeof raw === 'string') lines = raw.slice(-65_536).split(/\r?\n/);
  else if (Array.isArray(raw)) lines = raw.slice(-limit).map(line => typeof line === 'string' ? line : line?.message);
  else return null;
  if (lines.at(-1) === '') lines.pop();
  return lines.slice(-limit).map(sanitizeSetupLine);
}

// The last phase marker in the output. The bootstrap prints the markers to
// stderr too, because the provider's setupError carries only stderr.
export function setupPhase(lines) {
  let phase = 'unknown';
  for (const line of Array.isArray(lines) ? lines : []) {
    const marker = typeof line === 'string' && (/^BOAT_SETUP_PHASE ([a-z_]+)$/.exec(line) ?? /^BOAT_SETUP_FAILED phase=([a-z_]+)\b/.exec(line));
    if (marker && PHASES.has(marker[1])) phase = marker[1];
  }
  return phase;
}

export function setupExitCode(lines) {
  for (const line of Array.isArray(lines) ? lines : []) {
    const match = typeof line === 'string' && (/^exit code (\d{1,3})\b/.exec(line) ?? /^BOAT_SETUP_FAILED phase=[a-z_]+ status=(\d{1,3})\b/.exec(line));
    if (match && Number(match[1]) <= 255) return Number(match[1]);
  }
  return null;
}

// Classifies sanitized output lines. Only fixed vocabulary leaves this function.
export function setupErrorCategory(lines) {
  const text = (Array.isArray(lines) ? lines : []).filter(line => typeof line === 'string');
  const test = pattern => text.some(line => pattern.test(line));
  if (test(/hash sum mismatch/i)) return 'apt_integrity';
  if (test(/sha256sum: WARNING|: FAILED$|checksum mismatch/i)) return 'checksum_mismatch';
  if (test(/curl: \(22\).*(?:429|too many requests)/i)) return 'download_rate_limited';
  if (test(/curl: \(22\).*\b5\d\d\b/)) return 'download_http_5xx';
  if (test(/curl: \(22\).*\b4\d\d\b/)) return 'download_http_4xx';
  if (test(/curl: \(28\)/)) return 'download_timeout';
  if (test(/curl: \((?:5|6|7|18|35|52|55|56)\)/)) return 'download_network';
  if (test(/temporary failure resolving|could not resolve/i)) return 'apt_network';
  if (test(/could not get lock/i)) return 'apt_lock';
  if (test(/docker (?:daemon|info)|Cannot connect to the Docker daemon|BOAT_SETUP_FAILED phase=docker_ready/i)) return 'docker_not_ready';
  if (test(/command not found|No such file or directory/i)) return 'command_missing';
  return 'unknown';
}

export function setupRetryEligible(category) {
  return TRANSIENT_SETUP.has(category);
}

export function setupCaptureStatus(error) {
  if ([403, 404, 409, 429].includes(error?.status)) return `http_${error.status}`;
  if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 600) return 'http_other';
  return 'unavailable';
}
