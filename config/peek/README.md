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

Reuse is on with the router's light reset, which runs before the next job is registered:
it kills the previous job's processes, removes every container and volume (so the `peek-ci`
Postgres compose project and its data are gone), prunes unused images, and wipes
`/home/ci/work`, `/tmp`, `/var/tmp` and `/dev/shm` — the job checkout and its `target/`
drift, which the job never reads from (`CI_WORKSPACE` is `/home/user/ci/peek`). It then
re-extracts the runner and runs the health probe. This covers what
`scripts/ci/free-boat-disk.sh` frees by hand on the native path, plus the process and
Postgres cleanup that a fresh box gets for free.

## Snapshot boot and the pin

`snapshotBoot: true` is on, and the pin is the two Worker vars
`PROJECT_SNAPSHOT_NAME` / `PROJECT_SNAPSHOT_MANIFEST_SHA256`. Both are empty on purpose:
the router verifies `/home/user/.boat-ci/toolchain.sha256` and its own runner layout
inside the snapshot, and the native `ci-base` snapshot that `scripts/ci/ci-base-refresh.sh`
maintains carries neither. With the vars empty the project boots a plain box — the
documented fallback — and the job warms its own `target/` on the first run.

The pin is not automatic. A saved snapshot's name is fixed; `ci-base` is re-saved under the
same name, so it cannot be pinned as-is, and the router requires
`<name>-<yyyymmdd>-<hex>`. To turn snapshot boot on:

1. Build a router snapshot from the same tree `ci-base` holds (the router bootstrap, then
   `scripts/ci/ci-base-prime.sh`), and save it as `peek-ci-base-<yyyymmdd>-<hex>`.
2. Compute the SHA-256 of `/home/user/.boat-ci/toolchain.sha256` inside that snapshot.
3. Re-pin both vars and deploy: `wrangler deploy --var PROJECT_SNAPSHOT_NAME:<name> --var PROJECT_SNAPSHOT_MANIFEST_SHA256:<sha>`.

Because the name embeds the date, every `ci-base` refresh means a new router snapshot and a
new pair of vars; step 3 is the whole follow-up, and it is in `scripts/ci/boat-router-wizard.sh`
and the router section of Peek's `docs/runbook.md`. A missing snapshot answers
`snapshot_not_found`, and the router boots the box plain instead of failing the job.
