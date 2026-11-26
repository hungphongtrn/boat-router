# Boat router

This experimental router controls starts for Boat GitHub runners. The router is opt-in and is not production-ready. It has limited operational validation, and resets can fail or require operator recovery. It queues workflow jobs and controls when they start. It reuses a runner machine after a light reset and a health check, paces new starts against account limits, and shares capacity between configured projects through one open start queue.

Boat also supports native GitHub jobs with `runs-on: boat`. Use that path when its native scheduling and lifecycle fit your workload. This router adds an independently operated Cloudflare Worker and Durable Object for installations that need its pacing, reuse, health checks, and operator controls. Reuse requires an explicit project policy and a successful reset.

The Worker receives signed GitHub webhooks. The Durable Object keeps admission and pool state, coordinates starts, and exposes authenticated operator routes. Credentials and installation data stay in the deployment configuration. See [CHANGELOG](CHANGELOG.md) for what changed since the first release, with our own measurements.

## What the router does

- **One open start queue.** All projects of an account share one queue in order of arrival. There is no per-project reserve and no per-project start cap (`openStartQueue: true` on the account). Only account limits and money limits stop a start.
- **Pools by shape, not by project.** A box is planned for its size and base. A finished box is reset in place and handed to the next queued job of the same pool. Each box has an explicit state machine; see [box lifecycle](docs/box-lifecycle.md).
- **Max-parallel matrix runs.** For a workflow with `strategy.max-parallel`, set a `workflowConcurrency` rule. The router then plans boxes for the run's free slots, not for each held shard. A reservation that GitHub gives to another shard of the same run moves to that shard instead of expiring.
- **Box health check.** A fresh box and every reset box run a short probe: 100 synchronous 4 KiB writes, a 64 MiB direct write, a CPU hash, free memory, and leftover job processes. A box that misses a floor is marked slow. A slow box is handed out last, and a box that fails after a reset is never reused. The probe records the host CPU model, so you can see which host class is slow.
- **Local runners first (optional).** With an external claimer, a queued job is offered to your own runners for `offerSeconds` (we use 60) before the router plans a Boat box for it. A claimed local runner counts as supply of its pool, so the planner does not start a box for a job that a local runner holds.
- **Two accounts as one pool (optional).** A primary and a secondary Boat account can serve the same projects. Each start goes to the account with more free share. A refusal on the secondary account parks only that account.
- **Lease API (optional).** An authenticated client can lease a whole box of a given size, optionally from a pinned base snapshot, upload files with a fenced write, run commands over a stream, and return the box for reuse.
- **Snapshot boot (optional).** A project with `snapshotBoot: true` boots from a pinned Boat snapshot and falls back to a plain boot if the snapshot helper fails. The provider serves the snapshot's disk through a lazy layer, so the baseline and a box's first job walk the job tree's metadata and wait, bounded, until no job path still resolves into that layer; `lazySettleSeconds` in the refresh result records the cost of each first job.
- **Alerts.** The router posts webhook alerts for start windows, sandboxes, queue wait and the verification breaker. `tools/credit-alert.mjs` is a watcher module for credit runway and day-start alerts, with one message for each level and no repeats.

## Configure

See [setup](docs/setup.md). The example configuration starts with machine creation disabled (`ENABLED=false`). Run `npm test`, `npm run check`, and `npm run build` with Node 22 or later.

The Durable Object uses the fixed name `production-v1`. Changing it starts a separate state store.

## Pool autoscaling

The live-box pool can size itself to work and to the account's VM-hours budget
instead of a fixed cap. With repository-token routing, `GITHUB_POLL_MIN_LIVE`
(default 1) is the floor and `GITHUB_POLL_MAX_LIVE` (default 5 when either is
set, still the ceiling) is the maximum. The router targets `clamp(queued +
running, MIN, MAX)` on every tick, and the ceiling drops to the floor when the
last 24 hours of usage would exhaust the hours left before renewal. Surplus
boxes retire only when idle, never mid-job. See
[local admission](docs/local-admission.md#pool-autoscaling).
