import { pathToFileURL } from 'node:url';
import { bootstrapBody, environment, setupPhaseHelpers } from './bootstrap.mjs';
import { helperImageSetup } from './snapshot-bootstrap.mjs';
import { REFRESH_HELPER_IMAGE } from './router/reset-constants.mjs';

// The files a router snapshot's manifest covers, in the order `sha256sum` writes
// them. snapshotBootstrap verifies this manifest at boot, so every path listed
// here must be one the boot path can read from the restored disk: the runner
// layout, the start script, the toolchain binaries a Peek job calls, and the
// helper image's OCI blobs. The manifest is `/home/user/.boat-ci/toolchain.sha256`,
// and its SHA-256 is the pin (`PROJECT_SNAPSHOT_MANIFEST_SHA256`).
export function snapshotManifestFiles({ git = 'system' } = {}) {
  return [
    '/home/user/.boat-ci/runner.tar.gz',
    '/home/user/.local/bin/bun',
    '/home/user/.local/bin/cargo-nextest',
    '/home/user/.local/bin/ld.lld',
    '/home/user/.local/bin/pwsh',
    '/home/user/.local/bin/shellcheck',
    '/home/user/boat-ci-runner/Runner.Listener',
    '/home/user/boat-ci-runner/Runner.Worker',
    '/home/user/boat-ci-runner/run.sh',
    '/home/user/boat-ci-start.sh',
    ...(git === 'system' ? ['/usr/bin/git'] : ['/home/user/.local/bin/git', '/home/user/.local/git/usr/bin/git']),
  ];
}

// The helper image is what the router's reset and start paths run; a reusable
// snapshot verifies it offline from these blobs when the restored Docker store
// cannot start it (see helperImageSetup). This downloads them from the registry,
// anonymously, with the registry's own digests, which is the only form the
// loader accepts: a locally re-saved image has different layer bytes.
function helperOciDownload() {
  return `phase snapshot_helper_oci
rm -rf /home/user/.boat-ci/helper-oci
python3 - '${REFRESH_HELPER_IMAGE.split('@sha256:')[1]}' <<'HELPER_OCI'
import hashlib, json, pathlib, sys, urllib.request
digest = sys.argv[1]
root = pathlib.Path('/home/user/.boat-ci/helper-oci')
root.mkdir(parents=True, exist_ok=True)
with urllib.request.urlopen('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull', timeout=30) as response:
    token = json.loads(response.read(65537))['token']
def fetch(path, expected, size=None):
    request = urllib.request.Request('https://registry-1.docker.io/v2/library/alpine/' + path, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
    with urllib.request.urlopen(request, timeout=60) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if 'sha256:' + hashlib.sha256(data).hexdigest() != expected or (size is not None and len(data) != size):
        raise SystemExit('helper blob ' + path + ' does not match ' + expected)
    return data
def store(name, data):
    (root / name).write_bytes(data)
manifest = fetch('manifests/sha256:' + digest, 'sha256:' + digest)
image = json.loads(manifest)
if len(image.get('layers', [])) != 1:
    raise SystemExit('the helper manifest must have one layer')
store(digest, manifest)
for descriptor in [image['config'], *image['layers']]:
    store(descriptor['digest'][7:], fetch('blobs/' + descriptor['digest'], descriptor['digest'], descriptor['size']))
print('helper-oci ' + digest + ' ' + str(len(list(root.iterdir()))) + ' blobs')
HELPER_OCI`;
}

// The build runs inside a box created from the native `ci-base` snapshot (or
// from the previous router snapshot), after `scripts/ci/ci-base-prime.sh` has
// primed `/home/user/ci/peek`. It installs the layout a plain router boot
// installs, then writes the manifest and clears the markers a saved disk must
// not carry.
//
// The bootstrap body runs with `git: 'system'`: no toolchain mirror is hosted
// for this deployment, so it must not try to download the pinned package. That
// mode installs no git and its start script only asks that git works, so it is
// also safe on an image that already carries the mirror's git. The manifest
// then lists whichever git the box resolves: a boot verifies what this build
// found, not what a mode says it should find.
export function snapshotBuildScript() {
  const common = snapshotManifestFiles().filter(file => file !== '/usr/bin/git').map(file => `'${file}'`).join(' ');
  return `#!/usr/bin/env bash
set -Eeuo pipefail
${environment()}
export PATH="/home/user/.cargo/bin:$PATH"
${setupPhaseHelpers()}
# The image may already carry a finished bootstrap (\`ready\`); this build still
# installs its own layout so the manifest names paths that exist as written.
rm -f /home/user/.boat-ci/ready
${bootstrapBody({ git: 'system' })}
${helperOciDownload()}
${helperImageSetup()}
phase snapshot_manifest
# A saved disk is the next job's starting point: no one-shot markers, no stale
# registration, no finished job's log.
rm -f /home/user/.boat-ci/ready /home/user/.boat-ci/jit /home/user/.boat-ci/started /home/user/.boat-ci/runner.log
rm -f /home/user/boat-ci-runner/.runner /home/user/boat-ci-runner/.credentials /home/user/boat-ci-runner/.credentials_rsaparams /home/user/boat-ci-runner/.service
phase snapshot_peek
# What ci-base contains, which is the reason to pin this snapshot at all: the
# primed tree the check checks out into, the pinned Rust toolchain, nextest,
# bun, and the suite's Postgres image kept by a container.
test -d /home/user/ci/peek/target
test -f /home/user/ci/peek/.ci-base-built-at
( cd /home/user/ci/peek && rustc --version && cargo --version && cargo clippy --version )
cargo-nextest nextest --version
bun --version
docker image inspect postgres:17 >/dev/null
phase snapshot_manifest_write
manifest=/home/user/.boat-ci/toolchain.sha256
: > "$manifest"
sha256sum -- ${common} >> "$manifest"
# The git a job gets is the one PATH resolves first, so the manifest follows the
# wrapper when the image installed the mirror's package and /usr/bin/git otherwise.
git_path=$(readlink -f "$(command -v git)")
case $git_path in
/home/user/.local/*) sha256sum -- '/home/user/.local/bin/git' '/home/user/.local/git/usr/bin/git' >> "$manifest" ;;
*) sha256sum -- '/usr/bin/git' >> "$manifest" ;;
esac
for blob in /home/user/.boat-ci/helper-oci/*; do sha256sum -- "$blob" >> "$manifest"; done
sha256sum --check --strict "$manifest" >/dev/null
phase snapshot_ready
printf 'ROUTER_SNAPSHOT_MANIFEST_SHA256 %s\\n' "$(sha256sum "$manifest" | cut -d' ' -f1)"
printf 'ROUTER_SNAPSHOT_READY\\n'
`;
}

// `node src/snapshot-build.mjs` prints the script, which is how peek's
// `scripts/ci/ci-base-refresh.sh --router` gets the build it pushes to the box.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.stdout.write(snapshotBuildScript());

