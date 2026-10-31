import { Buffer } from 'node:buffer';
import { RELEASES } from '../bootstrap.mjs';
import { REFRESH_HELPER_IMAGE } from './reset-constants.mjs';
import { redact } from '../redact.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hostCommand = script => {
  const payload = Buffer.from(script).toString('base64');
  return `docker run --rm --privileged --pid=host --network=host --volume /:/host:rw --entrypoint /bin/busybox --user 0:0 --workdir / --no-healthcheck --read-only '${REFRESH_HELPER_IMAGE}' chroot /host /usr/bin/nsenter --target 1 --mount --uts --ipc --net --pid -- /bin/bash --noprofile --norc -c ${quote(`printf %s '${payload}' | base64 -d | bash`)}`;
};

export function lightResetCommand(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 60) throw new TypeError('Invalid generation');
  const script = `set -euo pipefail
step='kill processes'
trap 'code=$?; printf "\\nBOAT_RESET_FAILURE step=%s exit=%s\\n" "$step" "$code" >&2' ERR
pkill -KILL -u ci || true
for i in $(seq 1 50); do pgrep -u ci >/dev/null || break; sleep .1; done
if pgrep -u ci >/dev/null; then printf 'ci processes remain\n' >&2; false; fi
step='docker prune'
helpers=$(docker ps -q --filter label=boat-light-reset)
containers=$(docker ps -q)
for container in $containers; do
  if ! printf '%s\n' "$helpers" | grep -Fxq "$container"; then docker rm -f "$container" >/dev/null; fi
done
docker system prune -af --volumes >/dev/null
step='clean work dir'
find /home/ci/work /home/ci/toolcache -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find /home/ci -mindepth 1 -maxdepth 1 ! -name work ! -name toolcache -exec rm -rf -- {} +
find /tmp /var/tmp /dev/shm -xdev -mindepth 1 -user ci ! -path /tmp/w ! -path '/tmp/w/*' -delete
step='prepare runner'
mkdir /home/ci/runner
printf '%s  %s\\n' '${RELEASES.runner.sha256}' /home/user/.boat-ci/runner.tar.gz | sha256sum -c - >/dev/null
tar xzf /home/user/.boat-ci/runner.tar.gz -C /home/ci/runner
chown -R ci:ci /home/ci/runner
step='sanity checks'
for path in / /home/ci; do available=$(df -Pk "$path" | awk 'NR==2 {print $4}'); [ "$available" -gt 4194304 ]; done
if pgrep -u ci >/dev/null; then printf 'ci processes remain\n' >&2; false; fi
printf '{"ok":true,"gen":${generation}}\\n'`;
  return hostCommand(script).replace('docker run --rm ', 'docker run --rm --label boat-light-reset ');
}

export function parseLightResetResult(response, generation) {
  if (response?.running === true) return null;
  if (response?.exitCode !== 0) {
    const output = [response?.stdout, response?.stderr].filter(value => typeof value === 'string').join('\n');
    const match = /BOAT_RESET_FAILURE step=(kill processes|docker prune|clean work dir|prepare runner|sanity checks) exit=(\d+)/.exec(output);
    const step = match?.[1] ?? 'reset command';
    const exitCode = match ? Number(match[2]) : Number.isInteger(response?.exitCode) ? response.exitCode : null;
    const tail = redact(output.replace(/BOAT_RESET_FAILURE step=.* exit=\d+\s*/g, '').split('\n').slice(-20).join('\n').slice(-4096));
    return { ok: false, step, exitCode, output: tail };
  }
  if (response?.stdoutTruncated === true || typeof response?.stdout !== 'string' || response.stdout.length > 1024) return { ok: false, step: 'read reset result', exitCode: 0, output: '' };
  try {
    const result = JSON.parse(response.stdout.trim());
    return { ok: result?.ok === true && result.gen === generation };
  } catch { return { ok: false }; }
}

export function lightStartCommand(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 60) throw new TypeError('Invalid generation');
  const start = `#!/bin/bash
set -euo pipefail
export HOME=/home/ci
export PATH="$(cat /home/ci/.path)"
export TMPDIR=/tmp TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
cd /home/ci/runner
jit="$(cat /home/ci/.jit)"
rm -f /home/ci/.jit
exec setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all ./run.sh --jitconfig "$jit"
`;
  const script = `set -euo pipefail
install -o ci -g ci -m 644 /var/lib/boat-ci-reuse/path /home/ci/.path
install -o ci -g ci -m 600 /home/user/.boat-ci/jit /home/ci/.jit
rm -f /home/user/.boat-ci/jit
printf %s '${Buffer.from(start).toString('base64')}' | base64 -d > /home/ci/start.sh
chown ci:ci /home/ci/start.sh
chmod 700 /home/ci/start.sh
systemd-run --quiet --unit=boat-ci-job-${generation} --property=User=ci --property=Group=ci --property=KillMode=control-group --property=RemainAfterExit=yes --property=TimeoutStopSec=10 --property=RuntimeMaxSec=14400 --property=WorkingDirectory=/home/ci/runner --property=StandardOutput=null --property=StandardError=null /home/ci/start.sh`;
  return hostCommand(script);
}
