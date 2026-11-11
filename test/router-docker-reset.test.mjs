import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dockerBaselineCommand, dockerResetCommand, dockerStartCommand, parseDockerBaselineResult, parseDockerResetResult, DOCKER_RESET_PROGRAM_SHA256, DOCKER_RESET_STEPS } from '../src/router/docker-reset.mjs';
import { START_COMMAND } from '../src/bootstrap.mjs';
import { telemetrySetup } from '../src/runner-telemetry.mjs';

const HASH = 'e'.repeat(64);
const program = () => Buffer.from(dockerBaselineCommand().split("'")[1], 'base64').toString();

test('docker reset commands run the embedded program as root with bounded arguments', () => {
  const baseline = dockerBaselineCommand();
  assert.match(baseline, /^printf %s '[A-Za-z0-9+/=]+' \| base64 -d \| sudo -n python3 -I - baseline$/);
  const reset = dockerResetCommand(3, HASH);
  assert.match(reset, new RegExp(`sudo -n python3 -I - reset 3 ${HASH}$`));
  assert.equal(reset.split("'")[1], baseline.split("'")[1], 'baseline and reset ship the same program');
  for (const generation of [0, 61, 1.5, '1']) assert.throws(() => dockerResetCommand(generation, HASH), /Invalid generation/);
  assert.throws(() => dockerResetCommand(1, 'x'.repeat(64)), /Invalid baseline hash/);
  assert.throws(() => dockerResetCommand(1, null), /Invalid baseline hash/);
  assert.equal(dockerStartCommand(), START_COMMAND, 'a reset box starts its runner like a fresh box');
  assert.match(DOCKER_RESET_PROGRAM_SHA256, /^[a-f0-9]{64}$/);
  const source = program();
  for (const step of DOCKER_RESET_STEPS) assert.ok(source.includes(`step('${step}')`), `program marks step ${step}`);
  assert.ok(source.includes("cgroup.kill"), 'job scopes are killed as cgroups');
  assert.ok(source.includes("'systemctl', 'restart', 'docker.service'"), 'dockerd restarts');
  assert.ok(source.includes("'setup-hang-proof'"), 'the proof marker is cleared by the reset');
  // cheap drift checks that destroy the box, and the tool cache restored from its baseline archive.
  for (const marker of ["fail('timers remain'", "fail('timer drift'", "fail('firewall drift'", "fail('sysctl drift'", "fail('mount drift'", "fail('build cache remains'", "fail('image tags drift'", "fail('package drift', package=changed"]) assert.ok(source.includes(marker), `program checks ${marker}`);
  assert.ok(source.includes("'/root')"), '/root is a manifest root');
  assert.ok(source.includes("docker(['builder', 'prune', '-af'], timeout=300)") && !source.includes("'builder', 'prune', '-af'], timeout=300, check=False"), 'a failed build cache prune fails the reset');
  assert.ok(source.includes("restore('toolcache.tar', TOOLCACHE)"), 'the tool cache (pinned Node) comes back from the baseline archive');
  assert.ok(source.includes("('toolcache.tar', 'toolcacheArchiveSha256')"), 'the tool cache archive is hash-checked like the home archive');
});

