import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { APIs } from '../src/apis.mjs';
import { lightResetCommand, lightStartCommand, parseLightResetResult, RESET_HEALTH_LIMITS } from '../src/router/light-reset.mjs';

const decode = command => Buffer.from(command.match(/[A-Za-z0-9+/]{80,}={0,2}/)[0], 'base64').toString();
const run = (script, env) => spawnSync('/bin/bash', ['-c', script], { env, encoding: 'utf8' });

test('generated reset executes with Docker ps filters and preserves its helper', () => {
  const dir = mkdtempSync(`${tmpdir()}/light-reset-`), bin = `${dir}/bin`;
  mkdirSync(bin);
  const stub = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('docker', `echo "$*" >> "$CALLS"
if [[ "$*" == *'label!='* ]]; then echo "invalid filter 'label!'" >&2; exit 1; fi
case "$*" in
  'ps -aq') printf 'helper\\njob\\n' ;;
  'ps -q --filter label=boat-light-reset') echo helper ;;
  'ps -aq --filter name=^/peek-ci-keep-') ;;
  'rm -f job') ;;
  'volume prune -f'|'network prune -f'|'image prune -f') ;;
  *) exit 1 ;;
esac`);
  for (const name of ['pkill', 'find', 'mkdir', 'tar', 'chown']) stub(name, 'exit 0');
  stub('sha256sum', 'cat >/dev/null; exit 0');
  stub('pgrep', 'exit 1');
  stub('df', "printf 'Filesystem blocks used available\\nfixture 20000000 1 9999999\\n'");
  const result = run(decode(lightResetCommand(1)), { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.equal(result.status, 0, result.stderr);
  const done = JSON.parse(result.stdout);
  assert.equal(done.ok, true); assert.equal(done.gen, 1);
  assert.equal(parseLightResetResult({ exitCode: 0, stdout: result.stdout }, 1).ok, true);
  assert.match(readFileSync(`${dir}/calls`, 'utf8'), /rm -f job\n/);
  assert.doesNotMatch(readFileSync(`${dir}/calls`, 'utf8'), /rm -f .*helper/);
  const insufficient = run(decode(lightResetCommand(1, null, 16000000)), { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.notEqual(insufficient.status, 0);
  const failure = parseLightResetResult({ exitCode: insufficient.status, stderr: insufficient.stderr }, 1);
  assert.equal(failure.step, 'sanity checks');
  assert.equal(failure.guard, 'disk');
  stub('df', 'case "$2" in /) total=153470764; free=70000000;; /home/ci|/home/user) total=40973536; free=20000000;; *) exit 1;; esac; printf "Filesystem blocks used available\\nfixture %s 1 %s\\n" "$total" "$free"');
  const separate = run(decode(lightResetCommand(1, null, 67108864, 16777216)), { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.equal(separate.status, 0, separate.stderr);
  const homeInsufficient = run(decode(lightResetCommand(1, null, 67108864, 25000000)), { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.equal(parseLightResetResult({ exitCode: homeInsufficient.status, stderr: homeInsufficient.stderr }, 1).guard, 'disk');
  stub('df', 'case "$2" in /) total=153470764; free=70000000;; /home/ci|/home/user) total=100000000; free=20000000;; *) exit 1;; esac; printf "Filesystem blocks used available\\nfixture %s 1 %s\\n" "$total" "$free"');
  const quarterInsufficient = run(decode(lightResetCommand(1, null, 67108864, 8388608)), { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.equal(parseLightResetResult({ exitCode: quarterInsufficient.status, stderr: quarterInsufficient.stderr }, 1).guard, 'disk');
});

test('a snapshot box reset keeps images and the primed tree, and clears the finished job', () => {
  const dir = mkdtempSync(`${tmpdir()}/light-snapshot-`), bin = `${dir}/bin`, home = `${dir}/home/user`, dagger = `${dir}/dagger`;
  const stub = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  mkdirSync(bin); mkdirSync(`${home}/.boat-ci`, { recursive: true }); mkdirSync(`${home}/boat-ci-runner`); mkdirSync(`${home}/ci/peek/target`, { recursive: true }); mkdirSync(`${home}/ci/peek/.git`); mkdirSync(dagger);
  writeFileSync(`${home}/boat-ci-start.sh`, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(`${home}/boat-ci-runner/run.sh`, '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(`${home}/.boat-ci/runner.tar.gz`, 'runner');
  writeFileSync(`${home}/.boat-ci/snapshot-mode`, '');
  for (const name of ['jit', 'started', 'runner.log']) writeFileSync(`${home}/.boat-ci/${name}`, '');
  for (const name of ['.runner', '.credentials', '.credentials_rsaparams', '.service']) writeFileSync(`${home}/boat-ci-runner/${name}`, '');
  writeFileSync(`${dagger}/cache`, 'old build cache');
  writeFileSync(`${home}/ci/peek/stale.rs`, 'previous checkout');
  stub('docker', `echo "$*" >> "$CALLS"
case "$*" in
  'ps -aq') printf 'keep\\njob\\n' ;;
  'ps -q --filter label=boat-light-reset') ;;
  'ps -aq --filter name=^/peek-ci-keep-') echo keep ;;
  'rm -f job') ;;
  'volume prune -f'|'network prune -f'|'image prune -f') ;;
  *) exit 1 ;;
esac`);
  for (const name of ['pkill']) stub(name, 'exit 0');
  stub('find', `printf 'find %s\\n' "$*" >> "$CALLS"
case "$*" in *"${dagger}"*) exec /usr/bin/find "$@";; esac`);
  stub('stat', 'echo 1000');
  stub('pgrep', 'exit 1');
  stub('git', `echo "git $*" >> "$CALLS"`);
  stub('df', "printf 'Filesystem blocks used available\\nfixture 20000000 1 9999999\\n'");
  const script = decode(lightResetCommand(1)).replaceAll('/home/user', home).replaceAll('/var/lib/peek-dagger', dagger);
  const result = run(script, { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.equal(result.status, 0, result.stderr);
  const calls = readFileSync(`${dir}/calls`, 'utf8');
  assert.match(calls, /volume prune -f/);
  assert.doesNotMatch(calls, /system prune/);
  assert.doesNotMatch(calls, /image prune -af/);
  assert.match(calls, /rm -f job/);
  assert.doesNotMatch(calls, /rm -f keep/, 'the container that keeps the suite image stays');
  assert.match(calls, /git .* reset --hard/);
  assert.match(calls, /git .* clean -ffdxq -e target -e node_modules -e \.next -e \.ci-base-built-at/);
  for (const name of ['jit', 'started', 'runner.log']) assert.equal(existsSync(`${home}/.boat-ci/${name}`), false);
  for (const name of ['.runner', '.credentials', '.credentials_rsaparams', '.service']) assert.equal(existsSync(`${home}/boat-ci-runner/${name}`), false);
  assert.equal(existsSync(`${home}/.boat-ci/snapshot-mode`), true, 'the snapshot keeps its mode flag for the next reset');
  assert.match(calls, /find \/tmp \/var\/tmp \/dev\/shm .*-user 1000 ! -path \/tmp\/w ! -path \/tmp\/w\/\*/);
  assert.deepEqual(readdirSync(dagger), []);
  assert.equal(existsSync(`${home}/ci/peek/target`), true);
});


test('generated start makes PATH readable to ci and starts the runner', () => {
  const dir = mkdtempSync(`${tmpdir()}/light-start-`), bin = `${dir}/bin`, home = `${dir}/home`, state = `${dir}/state`, source = `${dir}/source`;
  for (const path of [bin, home, `${home}/runner`, state, source]) mkdirSync(path);
  writeFileSync(`${state}/path`, `${bin}:/usr/bin:/bin`);
  writeFileSync(`${source}/jit`, 'dummy');
  writeFileSync(`${home}/runner/run.sh`, '#!/bin/bash\nprintf started > "$PROOF"\n', { mode: 0o755 });
  writeFileSync(`${bin}/install`, '#!/bin/bash\nwhile [[ "$1" == -* ]]; do if [[ "$1" == -m ]]; then mode="$2"; fi; shift 2; done\ncp "$1" "$2"\nchmod "$mode" "$2"\n', { mode: 0o755 });
  writeFileSync(`${bin}/chown`, '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(`${bin}/systemd-run`, '#!/bin/bash\nchmod 000 "$STATE/path"\nexec /bin/bash "${@: -1}"\n', { mode: 0o755 });
  writeFileSync(`${bin}/setpriv`, '#!/bin/bash\nshift 3\nexec "$@"\n', { mode: 0o755 });
  const outer = decode(lightStartCommand(1));
  const embedded = outer.match(/[A-Za-z0-9+/]{80,}={0,2}/)[0];
  const start = Buffer.from(embedded, 'base64').toString().replaceAll('/home/ci', home).replaceAll('/var/lib/boat-ci-reuse', state);
  const script = outer.replace(embedded, Buffer.from(start).toString('base64')).replaceAll('/home/user/.boat-ci', source).replaceAll('/home/ci', home).replaceAll('/var/lib/boat-ci-reuse', state);
  const result = run(script, { PATH: `${bin}:/usr/bin:/bin`, PROOF: `${dir}/started`, STATE: state });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(`${dir}/started`, 'utf8'), 'started');
  assert.ok((statSync(`${home}/.path`).mode & 0o004) !== 0);
});

test('a snapshot box starts its own runner script for the next generation', () => {
  const dir = mkdtempSync(`${tmpdir()}/light-start-snapshot-`), bin = `${dir}/bin`, source = `${dir}/source`;
  mkdirSync(bin); mkdirSync(source);
  writeFileSync(`${source}/snapshot-mode`, '');
  writeFileSync(`${source}/jit`, 'dummy');
  writeFileSync(`${source}/boat-ci-start.sh`, '#!/bin/bash\nprintf snapshot > "$PROOF"\n', { mode: 0o755 });
  writeFileSync(`${bin}/systemd-run`, '#!/bin/bash\nprintf "%s\\n" "$*" >> "$PROOF.args"\nexec /bin/bash "${@: -1}"\n', { mode: 0o755 });
  const script = decode(lightStartCommand(1)).replaceAll('/home/user/.boat-ci', source).replaceAll('/home/user/boat-ci-start.sh', `${source}/boat-ci-start.sh`);
  const result = run(script, { PATH: `${bin}:/usr/bin:/bin`, PROOF: `${dir}/started` });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(`${dir}/started`, 'utf8'), 'snapshot');
  assert.match(readFileSync(`${dir}/started.args`, 'utf8'), /--property=User=user --property=Group=user/);
});

test('light reset accepts only a complete successful result for its generation', () => {
  assert.equal(parseLightResetResult({ running: true }, 1), null);
  for (const response of [{ exitCode: 1 }, { exitCode: 0, stdout: '{"ok":true,"gen":2}' }, { exitCode: 0, stdout: '{"ok":true,"gen":1}', stdoutTruncated: true }, { exitCode: 0, stdout: 'bad' }]) {
    assert.equal(parseLightResetResult(response, 1).ok, false);
  }
  assert.deepEqual(parseLightResetResult({ exitCode: 0, stdout: '{"ok":true,"gen":1}' }, 1), { ok: true });
  assert.throws(() => lightResetCommand(0));
  assert.throws(() => lightStartCommand(0));
});

test('reset failure includes a bounded, redacted step and output', () => {
  const result = parseLightResetResult({ exitCode: 3, stderr: `token=secret-value\n${'line\n'.repeat(22)}BOAT_RESET_FAILURE step=clean work dir exit=3\n` }, 1);
  assert.equal(result.step, 'clean work dir');
  assert.equal(result.exitCode, 3);
  assert.ok(result.output.split('\n').length <= 20);
  assert.doesNotMatch(result.output, /secret-value/);
  const secret = parseLightResetResult({ exitCode: 1, stderr: 'token=secret-value\nBOAT_RESET_FAILURE step=docker prune exit=1\n' }, 1);
  assert.doesNotMatch(secret.output, /secret-value/);
});

test('JIT registration uses the same repository and label', async () => {
  const api = new APIs({}); api.appJWT = async () => 'test';
  const requests = [];
  api.request = async (service, path, options = {}) => {
    requests.push({ service, path, body: options.body });
    if (path.includes('/access_tokens')) return { token: 'test', expires_at: '2099-01-01T00:00:00Z' };
    if (path.includes('generate-jitconfig')) return { runner: { id: 5 }, encoded_jit_config: 'test' };
    if (path.includes('/actions/runners?')) return { runners: [] };
    return {};
  };
  await api.configure({ repo: 'owner/repo', installation: 4, machineId: 'bx_23456789', label: 'work', labels: ['work'], runnerName: 'runner' }, async () => {});
  assert.deepEqual(requests[0].body.repositories, ['repo']);
  const github = requests.filter(call => call.service === 'github' && !call.path.includes('/access_tokens'));
  assert.ok(github.every(call => call.path.startsWith('/repos/owner/repo/actions/runners')));
  assert.deepEqual(github.find(call => call.path.endsWith('/generate-jitconfig')).body.labels, ['work']);
});


test('a killed reset reports the last completed stage marker', () => {
  const result = parseLightResetResult({ exitCode: 137, stderr: 'BOAT_RESET_STAGE step=kill processes\nBOAT_RESET_STAGE step=docker prune\n' }, 1);
  assert.equal(result.step, 'docker prune');
  assert.equal(result.exitCode, 137);
});

test('reset output never retains arbitrary non-assignment secret text', () => {
  const result = parseLightResetResult({ exitCode: 137, stderr: 'unexpected plaintext-secret-value\nBOAT_RESET_STAGE step=docker prune\n' }, 1);
  assert.doesNotMatch(result.output, /plaintext-secret-value/);
  assert.match(result.output, /BOAT_RESET_STAGE step=docker prune/);
});

test('external reset checks the lease user marker before removal', () => {
  const lease = '00000000-0000-4000-8000-000000000001';
  const script = Buffer.from(lightResetCommand(2, lease).match(/[A-Za-z0-9+/]{80,}={0,2}/)[0], 'base64').toString();
  assert.match(script, /external-lease-user/);
  assert.ok(script.indexOf(`= '${lease}'`) < script.indexOf('userdel externallease'));
  assert.ok(script.indexOf('pgrep -u externallease') < script.indexOf('userdel externallease'));
});

// The reset ends with a short health check. Test shards starved on boxes whose 4 KiB synchronous
// writes took 8-39 ms (healthy boxes: about 1 ms). The fixture replaces the host paths and stubs the clock.
const healthFixture = ({ stepMicros = 1000, pgrepForeign = false, memAvailableKiB = 6000000, ddFails = false, mode = 'enforce' } = {}) => {
  const dir = mkdtempSync(`${tmpdir()}/light-health-`), bin = `${dir}/bin`;
  mkdirSync(bin); mkdirSync(`${dir}/vartmp`);
  const stub = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('docker', 'exit 0');
  for (const name of ['pkill', 'find', 'mkdir', 'tar', 'chown', 'sync', 'sleep']) stub(name, 'exit 0');
  stub('sha256sum', 'cat >/dev/null; exit 0');
  stub('pgrep', pgrepForeign ? 'if [ "$1" = -x ]; then echo 4242; exit 0; fi; exit 1' : 'exit 1');
  stub('df', "printf 'Filesystem blocks used available\\nfixture 20000000 1 9999999\\n'");
  stub('dd', ddFails ? 'exit 1' : 'exit 0');
  writeFileSync(`${dir}/clock`, '1000000000000000');
  stub('date', `v=$(cat "${dir}/clock"); echo $((v + ${stepMicros})) > "${dir}/clock"; printf '%s\\n' "$v"`);
  writeFileSync(`${dir}/meminfo`, `MemTotal:        8000000 kB\nMemFree:         1000000 kB\nMemAvailable:    ${memAvailableKiB} kB\n`);
  writeFileSync(`${dir}/cpuinfo`, 'processor\t: 0\nmodel name\t: Fixture CPU\n');
  const script = decode(lightResetCommand(1, null, 4194304, 4194304, mode)).replaceAll('/proc/meminfo', `${dir}/meminfo`).replaceAll('/proc/cpuinfo', `${dir}/cpuinfo`).replaceAll('/var/tmp/.boat-reset-health', `${dir}/vartmp/probe`);
  return run(script, { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
};

test('a healthy box passes the post-reset check and reports its measurements', () => {
  const result = healthFixture();
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseLightResetResult({ exitCode: 0, stdout: result.stdout }, 1);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.summary.health, { cpuMs: 1, fsyncMs: 1, writeMs: 1, memPct: 75, foreign: false, measured: true, failed: false, slow: false, cpu: 'Fixture CPU' });
});

test('a box with slow synchronous writes fails the health guard after one retry', () => {
  const result = healthFixture({ stepMicros: 1_600_000 });
  assert.notEqual(result.status, 0);
  const parsed = parseLightResetResult({ exitCode: result.status, stderr: result.stderr }, 1);
  assert.equal(parsed.ok, false); assert.equal(parsed.guard, 'health'); assert.equal(parsed.step, 'health check');
  assert.equal(parsed.health.fsyncMs, 1600); assert.equal(parsed.health.cpuMs, 1600); assert.equal(parsed.health.measured, true); assert.equal(parsed.health.failed, true); assert.equal(parsed.health.slow, true);
  assert.match(parsed.output, /^BOAT_RESET_HEALTH cpu_ms=1600 fsync_ms=1600 /m);
  assert.ok(RESET_HEALTH_LIMITS.fsyncMs < 1600 && RESET_HEALTH_LIMITS.writeMs > 1600);
  const healthy = healthFixture({ stepMicros: 900_000 });
  assert.equal(healthy.status, 0, 'a box inside the live-calibrated floors stays in service');
});

test('leftover job processes or low free memory fail the health guard', () => {
  const foreign = healthFixture({ pgrepForeign: true });
  assert.notEqual(foreign.status, 0);
  const crowded = parseLightResetResult({ exitCode: foreign.status, stderr: foreign.stderr }, 1);
  assert.equal(crowded.guard, 'health'); assert.equal(crowded.health.foreign, true); assert.equal(crowded.health.slow, false, 'leftover processes fail the check but do not mark a slow host');
  const memory = healthFixture({ memAvailableKiB: 3000000 });
  assert.notEqual(memory.status, 0);
  const low = parseLightResetResult({ exitCode: memory.status, stderr: memory.stderr }, 1);
  assert.equal(low.guard, 'health'); assert.equal(low.health.memPct, 37);
});

test('observe mode records a failed check but keeps the box in service', () => {
  const result = healthFixture({ stepMicros: 1_600_000, mode: 'observe' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseLightResetResult({ exitCode: 0, stdout: result.stdout }, 1);
  assert.equal(parsed.ok, true); assert.equal(parsed.summary.health.failed, true); assert.equal(parsed.summary.health.fsyncMs, 1600);
  assert.doesNotMatch(result.stderr, /BOAT_RESET_GUARD/);
  assert.throws(() => lightResetCommand(1, null, 4194304, 4194304, 'retire'));
  assert.match(decode(lightResetCommand(1)), /health_enforce=0/, 'the default is observe');
});

test('a failing measurement tool leaves the box in service instead of retiring the fleet', () => {
  const result = healthFixture({ ddFails: true, stepMicros: 600_000 });
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseLightResetResult({ exitCode: 0, stdout: result.stdout }, 1);
  assert.equal(parsed.ok, true); assert.equal(parsed.summary.health.measured, false); assert.equal(parsed.summary.health.fsyncMs, 0); assert.equal(parsed.summary.health.failed, false);
});

test('the health line is kept in the redacted tail and a disk guard still wins', () => {
  const parsed = parseLightResetResult({ exitCode: 1, stderr: 'secret-text\nBOAT_RESET_HEALTH cpu_ms=90 fsync_ms=1900 write_ms=300 mem_pct=88 foreign=0 measured=1 failed=1 slow=1 cpu=AMD_Ryzen_7_9700X_8-Core_Processor\nBOAT_RESET_GUARD health\nBOAT_RESET_FAILURE step=health check exit=1\n' }, 1);
  assert.equal(parsed.guard, 'health'); assert.equal(parsed.step, 'health check');
  assert.doesNotMatch(parsed.output, /secret-text/);
  assert.deepEqual(parsed.health, { cpuMs: 90, fsyncMs: 1900, writeMs: 300, memPct: 88, foreign: false, measured: true, failed: true, slow: true, cpu: 'AMD Ryzen 7 9700X 8-Core Processor' });
  assert.equal(parseLightResetResult({ exitCode: 1, stderr: 'BOAT_RESET_GUARD disk\nBOAT_RESET_FAILURE step=sanity checks exit=1\n' }, 1).guard, 'disk');
  assert.equal(parseLightResetResult({ exitCode: 0, stdout: '{"ok":true,"gen":1,"health":{"cpuMs":-1}}' }, 1).summary, undefined);
  const injected = parseLightResetResult({ exitCode: 0, stdout: '{"ok":true,"gen":1,"health":{"cpuMs":1,"fsyncMs":1,"writeMs":1,"memPct":90,"foreign":0,"measured":1,"failed":0,"slow":0,"cpu":"bad cpu; rm"}}' }, 1);
  assert.equal(injected.summary.health.cpu, null, 'a model outside the safe alphabet is dropped');
});
