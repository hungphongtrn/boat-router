import { Buffer } from 'node:buffer';
import { RELEASES } from '../bootstrap.mjs';
import { telemetrySetup } from '../runner-telemetry.mjs';
import { REFRESH_HELPER_IMAGE } from './reset-constants.mjs';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const hostCommand = script => {
  const payload = Buffer.from(script).toString('base64');
  return `docker run --rm --privileged --pid=host --network=host --volume /:/host:rw --entrypoint /bin/busybox --user 0:0 --workdir / --no-healthcheck --read-only '${REFRESH_HELPER_IMAGE}' chroot /host /usr/bin/nsenter --target 1 --mount --uts --ipc --net --pid -- /bin/bash --noprofile --norc -c ${quote(`printf %s '${payload}' | base64 -d | bash`)}`;
};

// Post-reset health check. Test shards starved for 40 minutes on boxes whose disk took 8-39 ms
// per 4 KiB synchronous write, against about 1 ms on healthy boxes, with idle CPU and high I/O wait. The check
// runs after the reset, so job processes are gone. A box that misses a floor is retired instead of reused.
// A measurement tool that fails leaves the box in service (measured=0): a broken probe must not retire the fleet.
// Live calibration 2026-11-11 (24 idle boxes, 100 x 4 KiB dsync writes): healthy 77-695 ms, slow 1,953-6,205 ms.
// The fsync floor sits in that gap. Mode 'observe' records the result only; 'enforce' retires a failing box.
export const RESET_HEALTH_LIMITS = Object.freeze({ cpuMs: 1000, fsyncMs: 1500, writeMs: 2500, memPct: 50 });
export const RESET_HEALTH_MODES = Object.freeze(['observe', 'enforce']);
const HEALTH_NUMBERS = ['cpuMs', 'fsyncMs', 'writeMs', 'memPct', 'foreign', 'measured', 'failed', 'slow'];
// One normalized record for every probe path: numbers, flags and the host CPU model (Ryzen 7 9700X hosts
// had 21-72 ms synchronous writes). The model string is restricted to a safe alphabet before it is stored.
export function normalizeHealth(value) {
  if (!value || !HEALTH_NUMBERS.every(key => Number.isSafeInteger(value[key]) && value[key] >= 0)) return null;
  const cpu = typeof value.cpu === 'string' && /^[A-Za-z0-9._()-]{1,64}$/.test(value.cpu) && value.cpu !== 'unknown' ? value.cpu.replaceAll('_', ' ') : null;
  return { cpuMs: value.cpuMs, fsyncMs: value.fsyncMs, writeMs: value.writeMs, memPct: value.memPct, foreign: value.foreign === 1, measured: value.measured === 1, failed: value.failed === 1, slow: value.slow === 1, cpu };
}
const FOREIGN_PROCESSES = 'node|nodejs|bun|deno|workerd|vitest|esbuild|Runner.Listener|Runner.Worker|chrome|chromium|headless_shell|java|playwright';
const healthCheck = enforce => `mark 'health check'
health_enforce=${enforce ? 1 : 0}
health_failed=0
health_slow=0
health_us() { local v; v=$(date +%s%6N 2>/dev/null) || v=0; [[ "$v" =~ ^[0-9]+$ ]] || v=0; printf '%s' "$v"; }
health_probe=/var/tmp/.boat-reset-health
measured=1
foreign=0
if pgrep -x '${FOREIGN_PROCESSES}' >/dev/null; then foreign=1; fi
mem_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo || true)
mem_avail=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo || true)
if [[ "$mem_total" =~ ^[0-9]+$ && "$mem_avail" =~ ^[0-9]+$ ]] && [ "$mem_total" -gt 0 ]; then mem_pct=$(( mem_avail * 100 / mem_total )); else mem_pct=100; measured=0; fi
host_cpu=$(awk -F: '/^model name/ {print $2; exit}' /proc/cpuinfo 2>/dev/null | sed 's/^ *//; s/ *$//' | tr ' ' '_' | tr -cd 'A-Za-z0-9._()-' | cut -c1-64 || true)
[ -n "$host_cpu" ] || host_cpu=unknown
sync || true
cpu_ms=0; fsync_ms=0; write_ms=0
t0=$(health_us)
if head -c 134217728 /dev/zero | sha256sum >/dev/null; then t1=$(health_us); else measured=0; t1=$t0; fi
cpu_ms=$(( (t1 - t0) / 1000 ))
for attempt in 1 2; do
  ok=1; t0=$(health_us)
  for i in $(seq 1 100); do dd if=/dev/zero of="$health_probe" bs=4k count=1 oflag=dsync status=none || { ok=0; break; }; done
  t1=$(health_us)
  if [ "$ok" -ne 1 ]; then measured=0; fsync_ms=0; break; fi
  value=$(( (t1 - t0) / 1000 ))
  if [ "$attempt" -eq 1 ] || [ "$value" -lt "$fsync_ms" ]; then fsync_ms=$value; fi
  [ "$fsync_ms" -le ${RESET_HEALTH_LIMITS.fsyncMs} ] && break
  sleep 2
done
for attempt in 1 2; do
  t0=$(health_us)
  if ! dd if=/dev/zero of="$health_probe" bs=1M count=64 oflag=direct status=none; then measured=0; write_ms=0; break; fi
  t1=$(health_us)
  value=$(( (t1 - t0) / 1000 ))
  if [ "$attempt" -eq 1 ] || [ "$value" -lt "$write_ms" ]; then write_ms=$value; fi
  [ "$write_ms" -le ${RESET_HEALTH_LIMITS.writeMs} ] && break
  sleep 2
done
rm -f "$health_probe"
for value in "$cpu_ms" "$fsync_ms" "$write_ms"; do [[ "$value" =~ ^[0-9]+$ ]] || { measured=0; cpu_ms=0; fsync_ms=0; write_ms=0; }; done
if [ "$cpu_ms" -gt ${RESET_HEALTH_LIMITS.cpuMs} ] || [ "$fsync_ms" -gt ${RESET_HEALTH_LIMITS.fsyncMs} ] || [ "$write_ms" -gt ${RESET_HEALTH_LIMITS.writeMs} ]; then health_slow=1; fi
if [ "$health_slow" -ne 0 ] || [ "$foreign" -ne 0 ] || [ "$mem_pct" -lt ${RESET_HEALTH_LIMITS.memPct} ]; then health_failed=1; fi
printf 'BOAT_RESET_HEALTH cpu_ms=%s fsync_ms=%s write_ms=%s mem_pct=%s foreign=%s measured=%s failed=%s slow=%s cpu=%s\\n' "$cpu_ms" "$fsync_ms" "$write_ms" "$mem_pct" "$foreign" "$measured" "$health_failed" "$health_slow" "$host_cpu" >&2
if [ "$health_failed" -eq 1 ] && [ "$health_enforce" -eq 1 ]; then
  printf 'BOAT_RESET_GUARD health\\n' >&2; false
fi`;
const STEPS = 'kill processes|docker prune|clean work dir|prepare runner|sanity checks|health check';
const HEALTH_LINE = /^BOAT_RESET_HEALTH cpu_ms=(\d{1,9}) fsync_ms=(\d{1,9}) write_ms=(\d{1,9}) mem_pct=(\d{1,3}) foreign=([01]) measured=([01]) failed=([01]) slow=([01]) cpu=([A-Za-z0-9._()-]{1,64})$/m;
const healthOf = match => match ? normalizeHealth({ cpuMs: Number(match[1]), fsyncMs: Number(match[2]), writeMs: Number(match[3]), memPct: Number(match[4]), foreign: Number(match[5]), measured: Number(match[6]), failed: Number(match[7]), slow: Number(match[8]), cpu: match[9] }) : null;

