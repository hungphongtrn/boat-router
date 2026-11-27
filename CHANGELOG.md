# Changelog

## 0.2.0 (unreleased)

The router has run our own CI on Boat since the first release. This release ports the changes of those 11 days. The numbers below are our own measurements on our own workloads and accounts, with dates. They are not benchmarks. Your results depend on your jobs, limits and host mix.

### Scheduling

- **Open start queue.** An account with `openStartQueue: true` has one start queue for all projects, with no per-project reserve or start cap. Only account and money limits stop a start.
- **Max-parallel matrix pool.** A `workflowConcurrency` rule caps the boxes for a matrix run at its `max-parallel`. A reservation that GitHub gives to another shard of the same run moves to a waiting shard (`matrix_retarget`). Measured on one 42-shard batch with `max-parallel: 16` (2026-11-11): 18 boxes against 21–31 for the same batches the day before (one 41-shard batch had made 35 boxes in 47 s); zero-job boxes from lost reservations 0 against about 40 a day; 2.17 shards per box against 1.29 jobs per start; queue to start p50 666 s against 899 s.
- **Local runners first.** `offerSeconds` holds a queued job for your own runners before a Boat box is planned (we moved from 30 s to 60 s). A claimed local runner counts as pool supply.
- **Two accounts as one pool.** A secondary Boat account serves the same projects. Each start goes to the account with the larger free share. A refusal on the secondary account parks only that account. For us this took the day limit from 600 to 1,000 starts.
- **Lane rules.** Optional lanes by run name, with reserved slots, aging, a per-lane `maxParallel`, and lending of idle reserved slots. The open start queue turns lanes off.
- **Dynamic pacing** spreads starts against the provider's rolling day window from tracked start times.
- **Paid extra starts.** An account with `starts.allowPaidExtra: true` may start past Boat's free day allowance: the configured `starts.day` is the ceiling (with `margin`) and a billed next start up to $0.07 is accepted. Minute and hour limits, `canStart`, checkout, billing and funds still stop a start. Off by default. `starts.paidExtraMaxDollarsPerMonth` bounds the rolling 30-day spend on those starts: each is recorded at its price (or $0.07 when the provider omits it), a start past the budget waits as `paid_extra_budget` until the oldest record ages out, and free starts never count. `/router/claims` and `/router/pacing` report the spend.
- **Pool autoscaling.** The live-box pool sizes itself to queued work and the account's VM-hours budget instead of a fixed cap. `GITHUB_POLL_MIN_LIVE` (default 1) and `GITHUB_POLL_MAX_LIVE` (default 5 when either is set) re-evaluate `clamp(queued + running, MIN, MAX)` on every tick; the target is decided at the start of each tick, before any admission path runs, so the first tick after a restart already enforces it. The budget is always computed and logged (`pool_ceiling`, reason `hours_budget` when the last 24 hours of usage would exhaust the hours left before renewal); `GITHUB_POLL_HOURS_BUDGET=log|enforce` (default `log`) decides whether an exceeded budget floors the ceiling to the floor or spends the remaining hours fast and lets local runners take over. Surplus boxes retire only when idle through the existing budget path, never mid-job; a bare `GET /router/status` reports the mode and the latest decision.

### Box health and lifecycle

- **Health check on fresh and reset boxes.** 100 synchronous 4 KiB writes, a 64 MiB direct write, a CPU hash, free memory and leftover processes. Measured on 24 idle boxes (2026-11-11): healthy 77–695 ms, slow 1,953–6,205 ms for the 100 writes; the floor is 1,500 ms. All slow boxes we found were on one host CPU model; the other three models were fast. A test shard on a slow box ran at about 51 ms for each synchronous write, with 91 % I/O pressure, and starved for about 40 minutes.
- **Slow boxes are handed out last**, and a box that fails after a reset is never reused. In `auto` mode a fresh box is retired only while the account can afford the replacement start.
- **Box state machine.** Every state write goes through one transition table (`docs/box-lifecycle.md`). Stale supply ends on a timer.
- **Reset diagnostics** name the failed step and keep a short, redacted tail. A verification breaker per size stops starts after repeated reset or boot failures and probes again.
- **Setup watchdog** destroys a box whose job stays in "Set up runner" past a limit and reruns the job after GitHub completes the cancelled one.
- **Docker-enabled reuse** with an in-box reset and a baseline for labels that need Docker.
- **A snapshot box's job gets the group that owns the Docker socket.** The job runs as the ephemeral `ci` uid, which the image never puts in the `docker` group, so a job that calls Docker failed with "docker is unreachable in the sandbox" on the first snapshot box (2026-11-20). The start unit now names the socket's owning group, the access a native box's job inherits through `user`.
- **A snapshot box's second job starts its own runner.** Generation 0 of a snapshot box runs `/home/user/boat-ci-start.sh`, but a generation start built the `/home/ci` layout a router-provisioned box has, so the unit died on its first line and the router retired the box as offline after every first job (2026-11-20, two boxes). A snapshot box now starts its own script for the next generation too, which is what makes reuse work on one.

### Boot

- **Snapshot boot** for a project, with a plain-boot fallback. The snapshot helper now waits for systemd and Docker before its first container run. Before this change, 13 of 19 boot failures in 24 hours were that first run (2026-11-11).
- **Checksum-pinned toolchain** with mirror fallback and retries for a minute on any error. The git package is pinned to 2.56.0 because the upstream PPA build of 2.55.0 was deleted (404). The runner starts without ambient capabilities.
- **Boot diagnostics** name the setup phase and error category.

### Lease API

- An authenticated client can lease a whole box (`default` or `large`), optionally from a pinned base snapshot, run commands, stream output, read and write files, and return the box for reuse. File writes take a fence and wait up to 20 s for a running tick; the stream handshake has a timeout. On one seeded base, a type-check job waited 54 s and ran 47 s on a fresh box (2026-11-11).

### Operations

- `GET /export` returns every durable record except secrets, for disaster recovery.
- GitHub App secrets live in Worker secrets, not in Durable Object storage.
- `GET /router/boxes` lists boxes and counts slow boxes by host CPU model.
- `tools/credit-alert.mjs`: credit runway and day-start window alerts for a watcher, one message for each level, a 12-hour reminder, and no alert for an idle account at zero credit.

### What did not help

- **Shorter idle holds under a start limit.** Over 48 hours, warm holds after a job cost 320.5 credit-hours against 250.8 for the jobs themselves (our model, within about 2 % of the provider balance). A 300 s hold would have saved about 93 credit-hours on a day with spare starts, but it needs more starts, and on a day that hit the 600-start limit it did not fit. The cheaper fix was fewer wasted boxes (matrix pool) and a second account, not shorter holds.
- **Local-runner race.** We expected boxes to lose their job to local runners. All 40 zero-job boxes in one day lost their job to another Boat box of the same matrix run. The matrix pool fixed that.
