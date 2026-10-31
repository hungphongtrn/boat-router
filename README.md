# Boat router

This experimental router controls starts for Boat GitHub runners. The router is opt-in and is not production-ready. It has limited operational validation, and resets can fail or require operator recovery. It queues workflow jobs and controls when they start. It can reuse a runner machine after a light reset, pace new starts against account limits, and share capacity fairly between configured projects.

Boat also supports native GitHub jobs with `runs-on: boat`. Use that path when its native scheduling and lifecycle fit your workload. This router adds an independently operated Cloudflare Worker and Durable Object for installations that need its pacing, fairness, reuse, and operator controls. Reuse requires an explicit project policy and a successful reset.

The Worker receives signed GitHub webhooks. The Durable Object keeps admission and pool state, coordinates starts, and exposes authenticated operator routes. An optional external claimer can accept eligible jobs through the local claim protocol. Credentials and installation data stay in the deployment configuration.

See [setup](docs/setup.md) for configuration and verification. The example configuration starts with machine creation disabled. Run `npm test`, `npm run check`, and `npm run build` with Node 22 or later.

The Durable Object uses the fixed name `production-v1`. Changing it starts a separate state store.
