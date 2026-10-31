import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { APIs } from '../src/apis.mjs';
import { lightResetCommand, lightStartCommand, parseLightResetResult } from '../src/router/light-reset.mjs';

const decode = command => Buffer.from(command.match(/[A-Za-z0-9+/]{80,}={0,2}/)[0], 'base64').toString();
const run = (script, env) => spawnSync('/bin/bash', ['-c', script], { env, encoding: 'utf8' });

test('generated reset executes with Docker ps filters and preserves its helper', () => {
  const dir = mkdtempSync(`${tmpdir()}/light-reset-`), bin = `${dir}/bin`;
  mkdirSync(bin);
  const stub = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  stub('docker', `echo "$*" >> "$CALLS"
if [[ "$*" == *'label!='* ]]; then echo "invalid filter 'label!'" >&2; exit 1; fi
case "$*" in
  'ps -q') printf 'helper\\njob\\n' ;;
  'ps -q --filter label=boat-light-reset') echo helper ;;
  'rm -f job'|'system prune -af --volumes') ;;
  *) exit 1 ;;
esac`);
  for (const name of ['pkill', 'find', 'mkdir', 'sha256sum', 'tar', 'chown']) stub(name, 'exit 0');
  stub('pgrep', 'exit 1');
  stub('df', "printf 'Filesystem blocks used available\\nfixture 1 1 9999999\\n'");
  const result = run(decode(lightResetCommand(1)), { PATH: `${bin}:/usr/bin:/bin`, CALLS: `${dir}/calls` });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, gen: 1 });
  assert.match(readFileSync(`${dir}/calls`, 'utf8'), /rm -f job\n/);
  assert.doesNotMatch(readFileSync(`${dir}/calls`, 'utf8'), /rm -f .*helper/);
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
