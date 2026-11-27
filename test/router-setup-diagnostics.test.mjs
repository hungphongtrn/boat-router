import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { APIs } from '../src/apis.mjs';
import { bootstrap } from '../src/bootstrap.mjs';
import { reuseBootstrap } from '../src/refresh.mjs';
import { setupOutputTail, setupProviderFields, sanitizeSetupLine, setupErrorCategory, setupPhase, setupExitCode, LINE_LIMIT } from '../src/router/setup-diagnostics.mjs';

const respond = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// The provider's setupError for a box that failed on a GitHub 504 ('s
// diagnostic box, plain bootstrap), with the markers the new bootstrap adds.
const DOWNLOAD_504 = [
  'exit code 22: sessions running outdated binaries:',
  ' user @ user manager service: gvfsd[2090], systemd[1385]',
  'BOAT_SETUP_PHASE git_download',
  'BOAT_SETUP_PHASE powershell_download',
  'curl: (22) The requested URL returned error: 504',
  'curl: (22) The requested URL returned error: 504',
  'BOAT_SETUP_FAILED phase=powershell_download status=22 line=88',
].join('\n');

test('setup output tail keeps sanitized lines, fixed phase markers and bounds the output', () => {
  const lines = Array.from({ length: 25 }, (_, n) => `untrusted line ${n}`);
  lines.push('BOAT_SETUP_PHASE apt_update', 'SECRET=example', 'BOAT_SETUP_PHASE fake', 'Authorization: Bearer example-token-value');
  const tail = setupOutputTail({ logs: lines });
  assert.equal(tail.length, 20);
  assert.deepEqual(tail.slice(-4), ['BOAT_SETUP_PHASE apt_update', 'SECRET=[redacted]', 'BOAT_SETUP_PHASE fake', 'Authorization=[redacted]']);
  assert.equal(tail[0], 'untrusted line 9');
  assert.equal(setupOutputTail({ other: 'untrusted' }), null);
  assert.deepEqual(setupOutputTail('temporary failure resolving example.invalid\nHash Sum mismatch\nCould not get lock'), ['temporary failure resolving example.invalid', 'Hash Sum mismatch', 'Could not get lock']);
});

test('secret-shaped values are redacted but the line around them survives', () => {
  const token = 'ghp_' + 'A1b2'.repeat(10);
  const cases = [
    [`curl: (22) The requested URL returned error: 504`, `curl: (22) The requested URL returned error: 504`],
    [`Authorization: Bearer ${token}`, 'Authorization=[redacted]'],
    [`export GITHUB_TOKEN=${token}`, 'export GITHUB_TOKEN=[redacted]'],
    [`api_key: ${token} trailing`, 'api_key=[redacted]'],
    [`fetching https://user:${token}@example.com/a/b?sig=${token}#frag`, 'fetching https://[redacted]@example.com/a/b?[redacted]'],
    [`downloaded https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/powershell-7.6.7-linux-x64.tar.gz`, 'downloaded https://github.com/PowerShell/PowerShell/releases/download/v7.6.7/powershell-7.6.7-linux-x64.tar.gz'],
    [`found ${token} in output`, 'found [redacted] in output'],
    [`sha256 6238a37c11c1bd4b18a5194f766ccfcb2f26c116e7d8ecd07bac143863b69498 ok`, 'sha256 [redacted] ok'],
    [`AWS AKIAIOSFODNN7EXAMPLE used`, 'AWS [redacted] used'],
    [`jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefgh1234`, 'jwt [redacted]'],
    ['\x1b[31mred\x1b[0m text\twith\u0000control', 'red text with control'],
    ['BOAT_SETUP_PHASE runner_download', 'BOAT_SETUP_PHASE runner_download'],
    ['BOAT_SETUP_PHASE ../etc', 'BOAT_SETUP_PHASE ../etc'],
  ];
  for (const [input, expected] of cases) assert.equal(sanitizeSetupLine(input), expected, input);
  assert.equal(sanitizeSetupLine(42), '[redacted]');
  const long = sanitizeSetupLine('x'.repeat(LINE_LIMIT * 2));
  assert.equal(long.length, LINE_LIMIT);
  assert.ok(long.endsWith('...'));
  for (const [input] of cases) assert.equal(sanitizeSetupLine(sanitizeSetupLine(input)), sanitizeSetupLine(input), 'idempotent: ' + input);
});

