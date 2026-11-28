import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { snapshotBootstrap } from '../src/snapshot-bootstrap.mjs';

const digest = data => createHash('sha256').update(data).digest('hex');
function fixture(t, options) {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-boot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.boat-ci'));
  if (options?.reusable) mkdirSync(join(root, '.boat-ci/helper-oci'));
  mkdirSync(join(root, 'boat-ci-runner'));
  writeFileSync(join(root, 'boat-ci-start.sh'), '#!/bin/sh\n', { mode: 0o755 });
  writeFileSync(join(root, 'boat-ci-runner/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const binary = join(root, 'tool');
  writeFileSync(binary, 'verified tool');
  const manifest = `${digest('verified tool')}  ${options?.relativeManifest ? binary.slice(1) : binary}\n`;
  writeFileSync(join(root, '.boat-ci/toolchain.sha256'), manifest);
  const script = snapshotBootstrap(digest(manifest), options).replaceAll('/home/user', root).replaceAll('/tmp/w', join(root, 'work')).replaceAll('/var/lib/tailscale/tailscaled.state', join(root, 'tailscale.state'));
  return { root, binary, run: env => spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } }), ready: () => existsSync(join(root, '.boat-ci/ready')) };
}

test('a verified snapshot recreates the work directory and reaches ready', t => {
  const f = fixture(t), result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ready(), true);
  assert.equal(existsSync(join(f.root, 'work')), true);
});

test('a snapshot verifies root-relative manifest paths', t => {
  const f = fixture(t, { relativeManifest: true });
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ready(), true);
});

test('a modified tool cannot reach ready', t => {
  const f = fixture(t);
  writeFileSync(f.binary, 'modified');
  assert.notEqual(f.run().status, 0);
  assert.equal(f.ready(), false);
});

test('a registered or previously booted image cannot reach ready', async t => {
  for (const name of ['jit', 'started', 'ready']) await t.test(name, t => {
    const f = fixture(t);
    writeFileSync(join(f.root, '.boat-ci', name), '');
    assert.notEqual(f.run().status, 0);
  });
  for (const name of ['.runner', '.credentials', '.credentials_rsaparams', '.service']) await t.test(name, t => {
    const f = fixture(t);
    writeFileSync(join(f.root, 'boat-ci-runner', name), '');
    assert.notEqual(f.run().status, 0);
    assert.equal(f.ready(), false);
  });
});

test('rejects an invalid manifest hash', () => {
  for (const value of ['', 'a'.repeat(63), 'g'.repeat(64), 'a'.repeat(64) + "'" ]) assert.throws(() => snapshotBootstrap(value));
});

