# Local repository admission

## Budgeted local slots

Use `GITHUB_POLL_MAX_LIVE=<1..100>` with repository-token routing instead of
`GITHUB_POLL_UNPACED=true`. These settings are mutually exclusive. Slot mode
restores a project concurrency cap even for the open start queue, and bounds
account admission by the provider's live count plus uncertain local claims.
It keeps FIFO and the existing provider windows and paid-start budget, but
does not consume hourly pacing-floor credit: an available slot can start now.
`/router/claims` reports `admissionMode=slot_budget` when admission is sampled.

An idle box is held by the cost-aware policy below, not by a fixed zero hold. A
completed box can reset for queued work inside the cap; surplus boxes close on
the normal lifecycle tick. When reducing an existing fleet, excess boxes finish
their jobs before retiring; no busy runner is killed merely to reach the new cap.

Calculate a ceiling from `0.85 * creditBalanceSeconds / 3600 / hoursToRenewal`
and each machine's billing multiplier. `creditBalanceSeconds` includes prepaid
credit: do not mistake it for the monthly plan allowance. A $20 renewal includes
555.56 VM-hours, not the entire existing balance. Default boxes cost one VM-hour
per live hour. Job length converts slots to jobs/hour, not to free compute time.

Important: Peek's `ci` job holds its box while waiting for separate shards.
One slot cannot complete that dependency graph. Two slots are the operational
minimum, not a claim of sustainable continuous operation; when the sustainable
rate is below two, the workflow must reduce parent waiting or overall duty cycle.
No setting can guarantee both immediate admission whenever a slot frees and a
lower long-run burn rate under an indefinitely nonempty queue.

## Pool autoscaling

`GITHUB_POLL_MIN_LIVE=<1..100>` (default 1) and `GITHUB_POLL_MAX_LIVE=<1..100>`
(default 5 when either variable is set) size the pool to work instead of a fixed
cap. Either variable engages autoscaling with repository-token routing, is
refused with `GITHUB_POLL_UNPACED=true`, and the floor must not exceed the
ceiling. `GITHUB_POLL_MAX_LIVE` stays the ceiling.

The target is `clamp(queued + running, GITHUB_POLL_MIN_LIVE,
GITHUB_POLL_MAX_LIVE)`, counted from the GitHub job records on every tick. A
box beyond the target retires only while idle, through the existing
`live_budget` path; a busy runner is never killed to reach it.

The ceiling also follows the VM-hours budget, read from the provider limits at
most every 10 minutes. Hours per day left is `(vmHoursRemaining +
packBalanceHours) / daysToPeriodEnd`, with `daysToPeriodEnd` floored at 0.25.
When the last 24 hours of usage exceed that allowance the ceiling drops to
`GITHUB_POLL_MIN_LIVE` and the router logs `pool_ceiling` with reason
`hours_budget`; otherwise the ceiling is `GITHUB_POLL_MAX_LIVE` with reason
`work`. Unknown limit data leaves the ceiling at the max
(`hours_unavailable`).

A bare `GET /router/status`, with neither `project` nor `job_id`, returns the
latest `autoscale` object: floor, ceiling, target, ceiling reason, the budget
figures, and the queued and running counts of the last tick.

## Cost-aware idle hold

Boat bills VM time per second while a sandbox runs; a start is billed only when
a rolling start window is exceeded (verified against `GET /api/v1/limits`,
2026-11-26: per-second billing, `small` $0.018/h, `default` $0.036/h, `large`
$0.072/h, `xlarge` $0.20/h, plan $20/month = 555.56 VM-hours, no per-start
minimum, starts above the limits $0.03/$0.05/$0.07 by bracket, limits 12/min,
60/h, 200/day). A paid start at $0.03 therefore buys about 50 minutes of a
default box, which is the "already-paid window" the policy uses.

`src/router/hold-policy.mjs` is the pure decision. Inputs: box age, idle time,
queued jobs in the box's pool, the recent job arrival rate (jobs queued in the
lookback, per hour), the observed start rate (starts the account spent in the
rolling hour), and the ledger's hard remaining day and hour starts. Output:
keep or retire, and how much longer the box may stay idle.

- Inside the paid window the box stays warm for the next job.
- At the window end the box retires when the remaining starts cover the
  **observed start rate** with a margin in both the rolling day and hour
  windows. Reuse serves many jobs per start, so the job arrival rate is not the
  start demand: on 2026-11-26 a 46-job/hour queue spent 1 start/hour against 56
  remaining, and judging scarcity by jobs would have held boxes a free start did
  not need.
- Otherwise the box stays at most `scarceWindows` more paid windows, and only
  while its pool has queued work or the job arrival rate predicts at least
  `minExpectedJobs` inside the window. Unknown budget or rate data is never
  "plentiful".

Config lives in `config/<project>/account.json` under `reuse.holdPolicy` (a
project config may override it under the same key). Defaults:
`enabled: true`, `paidWindowSeconds: 3600`, `plentifulMargin: 0.5`,
`arrivalLookbackSeconds: 3600`, `minExpectedJobs: 1`, `scarceWindows: 1`.
`enabled: false` restores the legacy `idleHoldSeconds`/paid-start hold.
`GET /router/pools` reports the decision inputs and the outcome as
`reuseHoldPolicy` (`arrivalPerHour`, `startRatePerHour`, `dayRemaining`,
`hourRemaining`, `plentiful`). `GITHUB_POLL_MAX_LIVE` remains the live ceiling;
the hold policy does not move it.