export function lightResetCommand(generation, leaseId = null, minimumDiskKiB = 4194304, minimumHomeDiskKiB = 4194304, healthMode = 'observe') {
  if (!RESET_HEALTH_MODES.includes(healthMode)) throw new TypeError('Invalid health mode');
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 60) throw new TypeError('Invalid generation');
  if (leaseId !== null && !/^[a-f0-9-]{36}$/.test(leaseId)) throw new TypeError('Invalid lease');
  if (!Number.isSafeInteger(minimumDiskKiB) || minimumDiskKiB < 4194304) throw new TypeError('Invalid disk floor');
  if (!Number.isSafeInteger(minimumHomeDiskKiB) || minimumHomeDiskKiB < 4194304) throw new TypeError('Invalid home disk floor');
  const script = `set -euo pipefail
step='kill processes'
mark() { step="$1"; printf 'BOAT_RESET_STAGE step=%s\\n' "$step" >&2; }
trap 'code=$?; printf "\\nBOAT_RESET_FAILURE step=%s exit=%s\\n" "$step" "$code" >&2' ERR
mark 'kill processes'
pkill -KILL -u ci || true
for i in $(seq 1 50); do pgrep -u ci >/dev/null || break; sleep .1; done
if pgrep -u ci >/dev/null; then printf 'ci processes remain\n' >&2; false; fi
${leaseId ? `if id externallease >/dev/null 2>&1; then
  test -f /var/lib/boat-ci-reuse/external-lease-user
  test "$(cat /var/lib/boat-ci-reuse/external-lease-user)" = '${leaseId}'
  pkill -KILL -u externallease || true
  for i in $(seq 1 50); do pgrep -u externallease >/dev/null || break; sleep .1; done
  if pgrep -u externallease >/dev/null; then printf 'external lease processes remain\n' >&2; false; fi
  find /tmp /var/tmp /dev/shm -xdev -mindepth 1 -user externallease -delete
  userdel externallease
  rm -f /var/lib/boat-ci-reuse/external-lease-user
