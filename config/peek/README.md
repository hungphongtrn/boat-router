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
| `spend.monthlyUsd` | `20` | One account admission ceiling for CI, refreshes, saved snapshot storage, and leases, at list price before credits. |
| `margin` | 0.1 | The router applies a margin to provider start windows. There is no separate native Boat lane for publish. |
| `openStartQueue`, `dayReserve` | `true`, `0` | One queue in arrival order, no per-project reserve. |
| `poolPacing` | `dynamic`, `unpaced: false` | Starts follow the provider's rolling windows instead of a free-running burst. |
| Project `reuse.mode` | `off` | One job per CI box. The box retires after the job. |
| `caps.concurrent` | `2` | At most two CI boxes for Peek at once. |
| `machineTtlSeconds` | 28800 | Provider auto-stop backstop; idle time before retirement counts toward spending. |
| labels | `peek-router` → `default`, `peek-router-light` → `small` | Both sizes can boot the rolling snapshot. The light label is for shellcheck, hygiene and the size check. |
| `workflowConcurrency` | `ci.yml`, prefix `shard (`, max 4 | A single pool handles the four nextest shards, subject to the lower project-wide concurrency cap. |
| `triggers` | `workflow_job` / `actions-jit` | The router starts a runner per job and hands it the JIT configuration. |
| `externalClaimer`, `localFirst` | absent | Boat handles `peek-router`; the separate GitHub light fallback does not claim that label. |

## Rolling snapshot

The Peek workflow `CI base snapshot` builds from an exact `develop` revision
with a green `ci` check. Its private refresh box primes the workspace and
toolchains and runs `src/snapshot-build.mjs`. The workflow keeps the newest
two ready rolling generations so the last good disk survives a failed refresh.

With `rollingSnapshot: true`, the router discovers the latest ready generation
from the same Boat identity, and reserves that exact snapshot for the box
before creating it. The immutable `peek-ci-…` name encodes the full SHA-256
of `/home/user/.boat-ci/toolchain.sha256` in base32. The box verifies the digest
and the manifest's files before registering a runner. Boot does not depend on
manually redeploying `PROJECT_SNAPSHOT_NAME` or
`PROJECT_SNAPSHOT_MANIFEST_SHA256`. If no ready generation exists, the job
waits; it does not silently cold-boot.