## Leak sweep

Every complete reconcile sweeps provider sandboxes whose name is
`boat-router-<32 hex>` but that have no `create:` record, no `box:` record and
no ledger claim. Those are leaks: a restart or a lost durable record left them
behind, and each still holds one provider live slot, so admission refuses every
create with `ledger:concurrency` (the 2026-11-25 and 2026-11-26 incidents).
The sweep runs on every reconcile, not every ten minutes.

Attribution requires that this account holds exactly one project; with several,
the box could belong to another project, so it is left for an operator. A leaked
box with no GitHub runner and no in-progress job is adopted into the normal
lifecycle as `quarantined` and retired through the router's own
`quarantine_release -> destroy -> purge` path in the same reconcile. A leaked
box with a runner or a busy job is adopted and retires when that work finishes;
no busy runner or job is killed. Every adoption or retirement logs
`orphan_sweep` with `decision`, `leaked`, `claimed`, `runner` and `running`.
`test/router-leak-sweep.test.mjs` covers "unknown boxes hold every slot".

## Consumer contract

The router is the only allocator: it creates, holds, reuses, retires and sweeps
Boat boxes and owns the start budget and hold policy. Consumers ask for work and
release it; they never call `boat new` or `boat delete` themselves.

- CI's `ci`, `ci-test-run`, `check-run`, `shots-run` and
  `web-check` jobs run on `vars.PEEK_CI_RUNNER`; it is `peek-router` today,
  so the router maps the queued job to a sandbox. `ci-fallback.yml` uses
  `peek-local`.
- **Not yet router-only:** `promotion` in `ci.yml` and the image job in
  `ci-image.yml` still use `runs-on: boat`, which Boat's native GitHub
  integration allocates directly, and `ci-start-guard` may set
  `PEEK_CI_RUNNER` to `boat/from=ci-base`, also native. Those paths bypass
  the router's budget and hold policy. Moving them needs a router pool for the
  promotion size and the `ci-base` snapshot, so it is reported rather than
  changed here.
- Agent and external helpers use the router lease API
  (`POST /router/lease/<claim|renew|execute|status|stream|file-write|file-read|release>`
  with `Authorization: Bearer <control token>` and `X-Lease-Client`), which
  creates, renews and releases a sandbox inside the router's budget. See
  `docs/setup.md`.
- `scripts/ci/boat-ci.sh` in the Peek repository is a by-hand debugging tool
  and still calls `boat new`/`boat delete`; it is not called by CI
  (`docs/runbook.md`). Treat it as an operator tool only.

The local router may set `GITHUB_POLL_UNPACED=true` alongside `GITHUB_POLL_REPO`.
This opts into the existing ledger's unpaced mode: queued work uses available
start windows immediately instead of spreading the remaining allowance over
24 hours. Omit it to retain the account policy; only `true` and `false` are valid.
The override is rejected outside repository-token routing.

Provider concurrency and minute/hour/day limits, configured start ceilings,
FIFO fairness, idempotent claims, and the rolling paid-extra budget still apply.
This setting does not enable starts, increase a paid cap, buy credits, or change
the retired Cloudflare deployment. Free starts are not charged to the paid cap.
When a provider window or paid budget is full, requests remain pending and the
normal alarm/sweep retries them; `GET /router/pacing` and `/router/claims` expose
headroom and the paid budget's next roll-off time.

## 2026-11-20 diagnosis

The local pool had 14 pending creates. Replaying the exported ledger with
the provider snapshot refused the oldest as `pacing` and the other 13 as
`fairness`. The latter was a consequence, not an independent fairness defect.
The paced rate was 4.02 starts/hour, credit 0.13, and both hourly floor starts
were already used. Boat allowed starts: 138/200 daily starts, 9/60 hourly
starts, 15/100 active sandboxes, 692.65 VM-hours remaining, next start $0.
Paid-extra spend was $0 against the unchanged local $1.50 rolling cap.

With the local override and the authenticated reconcile endpoint, the pending
creates became Boat sandboxes without editing SQLite or refunding claims.
An existing queue's total wait includes the pre-fix stall; snapshot cloning and
runner bootstrap add further time and must be measured separately from admission.

## Definite registration rejection and stall detection

A GitHub 400/401/403/404/422 during registration, before any runner id was saved,
is a definite refusal, not an uncertain start. After two minutes and a later
complete runner/job snapshot proving absence, the normal quarantine release,
destroy and purge transitions retire that box. Existing quarantines recover
from their generation-specific diagnostic evidence. Transport errors, 408/429,
5xx, saved runners and running jobs retain the original conservative handling.
Both project and provider slots remain occupied until cleanup finishes.

If enabled demand has no usable live box or recent provider create for 15
minutes, the router logs `router_stalled` with `level=error`, demand, occupied
and quarantined box counts. Quarantines are not usable capacity. The timer is
durable, resets when capacity returns, and repeats at most every 15 minutes.
Inspect the local alarm with:

```sh
journalctl --user -u peek-boat-router.service --no-pager | grep router_stalled
```
