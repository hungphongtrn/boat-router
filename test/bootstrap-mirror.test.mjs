import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { bootstrap } from '../src/bootstrap.mjs';

const script = bootstrap();
const functions = script.slice(script.indexOf('fetch_checked() {'), script.indexOf('if test -w /etc'));
const expected = createHash('sha256').update('verified').digest('hex');
const asset = `${mkdtempSync(`${tmpdir()}/mirror-`)}/asset`;
function run(mirror, upstream) {
  const command = `set -e\ncurl() {\n  local url out\n  while [ "$#" -gt 0 ]; do case "$1" in mirror|upstream) url="$1";; -o) shift; out="$1";; esac; shift; done\n  if [ "$url" = mirror ]; then printf '%s' "$MIRROR" > "$out"; [ "$MIRROR" != fail ]; else printf '%s' "$UPSTREAM" > "$out"; [ "$UPSTREAM" != fail ]; fi\n}\n${functions}\nfetch_mirrored mirror upstream '${expected}' "${asset}"\ncat "${asset}"`;
  return spawnSync('bash', ['-c', command], { encoding: 'utf8', env: { ...process.env, MIRROR: mirror, UPSTREAM: upstream } });
}
test('accepts a verified mirror', () => { const r = run('verified', 'fail'); assert.equal(r.status, 0); assert.match(r.stdout, /verified$/); });
test('falls back when the mirror download or checksum fails', () => { for (const mirror of ['fail', 'bad']) { const r = run(mirror, 'verified'); assert.equal(r.status, 0); assert.match(r.stdout, /verified$/); } });
test('rejects an invalid upstream copy', () => { const r = run('fail', 'bad'); assert.notEqual(r.status, 0); });
