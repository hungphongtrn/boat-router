import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { lightResetCommand } from '../src/router/light-reset.mjs';

test('reset fails if ci processes survive the kill step', () => {
  const dir = mkdtempSync(`${tmpdir()}/reset-audit-`), bin = `${dir}/bin`;
  mkdirSync(bin);
  const stub = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const name of ['pkill', 'sleep', 'find', 'mkdir', 'sha256sum', 'tar', 'chown']) stub(name, 'exit 0');
  stub('pgrep', 'exit 0');
  stub('docker', 'exit 0');
  stub('df', "printf 'Filesystem blocks used available\\nfixture 1 1 9999999\\n'");
  const script = Buffer.from(lightResetCommand(1).match(/[A-Za-z0-9+/]{80,}={0,2}/)[0], 'base64').toString();
  const result = spawnSync('/bin/bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'live ci processes must fail the reset');
  assert.match(result.stderr, /BOAT_RESET_FAILURE step=kill processes exit=/);
});

test('reset fails if ci processes appear during sanity checks', () => {
  const dir = mkdtempSync(`${tmpdir()}/reset-audit-`), bin = `${dir}/bin`;
  mkdirSync(bin);
  const stub = (name, body) => writeFileSync(`${bin}/${name}`, `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  for (const name of ['pkill', 'sleep', 'find', 'mkdir', 'sha256sum', 'tar', 'chown']) stub(name, 'exit 0');
  stub('pgrep', 'n=0; [ ! -f "$COUNTER" ] || n=$(cat "$COUNTER"); n=$((n+1)); echo "$n" > "$COUNTER"; [ "$n" -ge 3 ]');
  stub('docker', 'exit 0');
  stub('df', "printf 'Filesystem blocks used available\\nfixture 1 1 9999999\\n'");
  const script = Buffer.from(lightResetCommand(1).match(/[A-Za-z0-9+/]{80,}={0,2}/)[0], 'base64').toString();
  const result = spawnSync('/bin/bash', ['-c', script], { env: { PATH: `${bin}:/usr/bin:/bin`, COUNTER: `${dir}/counter` }, encoding: 'utf8' });
  assert.notEqual(result.status, 0, 'live ci processes must fail the sanity checks');
  assert.match(result.stderr, /BOAT_RESET_FAILURE step=sanity checks exit=/);
});
