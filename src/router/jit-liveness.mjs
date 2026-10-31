import { REFRESH_HELPER_IMAGE } from './reset-constants.mjs';

// Metadata only: never read runner logs, environment variables or arguments.
export const PROBE = `python3 -c 'import json,os,pathlib,time
p=pathlib.Path("/home/user/boat-ci-runner/_diag")
items=[]
if p.is_dir():
 for f in p.iterdir():
  try:
   if f.is_file() and not f.is_symlink(): items.append(f.stat().st_mtime)
  except OSError: pass
  if len(items)>2048: raise RuntimeError("too many files")
v=open("/proc/stat").readline().split()[1:]
hz=os.sysconf("SC_CLK_TCK")
cpu=sum(int(v[i]) for i in (0,1,2,5,6,7))/hz
print(json.dumps({"at":time.time(),"cpu":cpu,"mtime":max(items) if items else None}))'`;

// Reusable runner homes are private to ci. The local, already-pulled helper
// can stat the diagnostic directory without reading any diagnostic contents.
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const helperProbe = `set -eu
mtime=$(find /diag -maxdepth 1 -type f -exec stat -c %Y {} + | awk 'NR>2048 {exit 1} {if ($1>max) max=$1} END {if (NR) printf "%.0f", max; else print "null"}')
cpu=$(awk 'NR==1 {printf "%.2f", ($2+$3+$4+$7+$8+$9)/ENVIRON["TICKS"]; exit}' /proc/stat)
printf '{"at":%s,"cpu":%s,"mtime":%s}\\n' "$(date +%s)" "$cpu" "$mtime"`;
export const REUSE_PROBE = `ticks=$(getconf CLK_TCK) || exit 1; case "$ticks" in ''|*[!0-9]*) exit 1;; esac; docker run --rm --pull=never --network=none --read-only --mount type=bind,src=/home/ci/runner/_diag,dst=/diag,readonly --env TICKS="$ticks" --entrypoint /bin/sh '${REFRESH_HELPER_IMAGE}' -c ${shellQuote(helperProbe)}`;

const states = new Set(['queued', 'in_progress', 'completed', 'pending', 'waiting', 'skipped']);
export function observe(previous, sample, steps, now, quietMs = 1200000) {
  if (!Number.isFinite(now) || !Number.isSafeInteger(quietMs) || quietMs < 60000 || !Number.isFinite(sample?.at) || !Number.isFinite(sample?.cpu) || sample.cpu < 0 || !Number.isFinite(sample?.mtime) || sample.mtime > sample.at + 60 || !Array.isArray(steps) || steps.length > 200 || steps.some(step => !Number.isSafeInteger(step.number) || !states.has(step.status))) return { decision: 'unknown' };
  const signature = JSON.stringify(steps.map(step => [step.number, step.status]));
  if (!previous || sample.at <= previous.at || sample.cpu < previous.cpu || sample.mtime < previous.mtime) return { decision: 'observing', state: { ...sample, signature, lastProgressAt: now } };
  const active = sample.cpu - previous.cpu >= 1 || sample.mtime > previous.mtime || signature !== previous.signature;
  const state = { ...sample, signature, lastProgressAt: active ? now : previous.lastProgressAt };
  if (!Number.isFinite(state.lastProgressAt) || state.lastProgressAt > now) return { decision: 'unknown' };
  return { decision: now - state.lastProgressAt >= quietMs ? 'silent' : active ? 'active' : 'observing', state };
}
