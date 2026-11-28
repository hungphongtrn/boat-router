# Setup

The example is a starting point. Review the account, project, runner, GitHub App, and Cloudflare settings before use. Keep `ENABLED` set to `false` while you configure and verify the installation.

1. Install Node 22 or later and run `npm ci`.
2. Set the account and project data in `examples/account.json` and `examples/project.json`. Register them in `config/installation.mjs`. Set `starts.minute`, `starts.hour`, and `starts.day` to the provider limits for the account. Leave `starts.allowPaidExtra` unset to stop at the provider's day limit (see [Paid extra starts](#paid-extra-starts)). Set the repository, labels, sizes, concurrency caps, and reuse policy for each project.
3. Set `setupOwner`, `repositories`, and any smoke repository in `config/policy.mjs`. Update the GitHub App manifest in `config/github-app-manifest.json`. The setup owner check prevents storing an App made under a different login.
4. Set a unique Worker name, the `FLEET` Durable Object binding, migration, cron, and environment variables in `wrangler.jsonc`. Set `BOAT_WALLET`, `BOAT_PROVIDER_WALLET`, and `ROUTER_PROJECTS` to match the registration. Keep deployment credentials and API keys in secret storage.
5. Run `npm test`, `npm run check`, and `npm run build`. The last command is a Wrangler dry run. Inspect its output and bindings before deployment.
6. Configure the GitHub App and webhook secret for the target repositories. Verify the webhook signature, the operator control token, provider limits, and the disabled Worker before enabling starts under your own deployment procedure.

### Peek router maintenance

The `Boat router` GitHub workflow runs syntax checks, Node tests, and a Wrangler
dry run on pull requests and `main`; it does not need Boat or Cloudflare
credentials. Require `Router check` on `main`.

For a live rollout, configure the repository's `production` environment to
allow deployments from `main` only and require operator approval. Set
`CLOUDFLARE_ACCOUNT_ID`, `ROUTER_ENABLED` (`true` or `false`), `PUBLIC_ORIGIN`,
and `BOAT_PROVIDER_WALLET` as environment variables. Store an account-scoped
Workers Scripts Edit token as the `CLOUDFLARE_API_TOKEN` environment secret.
Check the tracked `wrangler.jsonc` against the live target before enabling
deploys: explicitly configured bindings and variables are applied even with
`--keep-vars`.

Dispatch `Boat router` on `main` with `deploy: true`. It rechecks the selected
revision, then deploys that revision only if it is still the head of `main`.
This updates `peek-boat-router` and reuses its `FLEET` Durable Object and
existing Worker secrets. It does not build or activate a new Boat snapshot.

For external claimers, configure `externalClaimer` on a project and use the authenticated `/router/local/claim`, `/router/local/started`, and `/router/local/release` routes. Scope credentials to the claimer. A claim remains held when runner retirement is uncertain. Investigate before using the operator release route.

The example enables the experimental router, pacing, and reuse, but `ENABLED=false` prevents machine starts. Replace `BOAT_PROVIDER_WALLET` with the provider wallet value. It must be nonempty and differ from the `BOAT_WALLET` account ID. Set `ROUTER_PROJECTS` to the registered project IDs. Replace `PUBLIC_ORIGIN` with the deployed HTTPS origin. Set start limits, `poolPacing`, TTL, reuse policy, and the cron to suit the provider account. `START_PACING` controls the legacy controller; `poolPacing` controls router pool starts.

Store `BOAT_CI_API_KEY`, `GITHUB_WEBHOOK_SECRET`, and the GitHub App private key as secrets. Configure `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` if the App is provisioned outside the setup flow. The setup flow stores App credentials after installation. Set `SETUP_BOOTSTRAP` to a JSON object containing `controlHash` for operator access. To create the GitHub App through the setup flow, also include `tokenHash` and `expiresAt`. Both hashes are lowercase SHA-256 hex digests of separate strong tokens. Use 32 to 128 letters, digits, underscores, or hyphens for each token. Set `expiresAt` to a future Unix timestamp in milliseconds. Open `PUBLIC_ORIGIN/setup?token=<setup-token>` before it expires. Store the bootstrap JSON as a secret. Set `LOCAL_CONTROL_HASH` to the SHA-256 hex digest of a separate token when using an external claimer. `RESUME_EPOCH` and `ALLOW_SMOKE` are optional operational controls. Review all settings before deployment.