elif test -e /var/lib/boat-ci-reuse/external-lease-user; then
  false
fi` : ''}
# Peek's snapshot boxes run no ci user: the runner and its jobs live on the
# box user, with the tree at /home/user/ci/peek and the work folder /tmp/w. A
# cancelled or timed-out job leaves compilers and servers behind, and the next
# job must not inherit them.
foreign='node|nodejs|bun|deno|workerd|vitest|esbuild|Runner.Listener|Runner.Worker|chrome|chromium|headless_shell|java|playwright'
# Only the users a job runs as are fair game: by uid, because the helper
# container need not resolve either name. An unscoped pkill -x would kill every
# node process on the box, the reset's own caller included.
job_uids=$( { stat -c %u /home/ci 2>/dev/null || true; stat -c %u /home/user 2>/dev/null || true; } | sort -u)
for uid in $job_uids; do pkill -KILL -u "$uid" -x "$foreign" || true; done
for proc in /proc/[0-9]*; do
  pid=\${proc#/proc/}
  [ "$pid" = "$$" ] && continue
  for link in exe cwd; do
    target=$(readlink "$proc/$link" 2>/dev/null) || continue
    case "$target" in
    /tmp/w|/tmp/w/*|/home/user/ci/peek|/home/user/ci/peek/*)
      kill -KILL "$pid" 2>/dev/null || true
      ;;
    esac
  done
done
mark 'docker prune'
helpers=$(docker ps -q --filter label=boat-light-reset)
# A Peek snapshot keeps its Postgres image alive through a container that never
# runs (ci-base-prime.sh); removing it would drop the image from a later save.
keepers=$(docker ps -aq --filter 'name=^/peek-ci-keep-')
protected=$(printf '%s\n%s\n' "$helpers" "$keepers")
containers=$(docker ps -aq)
for container in $containers; do
  if ! printf '%s\n' "$protected" | grep -Fxq "$container"; then docker rm -f "$container" >/dev/null 2>&1 || true; fi
done
# The previous job's containers, volumes and networks go; images stay. A
# snapshot carries its toolchain as images (postgres:17, the Peek API image),
# and docker system prune -af deleted exactly what the reuse exists to keep,
# so every reused box pulled and rebuilt them again. Dangling layers still go.
docker volume prune -f >/dev/null
docker network prune -f >/dev/null
docker image prune -f >/dev/null
mark 'clean work dir'
if [ -d /home/ci ]; then
  find /home/ci/work /home/ci/toolcache -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + 2>/dev/null || true
  find /home/ci -mindepth 1 -maxdepth 1 ! -name work ! -name toolcache -exec rm -rf -- {} +
  wipe_uid=$(stat -c %u /home/ci)
elif [ -d /home/user ]; then
  # A snapshot box has no ci user: its jobs run as the box user.
  wipe_uid=$(stat -c %u /home/user)
else
  wipe_uid=''
fi
# Neither /home/ci nor /home/user exists outside those two image kinds, and a
# reset must not fail for want of a work folder it never had.
if [ -n "$wipe_uid" ]; then find /tmp /var/tmp /dev/shm -xdev -mindepth 1 -user "$wipe_uid" ! -path /tmp/w ! -path '/tmp/w/*' -delete 2>/dev/null || true; fi
${leaseId ? `rm -rf -- /tmp/lease-${leaseId}` : ''}
# The primed tree keeps what the primer built (target/, node_modules, .next and
# its stamp); only the previous job's checkout goes. target/ is the entire
# point of a snapshot box, so it is never cleaned here.
tree=/home/user/ci/peek
if [ -d "$tree/.git" ]; then
  git -C "$tree" -c safe.directory="$tree" reset --hard --quiet || true
  git -C "$tree" -c safe.directory="$tree" clean -ffdxq -e target -e node_modules -e .next -e .ci-base-built-at || true
fi
# Every job on a snapshot box runs as the box's own user, so that user must own
# the tree it checks out into. A generation that ran as another uid (the /home/ci
# layout a router-provisioned box has, or a snapshot box before 2026-11-20)
# chowned it away, and the next job then failed its checkout on "Permission
# denied". Hand the tree back only when it is not already the box user's.
if [ -d "$tree" ] && [ -d /home/user ]; then
  home_uid=$(stat -c %u /home/user); home_gid=$(stat -c %g /home/user)
  if [ "$(stat -c %u "$tree")" != "$home_uid" ]; then
    chown -R -h "$home_uid:$home_gid" "$tree" 2>/dev/null || true
  fi
fi
# The next job writes its own JIT config and must start from a clean marker and
# registration, and the snapshot verifier requires both absent at boot.
rm -f /home/user/.boat-ci/jit /home/user/.boat-ci/started /home/user/.boat-ci/runner.log
rm -f /home/user/boat-ci-runner/.runner /home/user/boat-ci-runner/.credentials /home/user/boat-ci-runner/.credentials_rsaparams /home/user/boat-ci-runner/.service
# The snapshot's Dagger cache (a mount point, 12 GB) is empty in every native
# job too: scripts/ci/free-boat-disk.sh in peek empties it the same way.
if [ -d /var/lib/peek-dagger ]; then
  find /var/lib/peek-dagger -xdev -depth -mindepth 1 -delete 2>/dev/null || true
fi
mark 'prepare runner'
if [ ! -f /home/user/.boat-ci/snapshot-mode ]; then
  # A native box keeps its runner under /home/ci and starts it as the ci user.
  mkdir -p /home/ci/runner
  printf '%s  %s\\n' '${RELEASES.runner.sha256}' /home/user/.boat-ci/runner.tar.gz | sha256sum -c - >/dev/null
  tar xzf /home/user/.boat-ci/runner.tar.gz -C /home/ci/runner
  chown -R ci:ci /home/ci/runner
else
  # A snapshot box keeps the runner the snapshot carries, and its start script.
  test -x /home/user/boat-ci-start.sh
  test -x /home/user/boat-ci-runner/run.sh
  test -f /home/user/.boat-ci/runner.tar.gz
fi
mark 'sanity checks'
if [ -d /home/ci ]; then home=/home/ci; else home=/home/user; fi
for spec in "/:${minimumDiskKiB}" "$home:${minimumHomeDiskKiB}"; do
  path=\${spec%:*}; floor=\${spec##*:}
  disk_info=$(df -Pk "$path" | awk 'NR==2 {print $2, $4}')
  read -r total available <<< "$disk_info"
  if [[ ! "$total" =~ ^[0-9]+$ || ! "$available" =~ ^[0-9]+$ ]] || [ "$total" -le 0 ]; then printf 'BOAT_RESET_GUARD disk\n' >&2; false; fi
  if [ "$path" = "$home" ]; then quarter=$(( (total + 3) / 4 )); [ "$floor" -ge "$quarter" ] || floor=$quarter; fi
  [ "$floor" -le "$total" ] || floor=$total
  if ! [ "$available" -gt "$floor" ]; then printf 'BOAT_RESET_GUARD disk\n' >&2; false; fi
done
if pgrep -u ci >/dev/null; then printf 'ci processes remain\n' >&2; false; fi
${healthCheck(healthMode === 'enforce')}
printf '{"ok":true,"gen":${generation},"health":{"cpuMs":%s,"fsyncMs":%s,"writeMs":%s,"memPct":%s,"foreign":%s,"measured":%s,"failed":%s,"slow":%s,"cpu":"%s"}}\\n' "$cpu_ms" "$fsync_ms" "$write_ms" "$mem_pct" "$foreign" "$measured" "$health_failed" "$health_slow" "$host_cpu"`;
  return hostCommand(script).replace('docker run --rm ', 'docker run --rm --label boat-light-reset ');
}

