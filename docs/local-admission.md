# Local repository admission

## Budgeted local slots

Use `GITHUB_POLL_MAX_LIVE=<1..100>` with repository-token routing instead of
`GITHUB_POLL_UNPACED=true`. These settings are mutually exclusive. Slot mode
restores a project concurrency cap even for the open start queue, and bounds
account admission by the provider's live count plus uncertain local claims.
It keeps FIFO and the existing provider windows and paid-start budget, but
does not consume hourly pacing-floor credit: an available slot can start now.
`/router/claims` reports `admissionMode=slot_budget` when admission is sampled.

Idle holds (including the paid-start extension) are zero. A completed box can
reset for queued work inside the cap; surplus boxes close on the normal lifecycle
tick. When reducing an existing fleet, excess boxes finish their jobs before
retiring; no busy runner is killed merely to reach the new cap.

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
