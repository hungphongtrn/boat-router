import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REFRESH_HELPER_IMAGE } from '../src/router/reset-constants.mjs';
import { snapshotManifestFiles, snapshotBuildScript } from '../src/snapshot-build.mjs';
import { helperImageSetup } from '../src/snapshot-bootstrap.mjs';

test('the built script is a shell script the build box can run', () => {
  const script = snapshotBuildScript();
  assert.match(script, /^#!\/usr\/bin\/env bash\nset -Eeuo pipefail\n/);
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
  // The bootstrap body is reused, not copied: the runner layout a snapshot
  // carries is the one a plain boot installs.
  assert.match(script, /phase runner_download/);
  assert.match(script, /cat > \/home\/user\/boat-ci-start\.sh <<'START'/);
  assert.match(script, /phase git_system/);
  assert.doesNotMatch(script, /phase git_download/, 'no toolchain mirror is hosted for this deployment');
  assert.match(script, new RegExp(REFRESH_HELPER_IMAGE.split('@sha256:')[1]));
  assert.match(script, /ROUTER_SNAPSHOT_MANIFEST_SHA256/);
  assert.match(script, /ROUTER_SNAPSHOT_READY/);
});

test('the script writes the manifest snapshot boot verifies, over the same files', () => {
  const script = snapshotBuildScript();
  for (const file of snapshotManifestFiles()) assert.ok(script.includes(`'${file}'`), file);
  assert.match(script, /manifest=\/home\/user\/\.boat-ci\/toolchain\.sha256/);
  assert.match(script, /sha256sum --check --strict "\$manifest"/);
  assert.match(script, /rm -f \/home\/user\/\.boat-ci\/ready \/home\/user\/\.boat-ci\/jit \/home\/user\/\.boat-ci\/started/);
  assert.match(script, /rm -f \/home\/user\/boat-ci-runner\/\.runner \/home\/user\/boat-ci-runner\/\.credentials/);
  // The helper cache and the file that marks a reusable snapshot come from the
  // same function the boot check runs.
  assert.ok(script.includes(helperImageSetup()));
});

test('the manifest covers the runner, the job toolchain and git of the chosen mode', () => {
  const files = snapshotManifestFiles();
  for (const file of ['/home/user/boat-ci-start.sh', '/home/user/boat-ci-runner/run.sh', '/home/user/.local/bin/cargo-nextest', '/home/user/.local/bin/bun', '/home/user/.local/bin/ld.lld']) assert.ok(files.includes(file), file);
  assert.ok(files.includes('/usr/bin/git'));
  assert.ok(!snapshotManifestFiles({ git: 'mirror' }).includes('/usr/bin/git'));
  assert.ok(snapshotManifestFiles({ git: 'mirror' }).includes('/home/user/.local/git/usr/bin/git'));
  const script = snapshotBuildScript();
  // The script follows whichever git PATH resolves, so a boot verifies what the
  // box actually carries rather than what a mode claims.
  assert.match(script, /git_path=\$\(readlink -f "\$\(command -v git\)"\)/);
  assert.match(script, /\/home\/user\/\.local\/git\/usr\/bin\/git/);
  assert.match(script, /sha256sum -- '\/usr\/bin\/git'/);
  assert.match(script, /rm -f \/home\/user\/\.boat-ci\/ready\nmkdir -p/);
});

test('the build checks the primed tree it is about to pin', () => {
  const script = snapshotBuildScript();
  assert.match(script, /test -d \/home\/user\/ci\/peek\/target/);
  assert.match(script, /test -f \/home\/user\/ci\/peek\/\.ci-base-built-at/);
  assert.match(script, /docker image inspect postgres:17/);
  assert.ok(script.indexOf('phase snapshot_peek') < script.indexOf('phase snapshot_manifest_write'));
});