test('output is classified into fixed categories, with the last phase and the exit code', () => {
  const tail = setupOutputTail(DOWNLOAD_504);
  assert.equal(setupErrorCategory(tail), 'download_http_5xx');
  assert.equal(setupPhase(tail), 'powershell_download');
  assert.equal(setupExitCode(tail), 22);
  assert.equal(setupErrorCategory(['curl: (22) The requested URL returned error: 429']), 'download_rate_limited');
  assert.equal(setupErrorCategory(['curl: (22) The requested URL returned error: 404']), 'download_http_4xx');
  assert.equal(setupErrorCategory(['curl: (28) Operation timed out after 300000 milliseconds']), 'download_timeout');
  assert.equal(setupErrorCategory(['curl: (6) Could not resolve host: github.com']), 'download_network');
  assert.equal(setupErrorCategory(['/home/user/.boat-ci/powershell.tar.gz: FAILED', 'sha256sum: WARNING: 1 computed checksum did NOT match']), 'checksum_mismatch');
  assert.equal(setupErrorCategory(['E: Failed to fetch http://archive.ubuntu.com/x  Hash Sum mismatch']), 'apt_integrity');
  assert.equal(setupErrorCategory(['W: Failed to fetch http://archive.ubuntu.com/x  Temporary failure resolving \'archive.ubuntu.com\'']), 'apt_network');
  assert.equal(setupErrorCategory(['E: Could not get lock /var/lib/dpkg/lock-frontend']), 'apt_lock');
  assert.equal(setupErrorCategory(['bash: line 70: google-chrome: command not found']), 'command_missing');
  assert.equal(setupErrorCategory(['BOAT_SETUP_PHASE docker_ready', 'BOAT_SETUP_FAILED phase=docker_ready status=124 line=70']), 'docker_not_ready');
  assert.equal(setupErrorCategory(['[redacted]']), 'unknown');
  assert.equal(setupErrorCategory(null), 'unknown');
  assert.equal(setupPhase(['BOAT_SETUP_PHASE apt_update', 'BOAT_SETUP_PHASE fake']), 'apt_update');
  assert.equal(setupPhase(['BOAT_SETUP_FAILED phase=start status=1 line=5']), 'unknown');
  assert.equal(setupExitCode(['exit code 999: x']), null);
});

test('known transient setup failures are eligible, quota is a hold and unknown is not retried', () => {
  assert.equal(setupProviderFields({ setupError: { code: 'NETWORK_ERROR' } }).retryEligible, true);
  assert.deepEqual(setupProviderFields({ state: 'error', setupStatus: 'failed', setupError: { code: 'NETWORK_ERROR' }, error: { code: 'QUOTA_EXCEEDED' } }),
    { state: 'error', setupStatus: 'failed', providerErrorCategory: 'rate_limited', retryEligible: false });
  assert.equal(setupProviderFields({ setupError: { code: 'CHECKSUM_MISMATCH' } }).retryEligible, false);
  assert.equal(setupProviderFields({ setupError: { code: 'NETWORK_ERROR' }, error: { code: 'CHECKSUM_MISMATCH' } }).retryEligible, false);
  assert.equal(setupProviderFields({ setupError: 'unrecognized value' }).retryEligible, false);
});

test('capture uses the observed sandbox setup error before deletion', async () => {
  const paths = [];
  const api = new APIs({}, async url => { paths.push(url); return respond(403, { error: 'untrusted body' }); });
  const got = await api.setupDiagnostics({ machineId: 'bx_test' }, { sandbox: { state: 'error', setupStatus: 'failed', setupError: { code: 'RATE_LIMITED' } } });
  assert.deepEqual(got, { state: 'error', setupStatus: 'failed', providerErrorCategory: 'rate_limited', retryEligible: false, captureStatus: 'unavailable', setupOutput: [], setupErrorCategory: 'unknown', setupPhase: 'unknown' });
  assert.deepEqual(paths, []);
});

test('a GitHub 504 on a release download is recorded with its category, phase, exit code and lines, and is retried', async () => {
  const api = new APIs({}, async () => respond(200, { sandbox: { state: 'idle', setupStatus: 'failed', setupError: DOWNLOAD_504 } }));
  const got = await api.setupDiagnostics({ machineId: 'bx_test' }, null);
  assert.equal(got.providerErrorCategory, 'unknown');
  assert.equal(got.setupErrorCategory, 'download_http_5xx');
  assert.equal(got.setupPhase, 'powershell_download');
  assert.equal(got.exitCode, 22);
  assert.equal(got.retryEligible, true);
  assert.equal(got.captureStatus, 'ok');
  assert.deepEqual(got.setupOutput.slice(-3), ['curl: (22) The requested URL returned error: 504', 'curl: (22) The requested URL returned error: 504', 'BOAT_SETUP_FAILED phase=powershell_download status=22 line=88']);
});

