export const defaultWallet = 'example-account';
export const setupOwner = 'example-owner';
export const repositories = ['example-owner/project-a', 'example-owner/project-b', 'example-owner/project-c'];
export const smokeRepository = null;
export function installedPage(app, _env, page) {
  const base = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new/permissions`;
  return page(`<h1>Install Boat CI</h1><p>Choose the repositories that can use this router.</p><p><a href="${base}" target="_blank" rel="noopener noreferrer">Install the GitHub App</a>.</p>`);
}
// Base URL of your own checksum-pinned toolchain mirror (see docs/setup.md). Mirrored downloads fall back to the
// upstream URL; git has no upstream fallback, so host it on the mirror before you enable starts.
export const toolchainMirror = 'https://toolchain.example.invalid';
// Names of the local runner hosts that may report capacity through /router/local/capacity.
export const localHosts = ['mini-1', 'mini-2'];