Pool mode starts off. After setup, use an authenticated `POST /router/pool-mode?mode=on` to enable it. Pool activation sets the reuse override to `off`. After you review the reuse policy, send an authenticated `POST /router/reuse?project=project-a&mode=config` to use the configured policy. Replace `project-a` with your project ID. Verify both responses and the pool state before enabling machine starts. Reuse requires a successful reset.

Account `poolPacing.fromPct` activates pacing when hourly or daily usage reaches that fraction. The default is 0.7. Optional `waitForBusyBox` settings let queued jobs wait for a reusable busy runner as account limits become scarce. Set `enabled`, `maxWaitMs`, `scarcityFrom`, and `scarcityFull` in the account data. It is disabled by default.

## Open start queue

Set `openStartQueue: true` and `dayReserve: 0` on the account. All projects then share one start queue in order of arrival, with no per-project cap and no lane reserve. Project `caps.concurrent`, `caps.startsPerDay` and `lanes` are ignored in this mode. Account start limits (`starts`, `poolPacing`) and money limits still apply.

## Paid extra starts

Boat accepts starts past the account's free day allowance and bills each one (about $0.03–0.07 on our account). Set `starts.allowPaidExtra: true` on the account to spend them:

- `starts.day` becomes the day ceiling instead of being clamped to the provider's reported limit, still with `margin`. With `starts.day: 260` and a 10 % margin the router paces 234 starts and stops hard at 260.
- A `nextStartDollars` up to $0.07 is accepted. A higher price refuses the start as `paid_start_ceiling`; an omitted price gives no opinion.
- Set `starts.paidExtraMaxDollarsPerMonth` to bound the rolling 30-day spend (Peek uses `15`, fifteen dollars, inside the wider `spend.monthlyUsd` ledger that also charges the same start fee). Every admitted paid extra is recorded at `nextStartDollars`, or $0.07 when Boat omits the price; a start that would take the sum past the cap waits as `paid_extra_budget` with a `nextAt` of when the oldest record ages out. A free start is never counted or refused. Leave the field unset for no cap, which also keeps the ledger state as it was (nothing is recorded).
- `GET /router/claims` and `GET /router/pacing` report `paidExtra` (`capUsd`, `spentUsd`, `starts`, `nextRollOffAt`) on an account with the opt-in, so the spend is readable without the provider.
- Everything else still refuses: the provider's minute and hour windows, `canStart: false`, `checkoutRequired`, a blocked billing status (`past_due`, `unpaid`, `canceled`) and zero funds. Dynamic pacing and reuse stay in place, so extras follow the day rate instead of bursting.
- It is off by default. It needs an account ledger that may spend a billed start: the two-account cutover policy keeps `forbidPaidStarts: true`, so extras do not apply there.

## Max-parallel matrix runs

When a workflow uses `strategy.max-parallel`, add a rule to the project (or to `projects.<id>.workflowConcurrency` in the account file): `{ "workflowPath": ".github/workflows/ci.yml", "jobPrefix": "test", "maxParallel": 16 }`. The router plans at most `maxParallel` boxes for the run. When GitHub gives a reserved box to another shard of the same run, the reservation moves to a shard that still waits. Without a rule, the router plans one box for every held shard.

## Box health check

Set `reuse.healthCheck` on the account to `observe`, `enforce` or `auto`, and `reuse.healthEnforceMinStarts` (default 20).

- The probe runs on every fresh box before its first job and after every reset. It measures 100 synchronous 4 KiB writes, a 64 MiB direct write, a CPU hash and free memory, and looks for leftover job processes. Floors are in `RESET_HEALTH_LIMITS` in `src/router/light-reset.mjs` (synchronous writes: 1,500 ms).
- `observe` records the result only. `enforce` retires a box that fails. `auto` enforces on fresh boxes only while the account has at least `healthEnforceMinStarts` day starts left, credit above zero, and starts allowed. A box that fails after a reset is never reused in `auto` or `enforce`.
- A box marked slow is handed out last: it yields to a healthy ready box of the same pool while the job has waited under 120 s. `GET /router/boxes?project=<id>` lists boxes and counts slow boxes by host CPU model (`hostClasses`).