export function parseLightResetResult(response, generation) {
  if (response?.running === true) return null;
  if (response?.exitCode !== 0) {
    const output = [response?.stdout, response?.stderr].filter(value => typeof value === 'string').join('\n');
    const match = new RegExp(`BOAT_RESET_FAILURE step=(${STEPS}) exit=(\\d+)`).exec(output);
    const stages = [...output.matchAll(new RegExp(`BOAT_RESET_STAGE step=(${STEPS})`, 'g'))];
    const step = match?.[1] ?? stages.at(-1)?.[1] ?? 'reset command';
    const exitCode = match ? Number(match[2]) : Number.isInteger(response?.exitCode) ? response.exitCode : null;
    const stageLine = new RegExp(`^BOAT_RESET_STAGE step=(${STEPS})$`);
    const tail = output.split('\n').slice(-20).map(line => stageLine.test(line) || HEALTH_LINE.test(line) ? line : '[redacted]').join('\n');
    const health = healthOf(HEALTH_LINE.exec(output));
    const guard = /^BOAT_RESET_GUARD disk$/m.test(output) ? 'disk' : /^BOAT_RESET_GUARD health$/m.test(output) ? 'health' : null;
    return { ok: false, step, exitCode, output: tail, ...(guard ? { guard } : {}), ...(health ? { health } : {}) };
  }
  if (response?.stdoutTruncated === true || typeof response?.stdout !== 'string' || response.stdout.length > 1024) return { ok: false, step: 'read reset result', exitCode: 0, output: '' };
  try {
    const result = JSON.parse(response.stdout.trim());
    const ok = result?.ok === true && result.gen === generation;
    const health = normalizeHealth(result?.health);
    return ok && health ? { ok, summary: { health } } : { ok };
  } catch { return { ok: false }; }
}