test('available log data is sanitized and malformed data is marked', async () => {
  let api = new APIs({}, async () => respond(200, { sandbox: { setupError: 'BOAT_SETUP_PHASE apt_install\nA_TOKEN=example' } }));
  let got = await api.setupDiagnostics({ machineId: 'bx_test' }, null);
  assert.deepEqual(got.setupOutput, ['BOAT_SETUP_PHASE apt_install', 'A_TOKEN=[redacted]']);
  assert.equal(got.captureStatus, 'ok');
  assert.equal(got.setupPhase, 'apt_install');
  got = await api.setupDiagnostics({ machineId: 'bx_test' }, {});
  assert.equal(got.captureStatus, 'unavailable');
  got = await api.setupDiagnostics({ machineId: 'bx_test' }, { setupError: 'BOAT_SETUP_PHASE docker_ready\nAPI_KEY=example\n' });
  assert.deepEqual(got.setupOutput, ['BOAT_SETUP_PHASE docker_ready', 'API_KEY=[redacted]']);
});

test('apt retry is bounded to fetches and both update and install carry retry settings', () => {
  const script = bootstrap();
  assert.match(script, /apt-get -o Acquire::Retries=3 -o Acquire::AllowReleaseinfoChange=true -o APT::Update::Error-Mode=any update/);
  assert.match(script, /apt-get -o Acquire::Retries=3 install/);
  assert.match(script, /BOAT_SETUP_PHASE %s/);
  assert.match(script, /^phase apt_update$/m);
  assert.match(script, /^phase apt_install$/m);
});

test('release downloads retry for a minute on any error, including HTTP 5xx', () => {
  for (const script of [bootstrap(), reuseBootstrap()]) {
    assert.match(script, /curl --fail --location --silent --show-error --retry 6 --retry-delay 10 --retry-all-errors --max-time 300 "\$1" -o "\$3"/);
    assert.doesNotMatch(script, /--retry 3 /);
  }
});

test('the bootstrap prints phase markers to stderr and names the failing phase on the last stderr line', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'boat-bootstrap-'));
  try {
    // Replace the first command after a marker with a failure and stop there.
    const script = bootstrap().replace(/^sudo -n apt-get .* update$/m, 'fetch_checked() { curl --fail --silent --show-error --retry 1 --retry-delay 0 --retry-all-errors --max-time 5 "$1" -o "$3"; }\nphase powershell_download\nfetch_checked http://127.0.0.1:9/release x /dev/null')
      .replace(/^mkdir -p .*$/m, 'true').replace(/^\(umask 077; mkdir -p .*$/m, 'true').replace(/^chmod 700 .*$/m, 'true').replace(/^exec 9>.*$/m, 'true').replace(/^flock 9$/m, 'true').replace(/^if test -f .*ready; then exit 0; fi$/m, 'true');
    const file = path.join(dir, 'bootstrap.sh');
    await writeFile(file, script);
    const result = await promisify(execFile)('bash', [file], { encoding: 'utf8' }).catch(error => error);
    assert.equal(result.code, 7);
    const stderr = result.stderr.trim().split('\n');
    assert.deepEqual(stderr.filter(line => line.startsWith('BOAT_SETUP_PHASE')), ['BOAT_SETUP_PHASE apt_update', 'BOAT_SETUP_PHASE powershell_download']);
    assert.match(stderr.at(-1), /^BOAT_SETUP_FAILED phase=powershell_download status=7 line=\d+$/);
    const tail = setupOutputTail(`exit code 7: ${result.stderr}`);
    assert.equal(setupPhase(tail), 'powershell_download');
    assert.equal(setupErrorCategory(tail), 'download_network');
    assert.equal(setupExitCode(tail), 7);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('apt network evidence is retryable but integrity evidence takes precedence', async () => {
  const api = new APIs({});
  assert.equal((await api.setupDiagnostics({ machineId: 'bx_test' }, { setupError: 'temporary failure resolving example' })).retryEligible, true);
  assert.equal((await api.setupDiagnostics({ machineId: 'bx_test' }, { setupError: 'temporary failure resolving example\nHash Sum mismatch', error: { code: 'NETWORK_ERROR' } })).retryEligible, false);
  assert.equal((await api.setupDiagnostics({ machineId: 'bx_test' }, { setupError: 'powershell.tar.gz: FAILED\nsha256sum: WARNING: 1 computed checksum did NOT match', error: { code: 'NETWORK_ERROR' } })).retryEligible, false);
});

test('snapshot phase markers survive diagnostic parsing', () => {
  assert.equal(setupPhase(['BOAT_SETUP_PHASE snapshot_verify']), 'snapshot_verify');
  assert.equal(setupPhase(['BOAT_SETUP_PHASE snapshot_verify', 'BOAT_SETUP_FAILED phase=snapshot_helper status=125 line=66']), 'snapshot_helper');
});
