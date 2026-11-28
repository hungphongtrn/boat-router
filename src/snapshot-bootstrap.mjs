import { setupPhaseHelpers, RUNNER_WORK_FOLDER } from './bootstrap.mjs';
import { REFRESH_HELPER_IMAGE } from './router/reset-constants.mjs';

// A lease boots a disk its client then drives, so the disk must carry no tailnet
// identity: a leftover tailscaled state file or process would join our tailnet
// from inside a client's box. Only the paths are probed; no file content is read.
export const TAILSCALE_STATE = '/var/lib/tailscale/tailscaled.state';

export function noTailnetAssertion(statePath = TAILSCALE_STATE) {
  if (typeof statePath !== 'string' || !/^\/[A-Za-z0-9._\/-]{1,255}$/.test(statePath)) throw new TypeError('invalid tailscale state path');
  // errexit ignores a failure whose value is inverted with "!", so the process
  // probe reports its own failure instead of negating pgrep.
  return `test ! -e ${statePath}
if command -v pgrep >/dev/null 2>&1 && pgrep -x tailscaled >/dev/null 2>&1; then
  printf 'BOAT_SETUP_FAILED tailscaled is running\\n' >&2
  exit 1
fi`;
}

export function snapshotBootstrap(manifestSha256, { reusable = false, leaseProfileSha256 = null, browserManifestSha256 = null, noTailnet = false } = {}) {
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? '')) throw new TypeError('invalid snapshot manifest hash');
  if (leaseProfileSha256 !== null && !/^[a-f0-9]{64}$/.test(leaseProfileSha256)) throw new TypeError('invalid lease profile hash');
  if (browserManifestSha256 !== null && !/^[a-f0-9]{64}$/.test(browserManifestSha256)) throw new TypeError('invalid browser manifest hash');
  return `#!/usr/bin/env bash
set -Eeuo pipefail
export PATH="/home/user/.local/bin:$PATH"
export TMPDIR=/tmp TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
${setupPhaseHelpers()}
phase snapshot_verify
cd /
test -f /home/user/.boat-ci/toolchain.sha256
printf '%s  %s\\n' '${manifestSha256}' /home/user/.boat-ci/toolchain.sha256 | sha256sum --check --strict -
sha256sum --check --strict /home/user/.boat-ci/toolchain.sha256
${leaseProfileSha256 ? `test "$(cat /opt/boat-toolchain/.lease-profile-sha256)" = '${leaseProfileSha256}'` : ''}
${browserManifestSha256 ? `test -f /home/user/.boat-ci/browser-v1.sha256
printf '%s  %s\\n' '${browserManifestSha256}' /home/user/.boat-ci/browser-v1.sha256 | sha256sum --check --strict -
sha256sum --check --strict /home/user/.boat-ci/browser-v1.sha256
test -f /opt/boat-browser-v1/audit-browser-tree.py
test ! -L /opt/boat-browser-v1/audit-browser-tree.py
python3 /opt/boat-browser-v1/audit-browser-tree.py verify /opt/boat-browser-v1 /home/user/.boat-ci/browser-v1.links
` : ''}
test ! -e /home/user/.boat-ci/jit
test ! -e /home/user/.boat-ci/started
${noTailnet ? `phase snapshot_tailnet
${noTailnetAssertion()}
` : ''}test ! -e /home/user/.boat-ci/ready
for registration in .runner .credentials .credentials_rsaparams .service; do
  test ! -e "/home/user/boat-ci-runner/$registration"
done
test -x /home/user/boat-ci-start.sh
test -x /home/user/boat-ci-runner/run.sh
mkdir -p ${RUNNER_WORK_FOLDER}
${reusable ? `phase snapshot_helper
${helperImageSetup()}
` : ''}: > /home/user/.boat-ci/ready
phase ready
`;
}