// Fresh boxes (generation 0) get the same measurements once before their first job (a fresh
// box on a slow-disk host starved a test shard). The probe never fails on its own; the router decides.
export function healthProbeCommand() {
  const script = `set -euo pipefail
mark() { :; }
${healthCheck(false)}
printf '{"health":{"cpuMs":%s,"fsyncMs":%s,"writeMs":%s,"memPct":%s,"foreign":%s,"measured":%s,"failed":%s,"slow":%s,"cpu":"%s"}}\\n' "$cpu_ms" "$fsync_ms" "$write_ms" "$mem_pct" "$foreign" "$measured" "$health_failed" "$health_slow" "$host_cpu"`;
  return hostCommand(script).replace('docker run --rm ', 'docker run --rm --label boat-light-reset ');
}

export function parseHealthProbe(response) {
  if (response?.running === true || response?.exitCode !== 0 || typeof response?.stdout !== 'string' || response.stdout.length > 1024) return null;
  try {
    return normalizeHealth(JSON.parse(response.stdout.trim().split('\n').at(-1))?.health);
  } catch { return null; }
}

export function lightResetDiagnosticCommand() {
  const script = `set +e
if log=$(dmesg 2>/dev/null); then
  if printf '%s' "$log" | grep -Eiq 'out of memory|oom.kill|killed process'; then
    printf '{"dmesgReadable":true,"oomObserved":true}\\n'
  else
    printf '{"dmesgReadable":true,"oomObserved":false}\\n'
  fi
else
  printf '{"dmesgReadable":false,"oomObserved":false}\\n'
fi`;
  return hostCommand(script).replace('docker run --rm ', 'docker run --rm --label boat-light-reset ');
}