## Local runners

Configure `externalClaimer` on a project with `enabled`, `labels`, and `offerSeconds` (default 30; we use 60). A queued job is offered to your claimer for `offerSeconds` before the router plans a Boat box for it. The claimer reports capacity to `POST /router/local/capacity`. List the host names that may report in `localHosts` in `config/policy.mjs`.

## Two accounts as one pool

1. Add the second account file to `accounts` in `config/installation.mjs` (see `examples/account-secondary.json`) and set `secondaryAccount` in the primary account file to its id.
2. Set `ACCOUNT_CUTOVER=true` and `ACCOUNT_CUTOVER_POLICY` (JSON) with `ledgerKey` equal to `account:ledger:<primary id>`, `dayReserve`, `poolPacing` (`mode: "dynamic"`, `enabled: true`, `hardDayReserve`), and `forbidPaidStarts: true`.
3. Store `BOAT_WORK_API_KEY` (primary account key) as a secret and set `BOAT_SECONDARY_PROVIDER_WALLET`.
4. Set `ACCOUNT_POOL_POLICY` to `{"accounts":{"primary":{"enabled":true},"secondary":{"enabled":true}}}`. Set either flag to `false` to stop new starts on that account.

Each start goes to the enabled account that has the larger free share of its limits. Snapshots live in one account each: pin the secondary copies with `PROJECT_SNAPSHOT_NAME_SECONDARY`, `PROJECT_SNAPSHOT_MANIFEST_SHA256_SECONDARY`, `LEASE_BASE_SNAPSHOT_ID_SECONDARY` and `BROWSER_BASE_SNAPSHOT_ID_SECONDARY`. Without a secondary pin, a secondary box boots plain.

## Lease API

`EXTERNAL_LEASE_CLIENTS` (JSON) names each client: `{ "<name>": { "enabled": true, "project": "<project id>", "tokenHash": "<sha256 hex>", "maxActive": 4, "startsPerDay": null, "ttlSeconds": 900, "rollingSnapshot": false, "seededBase": false, "network": { "mode": "allow", "inbound": "boat-only", "allow": ["registry.npmjs.org"] } } }`; the installed file `config/peek/clients.json` supplies a client and the secret adds or replaces one. Rotate a token with `EXTERNAL_LEASE_TOKEN_HASHES` (`{ "<name>": "<sha256 hex>" }`). A client with `seededBase: true` may ask for a pinned base snapshot (`LEASE_BASE_SNAPSHOT_*` or `BROWSER_BASE_*` variables).

With `rollingSnapshot: true` (or `"rollingSnapshot": true` in a claim) the lease boots the newest ready `peek-ci-*` generation from `PROJECT_ROLLING_SNAPSHOT_NAME`'s account, and a claim waits as `snapshot_unavailable` when none is ready. Snapshot readiness follows the scan cycle: a complete scan counts for one cycle plus a 30 s grace, one minute when the router polls GitHub and fifteen minutes when repository webhooks carry the queue, so a webhook-mode lease is never refused between two scans. A pending claim answers `202` with a canonical `reason` (`pool_full`, `budget_exhausted`, `starting`, `pool_disabled`, `snapshot_unavailable`, `start_capacity`) and the specific string in `detail`; a held lease reads `lease_held` in `detail`.

The client sends `Authorization: Bearer <token>` and `X-Lease-Client: <name>` to `POST /router/lease/<action>`, where the action is `claim` (`size` `small`, `default` or `large`), `renew`, `execute`, `status`, `stream`, `file-write`, `file-read`, `cancel` or `release`. A file write waits up to 20 s for a running tick and returns 409 when it cannot get the write fence; retry it.

