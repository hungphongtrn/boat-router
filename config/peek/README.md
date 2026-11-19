# Peek's router configuration

This fork serves one repository, `hungphongtrn/peek`, on the owner's Boat account. The
account and project data are `account.json` and `project.json` here; `config/installation.mjs`
registers them, and `config/policy.mjs` names the owner and the one repository. No example
project is registered, so an unregistered repository is refused by the webhook.

## Values and why

| Value | Setting | Reason |
|---|---|---|
| `starts` | 12/minute, 60/hour, 200/day | Boat's stated limits; the provider's `/limits` snapshot stays authoritative and the router caps at `min(configured, floor(limit × (1 − margin)))`. |
| `margin` | 0.1 | The router stops at 90 % of each window, which leaves about 20 daily starts for `publish`, which stays on native `runs-on: boat`. |
| `openStartQueue`, `dayReserve` | `true`, `0` | One queue in arrival order, no per-project reserve. |
| `poolPacing` | `dynamic`, `unpaced: false` | Starts follow the provider's rolling windows instead of a free-running burst. |
| `reuse` | `enabled`, `maxJobs: 30`, `maxAgeSeconds: 14400`, `idleHoldSeconds: 420` | A finished box is reset in place and handed to the next queued job. `idleHoldSeconds` keeps it warm long enough for the next pull request rather than spending a start on it. |
| `reuse.healthCheck` | `auto` | The probe runs on a fresh box and after every reset; a box that misses a floor is retired instead of reused. |
| `machineTtlSeconds` | 28800 | The reuse window is `min(maxAge, ttl − headroom)` and the headroom is `max(300, 1200 + maxJobTimeoutMinutes × 60)`. A shorter TTL silently turns reuse off for Peek's 30–40-minute jobs. |
| labels | `peek-router` → `default` | The one label Peek's jobs ask for. `boat-size-default` remains available but is not what the workflow uses. |
| `workflowConcurrency` | `ci.yml`, prefix `shard (`, max 4 | The four nextest shards of one full-scope check are planned as one run: at most four boxes, and a reservation GitHub gives to one shard moves to another waiting shard instead of becoming a zero-job box. |
| `triggers` | `workflow_job` / `actions-jit` | The router starts a runner per job and hands it the JIT configuration. |
| `externalClaimer`, `localFirst` | absent | No job runs on the owner's Linux box; the router plans a Boat box for every queued job. |

## Reuse and the reset

Reuse is on with the router's light reset, which runs before the next job is registered.
On a snapshot box it keeps what the snapshot is for — the Docker images (the suite's
`postgres:17` among them), the primed `/home/user/ci/peek/target/` and the Rust toolchain —
and clears what the finished job left:

- its processes: `pkill -u ci` plus every process whose executable or working directory is
  under `/home/user/ci/peek` or the runner's `/tmp/w`;
- its containers, volumes, networks and dangling images: the reset's own helper container
  (label `boat-light-reset`) and any `peek-ci-keep-*` container survive, and `docker image
  prune -f` without `-a` keeps the suite image;
- the peek checkout: `git reset --hard` and
  `git clean -ffdxq -e target -e node_modules -e .next -e .ci-base-built-at` in
  `/home/user/ci/peek`, so the next job fetches into the primed tree instead of a previous
  branch's files;
- the build cache under `/var/lib/peek-dagger`, without following mounts (`find -xdev`);
- `/home/ci`, `/tmp` (not the runner's `/tmp/w`), `/var/tmp` and `/dev/shm`, the runner's
  registration (`.runner`, `.credentials`), and the one-shot
  `/home/user/.boat-ci/{jit,started,ready}`.

A plain (never-saved) box keeps the old behaviour: everything below `/home/user/ci` is wiped
too, because nothing there was primed. It then re-extracts the runner and runs the health
probe. This covers what `scripts/ci/free-boat-disk.sh` frees by hand on the native path, plus
the process and Postgres cleanup that a fresh box gets for free.

## Snapshot boot and the pin

`snapshotBoot: true` is on, and the pin is the two Worker vars
`PROJECT_SNAPSHOT_NAME` / `PROJECT_SNAPSHOT_MANIFEST_SHA256`. The pin names a snapshot Peek
built for this router: `scripts/ci/ci-base-refresh.sh --router` primes one sandbox exactly as
the native `ci-base` refresh does, runs this router's builder on it
(`node src/snapshot-build.mjs` from this clone), and saves the disk twice — `ci-base` for the
native route, then `peek-ci-base-<yyyymmdd>-<commit8>` — printing both pin values. The
builder installs the runner layout a plain boot installs, caches the reset helper image's OCI
blobs, clears the one-shot markers, and writes `/home/user/.boat-ci/toolchain.sha256` over
the runner layout, the toolchain Peek jobs call, the helper blobs and the git PATH resolves.
The router verifies that file and the manifest hash at boot (`snapshotBootstrap`).

The pin follows a `ci-base` refresh only through that `--router` run:

1. Run `scripts/ci/ci-base-refresh.sh --router` in the peek clone (the router clone is
   `ROUTER` or `../boat-router`). One sandbox serves both routes; it prints
   `PROJECT_SNAPSHOT_NAME` and `PROJECT_SNAPSHOT_MANIFEST_SHA256`.
2. Commit both in `wrangler.jsonc`, so every later deploy carries them.
3. Deploy. Until the new name is deployed the old pin keeps booting the old snapshot, which
   is intact; a name is never reused, so a stale pin cannot point at a replaced disk.

An empty pin is still valid and is the fallback: the project boots a plain box and the job
warms its own `target/` on the first run.
A missing snapshot answers
`snapshot_not_found`, and the router boots the box plain instead of failing the job.