test('the embedded reset program is valid Python 3', t => {
  const python = spawnSync('python3', ['--version']);
  if (python.status !== 0) { t.skip('python3 unavailable'); return; }
  const dir = mkdtempSync(path.join(tmpdir(), 'docker-reset-'));
  const file = path.join(dir, 'reset.py');
  writeFileSync(file, program());
  const result = spawnSync('python3', ['-I', '-W', 'error', '-m', 'py_compile', file], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('baseline results need a hash and carry the summary; failures name the step', () => {
  assert.equal(parseDockerBaselineResult({ running: true }), null);
  const ok = parseDockerBaselineResult({ exitCode: 0, stdout: `{"ok": true, "baselineHash": "${HASH}", "processes": 76, "listeners": 16, "images": 1, "homeArchiveBytes": 10}\n` });
  assert.deepEqual(ok, { ok: true, baselineHash: HASH, summary: { processes: 76, listeners: 16, images: 1, homeArchiveBytes: 10 } });
  const v2 = parseDockerBaselineResult({ exitCode: 0, stdout: `{"ok": true, "baselineHash": "${HASH}", "processes": 76, "listeners": 16, "images": 1, "homeArchiveBytes": 10, "toolcacheArchiveBytes": 20, "packages": 1990, "sysctl": 1400, "mounts": 27, "firewallRules": 300}\n` });
  assert.deepEqual(v2.summary, { processes: 76, listeners: 16, images: 1, homeArchiveBytes: 10, toolcacheArchiveBytes: 20, packages: 1990, sysctl: 1400, mounts: 27, firewallRules: 300 });
  assert.equal(parseDockerBaselineResult({ exitCode: 0, stdout: '{"ok": true, "baselineHash": "short"}' }).ok, false);
  assert.equal(parseDockerBaselineResult({ exitCode: 0, stdout: 'not json' }).ok, false);
  assert.equal(parseDockerBaselineResult({ exitCode: 0, stdout: 'x'.repeat(5000) }).step, 'read baseline result');
  const failed = parseDockerBaselineResult({ exitCode: 1, stdout: '', stderr: 'BOAT_RESET_STAGE step=docker baseline\nsecret output line\nBOAT_RESET_FAILURE step=docker baseline exit=1 reason=containers at baseline\n' });
  assert.equal(failed.ok, false); assert.equal(failed.step, 'docker baseline'); assert.equal(failed.exitCode, 1); assert.equal(failed.reason, 'containers at baseline');
  assert.ok(!failed.output.includes('secret output line'), 'unknown lines are redacted');
});

test('reset results verify the generation and parse failures with details and the disk guard', () => {
  assert.equal(parseDockerResetResult({ running: true }, 1), null);
  const ok = parseDockerResetResult({ exitCode: 0, stdout: '{"ok": true, "gen": 2, "killed": 2, "containers": 1}\n' }, 2);
  assert.deepEqual(ok, { ok: true, summary: { killed: 2, containers: 1 } });
  assert.equal(parseDockerResetResult({ exitCode: 0, stdout: '{"ok": true, "gen": 1}' }, 2).ok, false, 'a stale generation is refused');
  assert.equal(parseDockerResetResult({ exitCode: 0, stdout: '{"ok": false, "gen": 2}' }, 2).ok, false);
  assert.equal(parseDockerResetResult({ exitCode: 0, stdoutTruncated: true, stdout: '{}' }, 2).step, 'read reset result');
  const stderr = ['BOAT_RESET_STAGE step=read baseline', 'BOAT_RESET_STAGE step=stop runner', 'BOAT_RESET_DETAIL runner_scopes=1', 'BOAT_RESET_STAGE step=kill processes', 'BOAT_RESET_DETAIL killed=3', 'some command output with /home/user/secret', 'BOAT_RESET_DETAIL comm=bash', 'BOAT_RESET_DETAIL uid=0', 'BOAT_RESET_FAILURE step=kill processes exit=1 reason=processes remain'].join('\n');
  const failed = parseDockerResetResult({ exitCode: 1, stdout: '', stderr }, 1);
  assert.equal(failed.ok, false); assert.equal(failed.step, 'kill processes'); assert.equal(failed.exitCode, 1); assert.equal(failed.reason, 'processes remain');
  assert.deepEqual(failed.details, { runner_scopes: '1', killed: '3', comm: 'bash', uid: '0' });
  assert.ok(!failed.output.includes('secret'));
  assert.ok(failed.output.includes('[redacted]'));
  assert.equal(failed.guard, undefined);
  const disk = parseDockerResetResult({ exitCode: 1, stdout: '', stderr: 'BOAT_RESET_STAGE step=sanity checks\nBOAT_RESET_FAILURE step=sanity checks exit=1 reason=disk\n' }, 1);
  assert.equal(disk.guard, 'disk'); assert.equal(disk.step, 'sanity checks');
  const crashed = parseDockerResetResult({ exitCode: 2, stdout: '', stderr: 'BOAT_RESET_STAGE step=clean filesystem\nTraceback\nBOAT_RESET_FAILURE step=clean filesystem exit=2 reason=PermissionError\n' }, 1);
  assert.equal(crashed.step, 'clean filesystem'); assert.equal(crashed.exitCode, 2);
  const silent = parseDockerResetResult({ exitCode: 137, stdout: '', stderr: 'BOAT_RESET_STAGE step=docker prune\n' }, 1);
  assert.equal(silent.step, 'docker prune'); assert.equal(silent.exitCode, 137);
  const drift = parseDockerResetResult({ exitCode: 1, stdout: '', stderr: 'BOAT_RESET_STAGE step=clean filesystem\nBOAT_RESET_DETAIL package=zsh\nBOAT_RESET_DETAIL baseline=absent\nBOAT_RESET_DETAIL now=5.9-6ubuntu2\nBOAT_RESET_FAILURE step=clean filesystem exit=1 reason=package drift\n' }, 1);
  assert.equal(drift.reason, 'package drift'); assert.deepEqual(drift.details, { package: 'zsh', baseline: 'absent', now: '5.9-6ubuntu2' });
  const sysctl = parseDockerResetResult({ exitCode: 1, stdout: '', stderr: 'BOAT_RESET_STAGE step=sanity checks\nBOAT_RESET_DETAIL key=net.ipv4.ip_forward\nBOAT_RESET_DETAIL now=0\nBOAT_RESET_FAILURE step=sanity checks exit=1 reason=sysctl drift\n' }, 1);
  assert.equal(sysctl.reason, 'sysctl drift'); assert.equal(sysctl.details.key, 'net.ipv4.ip_forward'); assert.equal(sysctl.guard, undefined);
});

test('the runner telemetry hook sleeps only when the operator proof marker exists next to it', () => {
  const setup = telemetrySetup('/home/user/.boat-ci/telemetry.sh', '/tmp/w');
  const hook = Buffer.from(setup.split("'")[1], 'base64').toString();
  assert.ok(hook.includes('if test -e "${BASH_SOURCE[0]%/*}/setup-hang-proof"; then printf \'BOAT_PROOF_SETUP_HANG\\n\'; sleep 3600; fi'));
  assert.ok(hook.indexOf('setup-hang-proof') < hook.indexOf('BOAT_VM_STATE'), 'the marker check runs before any probe');
});
