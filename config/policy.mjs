// The Boat account this deployment starts boxes on, and the owner who may finish
// the setup flow. `wrangler.jsonc` sets `BOAT_WALLET=peek`, so the deployed Worker
// selects this account; the example entries below are the fixtures the upstream
// test suite runs on and keep it green on this fork.
export const defaultWallet = 'peek';
export const setupOwner = 'hungphongtrn';
export const repositories = ['hungphongtrn/peek', 'example-owner/project-a', 'example-owner/project-b', 'example-owner/project-c'];
export const smokeRepository = null;
export function installedPage(app, _env, page) {
  const base = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new/permissions`;
  return page(`<h1>Install Boat CI</h1><p>Choose the repositories that can use this router.</p><p><a href="${base}" target="_blank" rel="noopener noreferrer">Install the GitHub App</a>.</p>`);
}
// Base URL of your own checksum-pinned toolchain mirror (see docs/setup.md). The router
// downloads a pinned git package from here with no upstream fallback, so the mirror must
// serve `git/2.56.0/git_amd64.deb` with the SHA-256 in `src/bootstrap.mjs` before a box can
// boot. Runner, PowerShell, ShellCheck and Node fall back to their upstream release URLs.
export const toolchainMirror = 'https://toolchain.example.invalid';
// No local runners: nothing on the owner's Linux box claims a job, so the router plans a
// Boat box for every queued job. The hosts below are the upstream test fixtures.
export const localHosts = ['mini-1', 'mini-2'];