test('a reusable snapshot checks its helper without pulling or networking', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ "$1" = info ]; then exit 0; fi
if [ "$1" = image ] && [ "$2" = inspect ]; then exit 0; fi
if [ "$1" = run ]; then printf '%s\\n' "$*" > "$TRACE"; [[ "$*" == *--pull=never* && "$*" == *--network=none* ]]; exit $?; fi
exit 1
`, { mode: 0o755 });
  const result = f.run({ PATH: `${bin}:${process.env.PATH}`, TRACE: join(f.root, 'trace') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ready(), true);
  assert.equal(existsSync(join(f.root, 'trace')), true);
});

test('a reusable snapshot without the offline helper cache cannot reach ready', t => {
  const f = fixture(t, { reusable: true });
  rmSync(join(f.root, '.boat-ci/helper-oci'), { recursive: true });
  assert.notEqual(f.run().status, 0);
  assert.equal(f.ready(), false);
});

test('a reusable snapshot retries a failed helper after restarting Docker', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ "$1" = info ] || [ "$1" = image ]; then exit 0; fi
if [ "$1" = run ]; then [ -f "$RESTARTED" ]; exit $?; fi
exit 1
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), `#!/bin/bash
[[ "$*" == '-n systemctl restart containerd docker' ]] || exit 1
touch "$RESTARTED"
`, { mode: 0o755 });
  const result = f.run({ PATH: `${bin}:${process.env.PATH}`, RESTARTED: join(f.root, 'restarted') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ready(), true);
  assert.equal(existsSync(join(f.root, 'restarted')), true);
});

test('a reusable snapshot stays unready if the helper still fails', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/bash\n[ "$1" = info ] || [ "$1" = image ]\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  assert.notEqual(f.run({ PATH: `${bin}:${process.env.PATH}` }).status, 0);
  assert.equal(f.ready(), false);
});


test('a reusable snapshot loads a missing helper from verified OCI files', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'python3'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1" in
  info) exit 0 ;;
  image) [ -f "$LOADED" ] ;;
  load) touch "$LOADED" ;;
  run) [ -f "$LOADED" ] ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const loaded = join(f.root, 'loaded');
  const result = f.run({ PATH: `${bin}:${process.env.PATH}`, LOADED: loaded });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(loaded), true);
  assert.equal(f.ready(), true);
});

test('helper run passes separate Docker arguments and recovers from a transient cgroup failure', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1" in
  info|image) exit 0 ;;
  run)
    [ "$#" -eq 6 ] && [ "$2" = --rm ] && [ "$3" = --pull=never ] && [ "$4" = --network=none ] && [ "$6" = true ] || exit 125
    [ -f "$ATTEMPT" ] && exit 0
    touch "$ATTEMPT"
    exit 125 ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, ATTEMPT: join(f.root, 'attempt') };
  const bad = spawnSync(join(bin, 'docker'), ['run', '--rm --pull=never --network=none', 'image', 'true'], { env });
  assert.equal(bad.status, 125);
  const result = f.run(env);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ready(), true);
});

test('helper retries are bounded when the Docker daemon keeps failing', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ "$1" = run ]; then echo x >> "$ATTEMPTS"; exit 125; fi
exit 0
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\nexit 1\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const attempts = join(f.root, 'attempts');
  const result = f.run({ PATH: `${bin}:${process.env.PATH}`, ATTEMPTS: attempts });
  assert.notEqual(result.status, 0);
  assert.equal(f.ready(), false);
  assert.equal(readFileSync(attempts, 'utf8').trim().split('\n').length, 4);
});

test('the helper waits for systemd before Docker and restarts only once systemd answers', t => {
  const f = fixture(t, { reusable: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), `#!/bin/bash
n=0; [ -f "$POLLS" ] && n=$(cat "$POLLS"); n=$((n+1)); echo $n > "$POLLS"
if [ "$1" = is-system-running ]; then if [ "$n" -ge 3 ]; then echo running; else echo starting; exit 1; fi; fi
`, { mode: 0o755 });
  writeFileSync(join(bin, 'docker'), `#!/bin/bash
if [ "$1" = info ] || [ "$1" = image ]; then exit 0; fi
if [ "$1" = run ]; then [ -f "$POLLS" ] && [ "$(cat "$POLLS")" -ge 3 ] && [ -f "$RESTARTED" ]; exit $?; fi
exit 1
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sudo'), '#!/bin/bash\n[[ "$*" == \'-n systemctl restart containerd docker\' ]] || exit 1\ntouch "$RESTARTED"\n', { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  const result = f.run({ PATH: `${bin}:${process.env.PATH}`, POLLS: join(f.root, 'polls'), RESTARTED: join(f.root, 'restarted') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.ready(), true);
  assert.ok(Number(readFileSync(join(f.root, 'polls'), 'utf8')) >= 3, 'docker ran only after systemd answered running');
});

test('a lease boot passes only with no tailnet state file and no tailscaled process', t => {
  const f = fixture(t, { noTailnet: true }), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const env = { PATH: `${bin}:${process.env.PATH}` };
  const clean = f.run(env);
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(f.ready(), true);
  rmSync(join(f.root, '.boat-ci/ready'));
  const secret = 'tailnet-identity-must-never-appear';
  writeFileSync(join(f.root, 'tailscale.state'), secret);
  const stateful = f.run(env);
  assert.notEqual(stateful.status, 0);
  assert.equal(f.ready(), false);
  assert.equal((stateful.stdout + stateful.stderr).includes(secret), false, 'no file content is printed');
  rmSync(join(f.root, 'tailscale.state'));
  writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const running = f.run(env);
  assert.notEqual(running.status, 0);
  assert.equal(f.ready(), false);
});

test('a boot without the lease check never probes the tailnet', t => {
  const f = fixture(t), bin = join(f.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'pgrep'), '#!/bin/sh\ntouch "' + '\$TRACE' + '"; exit 0\n', { mode: 0o755 });
  const result = f.run({ PATH: `${bin}:${process.env.PATH}`, TRACE: join(f.root, 'trace') });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(join(f.root, 'trace')), false);
});
