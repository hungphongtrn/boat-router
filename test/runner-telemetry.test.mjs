import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { telemetrySetup } from '../src/runner-telemetry.mjs';

test('telemetry finishes when the disk probe ignores termination', { skip: process.platform !== 'linux', timeout: 16000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'telemetry-test-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    writeFileSync(join(bin, 'dd'), '#!/bin/bash\nfor arg in "$@"; do case "$arg" in of=*) file=${arg#of=}; test "$file" = /dev/null || printf x > "$file";; esac; done\ntrap "" TERM INT\nwhile :; do sleep 1; done\n', { mode: 0o755 });
    const setup = telemetrySetup(join(dir, 'hook'), dir);
    const result = spawnSync('bash', ['-c', `${setup}\nexec bash '${join(dir, 'hook')}'`], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.match(result.stdout, /disk_read_direct unavailable/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
