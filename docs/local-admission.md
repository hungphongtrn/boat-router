# Local repository admission

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