// The helper image and the state a reusable snapshot boot needs: the OCI
// fallback for a restored Docker store that cannot start the image, the
// snapshot-mode flag every reset reads, and the PATH a reset and a start
// command source. The snapshot builder runs this too, so a snapshot it saves
// carries exactly what this boot check produces.
export function helperImageSetup() {
  return `test -d /home/user/.boat-ci/helper-oci
: > /home/user/.boat-ci/snapshot-mode
# 13 of 19 boot failures in 24 h were the helper's first docker run on a restored snapshot
# ("failed to start shim ... bootstrap parameters do not match"), and the restart in the retry loop then failed
# because systemd/D-Bus was still starting ("Transport endpoint is not connected"). Wait for systemd first.
if command -v systemctl >/dev/null; then timeout 90 bash -c 'until state=$(systemctl is-system-running 2>/dev/null); [ "$state" = running ] || [ "$state" = degraded ]; do sleep 2; done' || true; fi
timeout 120 bash -c 'until docker info >/dev/null 2>&1; do sleep 2; done'
if ! docker image inspect '${REFRESH_HELPER_IMAGE}' >/dev/null 2>&1; then
  python3 - '${REFRESH_HELPER_IMAGE.split('@sha256:')[1]}' <<'OCI'
import hashlib, io, json, pathlib, re, tarfile, sys
root = pathlib.Path('/home/user/.boat-ci/helper-oci')
digest = sys.argv[1]
def blob(value, size=None):
    if re.fullmatch(r'[a-f0-9]{64}', value) is None:
        raise ValueError('invalid OCI digest')
    data = (root / value).read_bytes()
    if len(data) > 8 * 1024 * 1024 or (size is not None and len(data) != size) or hashlib.sha256(data).hexdigest() != value:
        raise ValueError('invalid OCI blob')
    return data
manifest = blob(digest)
image = json.loads(manifest)
if image.get('schemaVersion') != 2 or len(image.get('layers', [])) != 1:
    raise ValueError('invalid OCI manifest')
descriptors = [image['config'], *image['layers']]
items = [(digest, manifest)]
for descriptor in descriptors:
    name = descriptor['digest']
    if not name.startswith('sha256:'):
        raise ValueError('invalid OCI descriptor')
    items.append((name[7:], blob(name[7:], descriptor['size'])))
index = {'schemaVersion': 2, 'manifests': [{'mediaType': 'application/vnd.oci.image.manifest.v1+json', 'digest': 'sha256:' + digest, 'size': len(manifest), 'annotations': {'org.opencontainers.image.ref.name': 'alpine:boat-offline'}}]}
with tarfile.open('/dev/shm/boat-ci-helper-image.tar', 'w') as archive:
    def add(name, data):
        info = tarfile.TarInfo(name)
        info.size = len(data)
        archive.addfile(info, io.BytesIO(data))
    add('oci-layout', b'{"imageLayoutVersion":"1.0.0"}')
    add('index.json', json.dumps(index).encode())
    for name, data in items:
        add('blobs/sha256/' + name, data)
OCI
  docker load --input /dev/shm/boat-ci-helper-image.tar >/dev/null
fi
timeout 120 bash -c 'until docker image inspect "${REFRESH_HELPER_IMAGE}" >/dev/null 2>&1; do sleep 2; done'
helper=(docker run --rm --pull=never --network=none '${REFRESH_HELPER_IMAGE}' true)
helper_ready=false
for attempt in 1 2 3 4; do
  if timeout 45 "\${helper[@]}" >/dev/null; then
    helper_ready=true
    break
  fi
  if [ "$attempt" -lt 4 ]; then
    if command -v systemctl >/dev/null; then timeout 60 bash -c 'until state=$(systemctl is-system-running 2>/dev/null); [ "$state" = running ] || [ "$state" = degraded ]; do sleep 2; done' || true; fi
    timeout 45 sudo -n systemctl restart containerd docker || true
    timeout 60 bash -c 'until docker info >/dev/null 2>&1; do sleep 2; done' || true
    sleep "$((attempt * 2))"
    timeout 120 bash -c 'until docker image inspect "${REFRESH_HELPER_IMAGE}" >/dev/null 2>&1; do sleep 2; done' || true
  fi
done
[ "$helper_ready" = true ]
printf '%s' "/home/user/.local/bin:$PATH" > /home/user/.boat-ci/reuse-path
chmod 600 /home/user/.boat-ci/reuse-path`;
}
