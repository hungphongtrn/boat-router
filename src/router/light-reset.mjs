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
mark 'docker prune'
helpers=$(docker ps -q --filter label=boat-light-reset)
containers=$(docker ps -q)
for container in $containers; do
  if ! printf '%s\n' "$helpers" | grep -Fxq "$container"; then docker rm -f "$container" >/dev/null; fi
done
docker system prune -af --volumes >/dev/null
mark 'clean work dir'
find /home/ci/work /home/ci/toolcache -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
find /home/ci -mindepth 1 -maxdepth 1 ! -name work ! -name toolcache -exec rm -rf -- {} +
find /tmp /var/tmp /dev/shm -xdev -mindepth 1 -user ci ! -path /tmp/w ! -path '/tmp/w/*' -delete
${leaseId ? `rm -rf -- /tmp/lease-${leaseId}` : ''}
mark 'prepare runner'
mkdir /home/ci/runner
printf '%s  %s\\n' '${RELEASES.runner.sha256}' /home/user/.boat-ci/runner.tar.gz | sha256sum -c - >/dev/null
tar xzf /home/user/.boat-ci/runner.tar.gz -C /home/ci/runner
chown -R ci:ci /home/ci/runner
mark 'sanity checks'
for spec in /:${minimumDiskKiB} /home/ci:${minimumHomeDiskKiB}; do
  path=\${spec%:*}; floor=\${spec##*:}
  disk_info=$(df -Pk "$path" | awk 'NR==2 {print $2, $4}')
  read -r total available <<< "$disk_info"
  if [[ ! "$total" =~ ^[0-9]+$ || ! "$available" =~ ^[0-9]+$ ]] || [ "$total" -le 0 ]; then printf 'BOAT_RESET_GUARD disk\n' >&2; false; fi
  if [ "$path" = /home/ci ]; then quarter=$(( (total + 3) / 4 )); [ "$floor" -ge "$quarter" ] || floor=$quarter; fi
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
install -o ci -g ci -m 644 /var/lib/boat-ci-reuse/path /home/ci/.path
install -o ci -g ci -m 600 /home/user/.boat-ci/jit /home/ci/.jit
rm -f /home/user/.boat-ci/jit
printf %s '${Buffer.from(start).toString('base64')}' | base64 -d > /home/ci/start.sh
chown ci:ci /home/ci/start.sh
chmod 700 /home/ci/start.sh
systemd-run --quiet --unit=boat-ci-job-${generation} --property=User=ci --property=Group=ci --property=KillMode=control-group --property=RemainAfterExit=yes --property=TimeoutStopSec=10 --property=RuntimeMaxSec=14400 --property=WorkingDirectory=/home/ci/runner --property=StandardOutput=null --property=StandardError=null /home/ci/start.sh`;
  return hostCommand(script);
}