export function lightStartCommand(generation) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > 60) throw new TypeError('Invalid generation');
  const start = `#!/bin/bash
set -euo pipefail
export HOME=/home/ci
export PATH="$(cat /home/ci/.path)"
export TMPDIR=/tmp TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
${telemetrySetup('/home/ci/telemetry.sh')}
cd /home/ci/runner
jit="$(cat /home/ci/.jit)"
rm -f /home/ci/.jit
exec setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all ./run.sh --jitconfig "$jit"
`;
  const script = `set -euo pipefail
if [ -f /home/user/.boat-ci/snapshot-mode ]; then
  # A snapshot box carries its runner and its own start script under /home/user,
  # owned by 'user', and that script hands the JIT to the runner itself: a
  # generation start only has to run it as the user the box's first job runs as.
  # The /home/ci layout below exists only on a box the router provisioned
  # (2026-11-20: generation 1 died on its first line on a snapshot box, and the
  # router retired the box offline).
  exec systemd-run --quiet --unit=boat-ci-job-${generation} --property=User=user --property=Group=user --property=KillMode=control-group --property=RemainAfterExit=yes --property=TimeoutStopSec=10 --property=RuntimeMaxSec=14400 --property=WorkingDirectory=/home/user/boat-ci-runner --property=StandardOutput=null --property=StandardError=null bash /home/user/boat-ci-start.sh
fi
install -o ci -g ci -m 644 /var/lib/boat-ci-reuse/path /home/ci/.path
install -o ci -g ci -m 600 /home/user/.boat-ci/jit /home/ci/.jit
rm -f /home/user/.boat-ci/jit
printf %s '${Buffer.from(start).toString('base64')}' | base64 -d > /home/ci/start.sh
chown ci:ci /home/ci/start.sh
chmod 700 /home/ci/start.sh
systemd-run --quiet --unit=boat-ci-job-${generation} --property=User=ci --property=Group=ci --property=KillMode=control-group --property=RemainAfterExit=yes --property=TimeoutStopSec=10 --property=RuntimeMaxSec=14400 --property=WorkingDirectory=/home/ci/runner --property=StandardOutput=null --property=StandardError=null /home/ci/start.sh`;
  return hostCommand(script);
}
