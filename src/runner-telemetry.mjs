import { Buffer } from 'node:buffer';

const telemetry = `#!/bin/bash
set +e
# Operator proof switch for the setup watchdog: a marker next to this hook
# (placed through the Boat file API, cleared by the Docker reset) holds the
# job in "Set up runner" so the watchdog's destroy-and-rerun path can be shown.
if test -e "\${BASH_SOURCE[0]%/*}/setup-hang-proof"; then printf 'BOAT_PROOF_SETUP_HANG\\n'; sleep 3600; fi
printf 'BOAT_VM_STATE time=%s\\n' "$(date -u +%FT%TZ)"
printf 'nproc='; nproc
printf 'memory_kib '; awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {printf "%s=%s ", $1, $2} END {print ""}' /proc/meminfo
printf 'load '; cat /proc/loadavg
printf 'cpu_ticks '; awk '$1 == "cpu" {print "steal=" $9, "all=" $0; exit}' /proc/stat
printf 'filesystem '; findmnt -n -o FSTYPE,SOURCE,TARGET --target /home/ci
printf 'filesystem_space '; stat -f -c 'type=%T block_size=%S blocks=%b free=%a' /home/ci
probe=$(mktemp /home/ci/.boat-io-probe.XXXXXXXX) || exit 0
trap 'rm -f -- "$probe"' EXIT
printf 'disk_write_direct '; timeout -k 2 2.2 dd if=/dev/zero of="$probe" bs=1M count=1024 oflag=direct 2>&1
if test -s "$probe"; then
  timeout -k 2 2.2 dd if="$probe" of=/dev/null bs=1M iflag=direct 2>&1 | awk '/ bytes .* copied,/ { for (i=1; i<=NF; i++) if ($i == "copied,") { bytes += $1; seconds += $(i+1); samples++ } } END { if (samples && seconds > 0) printf "disk_read_direct bytes=%.0f seconds=%.6f samples=%d MB_per_s=%.2f\\n", bytes, seconds, samples, bytes / seconds / 1000000; else print "disk_read_direct unavailable" }'
else
  printf 'disk_read_direct unavailable\\n'
fi
exit 0
`;

export function telemetrySetup(path, filesystem = '/home/ci') {
  const payload = Buffer.from(telemetry.replaceAll('/home/ci', filesystem)).toString('base64');
  return `printf %s '${payload}' | base64 -d > ${path}\nchmod 700 ${path}\nexport ACTIONS_RUNNER_HOOK_JOB_STARTED=${path} ACTIONS_RUNNER_HOOK_JOB_COMPLETED=${path}`;
}
