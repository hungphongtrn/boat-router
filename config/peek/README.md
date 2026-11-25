# Peek's router configuration

This fork serves one repository, `hungphongtrn/peek`, on the owner's Boat account. The
account and project data are `account.json` and `project.json` here; `config/installation.mjs`
registers them, and `config/policy.mjs` names the owner and the one repository. No example
project is registered, so an unregistered repository is refused by the webhook.

## Values and why

| Value | Setting | Reason |
|---|---|---|
| `starts` | 12/minute, 60/hour, 260/day | Boat's stated minute and hour limits; the provider's `/limits` snapshot stays authoritative and the router caps at `min(configured, floor(limit × (1 − margin)))`. The day value is 260 because `allowPaidExtra` raises the ceiling past Boat's free 200. |
| `starts.allowPaidExtra` | `true` | Past Boat's free 200 day starts the configured 260 is the ceiling: 234 paced (90 %) and 260 hard, and a billed `nextStartDollars` up to $0.07 is accepted. Minute and hour limits, `canStart`, checkout, billing status and zero funds still stop a start. Off by default. |
| `starts.paidExtraMaxDollarsPerMonth` | `2` | Caps the rolling 30-day spend on billed extra starts at $2. Each extra is recorded at `nextStartDollars`, or $0.07 when Boat omits the price; a start that would take the sum past the cap waits as `paid_extra_budget` until the oldest record ages out. Free starts never count. Omitted means no cap; `GET /router/claims` and `GET /router/pacing` report `paidExtra.spentUsd` and `capUsd`. |
| `margin` | 0.1 | The router stops at 90 % of each window, which leaves about 20 daily starts for `publish`, which stays on native `runs-on: boat`. |
| `openStartQueue`, `dayReserve` | `true`, `0` | One queue in arrival order, no per-project reserve. |
| `poolPacing` | `dynamic`, `unpaced: false` | Starts follow the provider's rolling windows instead of a free-running burst. |
| `reuse` | `enabled`, `maxJobs: 30`, `maxAgeSeconds: 14400`, `idleHoldSeconds: 5400`, `idleHoldSecondsWhenStartsPaid: 1200` | A finished box is reset in place and handed to the next queued job. `idleHoldSeconds` keeps it warm long enough for the next pull request rather than spending a start on it, and 90 minutes (not the account's 7) is the owner's ceiling on how long an idle box may hold a slot (2026-11-25). While the free day window is empty every start is billed, so the hold extends only to `idleHoldSecondsWhenStartsPaid` (20 min) and then the box retires as normal: past the plan's VM hours a kept box-hour costs about one paid start. |
| `caps.concurrent` | `2` | At most two boxes exist for Peek at once, the owner's cap (2026-11-25): a start waits while two boxes are up, and a surplus idle box is retired once its hold expires. The project env also carries it as `MAX_ACTIVE`, so the start ledger refuses a third concurrent box. |
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

- its processes: `pkill -u ci`, the job users' leftover `node`, `Runner.*`, browser and
  Playwright processes (by uid, taken from `/home/ci` and `/home/user`), and every process
  whose executable or working directory is under `/home/user/ci/peek` or the runner's `/tmp/w`;
- its containers, volumes, networks and dangling images: the reset's own helper container
  (label `boat-light-reset`) and any `peek-ci-keep-*` container survive, and `docker image
  prune -f` without `-a` keeps the suite image;
- the peek checkout: `git reset --hard` and
  `git clean -ffdxq -e target -e node_modules -e .next -e .ci-base-built-at` in
  `/home/user/ci/peek`, so the next job fetches into the primed tree instead of a previous
  branch's files;
- the build cache under `/var/lib/peek-dagger`, without following mounts (`find -xdev`);
- `/home/ci`, `/tmp` (not the runner's `/tmp/w`), `/var/tmp` and `/dev/shm`, the runner's
  registration (`.runner`, `.credentials`, `.credentials_rsaparams`, `.service`), and the
  one-shot `/home/user/.boat-ci/{jit,started,runner.log}`. A box with neither `/home/ci` nor
  `/home/user` skips the user wipe rather than failing the reset.

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
