export const defaultWallet = 'example-account';
export const setupOwner = 'example-owner';
export const repositories = ['example-owner/project-a'];
export const smokeRepository = null;
export function installedPage(app, _env, page) {
  const base = `https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new/permissions`;
  return page(`<h1>Install Boat CI</h1><p>Choose the repositories that can use this router.</p><p><a href="${base}" target="_blank" rel="noopener noreferrer">Install the GitHub App</a>.</p>`);
}