- **`cancel`** takes `{ "id": "<lease id>", "processId": <provider process id> }` and calls the provider's process delete, which kills the command and its children. Only the owning client's active lease may cancel, and `processId` must be a plain positive integer (or its decimal string); anything else is `400`. Success is `200 { "id", "processId", "cancelled": true }`; repeating the same cancel is `200 { "cancelled": false }`; an unknown lease or a `404` from the provider is `404 { "reason": "process_not_found" }`. Progress and output are read with `status` and `stream` as before.
- **`release`** deletes the box by default (a rolling `peek-runs` lease never returns to the warm pool). A body field `keepOnFailSeconds` (integer 1–900) holds it instead: the lease moves to `held`, the provider TTL is shortened to that bound, and the box is deleted at the bound and its spend settled then. `execute`, `file-read`, `stream` and `status` stay available for debugging; `renew` and every other action are refused, and the hold keeps counting against `maxActive` and the start's spend reservation. The response is `200 { "id", "heldUntil" }`. Any other `keepOnFailSeconds` value is `400`.
- **`network`** on a client is the provider network policy its leases are created with: `mode` is `allow`, `deny` or `open`; `allow` is at most 100 domains or CIDRs (a leading `*` is a wildcard); `inbound` may be `boat-only`, so nothing from the internet reaches the box while exec, files and stream still work through Boat. A malformed policy disables that client. The claim response names it as `network: { "mode", "inbound" }`. Clients without `network` (and every CI create) send no network field. A create that names a policy is a network change at the provider, so the key in `BOAT_CI_API_KEY` needs the `network.write` action; without it every client create is refused with `api_key_action_forbidden` and no lease can boot.
- **No tailnet, no secrets.** Every ordinary lease create keeps `noEnv: true`, and a lease boot fails when `/var/lib/tailscale/tailscaled.state` exists or a `tailscaled` process runs. The check reads no file content. The one exception is the opt-in `peek-dev` lease client (installed with `"tailnet": true`): the router mints one ephemeral, preauthorized, single-use `tag:boat-dev` key (300 s), delivers it in the box create's `TAILSCALE_AUTHKEY` environment, and deletes the Tailnet device and revokes the key when the lease ends. If that key has expired by the time the box is ready to join, the `execute` action mints a fresh single-use key, revokes the old one, and writes the new key to `/tmp/peek-dev-tailscale.key` for the dev-box join to read. Configure `TAILSCALE_OAUTH_CLIENT_ID` and `TAILSCALE_OAUTH_CLIENT_SECRET` (plus optional `TAILSCALE_TAILNET`, default `-`, and `TAILSCALE_API_URL`), rotate the client token through `EXTERNAL_LEASE_TOKEN_HASHES`, and check readiness with `POST /router/lease/dev-preflight`. The key never appears in a response, a log line or a setup script.

## Snapshot boot

Set `snapshotBoot: true` on a project and pin `PROJECT_SNAPSHOT_NAME` (`<name>-<yyyymmdd>-<hex>`) and `PROJECT_SNAPSHOT_MANIFEST_SHA256`. The snapshot must be one this router can verify: `src/snapshot-build.mjs` prints the build script a project's own setup runs on a primed box (`node src/snapshot-build.mjs`), which installs the plain-boot layout, caches the reset helper's OCI blobs and writes `/home/user/.boat-ci/toolchain.sha256`; the manifest hash is the SHA-256 of that file, and `PROJECT_SNAPSHOT_NAME`/`_MANIFEST_SHA256` are re-pinned together every time the snapshot is rebuilt. The helper waits for systemd and Docker before its first container run. If the helper fails, or the snapshot is missing, the box boots plain.

## Toolchain mirror

`src/bootstrap.mjs` installs a pinned git package, the Actions runner, PowerShell and ShellCheck, each with a SHA-256 check. Set `toolchainMirror` in `config/policy.mjs` to your own HTTPS mirror. Mirrored files fall back to the upstream release URL; git has no upstream fallback, so put `git/2.56.0/git_amd64.deb` on the mirror first. A deployment that hosts no mirror can call `bootstrap({ git: 'system' })` to keep the image's git; a snapshot boot never runs the bootstrap, and `src/snapshot-build.mjs` builds with that mode and then manifests whichever git the box resolves.

## Alerts

Account `alerts` sends webhook alerts for `starts_day`, `starts_hour`, `sandboxes`, `hours`, `day_cap_hit`, `queue_wait` and `breaker_open`. Each alert fires once when it crosses its threshold and once when it clears. `tools/credit-alert.mjs` is a module for an external watcher: give it Boat account samples (`creditBalanceHours`, `dailyStartsUsed`, `dailyStartsLimit`), a `send` function and a `save` function. It sends one message for each level (credit under 24 h, under 6 h, zero; day starts under 60 free, zero free), a reminder after 12 h, and one recovery message. An idle account at zero credit sends nothing.
