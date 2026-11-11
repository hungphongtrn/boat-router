import { createPrivateKey } from 'node:crypto';

// GitHub App credentials come from the Worker secrets GITHUB_APP_PRIVATE_KEY and
// GITHUB_WEBHOOK_SECRET only. The Durable Object record `github-app` written by the manifest
// flow supplies the App id and slug; its `pem` and `webhookSecret` fields are never read at
// runtime. After a manifest setup the operator
// runs `scripts/app-secrets-to-worker.mjs` (POST /setup/secrets-to-worker), and the next sweep
// strips the stored copy through `moveAppSecrets`.
export const APP_SECRET_NAMES = Object.freeze(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET']);

export function appCredentials(env, app) {
  const pem = typeof env?.GITHUB_APP_PRIVATE_KEY === 'string' && env.GITHUB_APP_PRIVATE_KEY ? env.GITHUB_APP_PRIVATE_KEY : undefined;
  const webhookSecret = typeof env?.GITHUB_WEBHOOK_SECRET === 'string' && env.GITHUB_WEBHOOK_SECRET ? env.GITHUB_WEBHOOK_SECRET : undefined;
  return { id: app?.id ?? env?.GITHUB_APP_ID, pem, webhookSecret, privateKeySource: pem === undefined ? null : 'secret', webhookSecretSource: webhookSecret === undefined ? null : 'secret' };
}

// Same RSA key material, independent of PEM framing or trailing whitespace.
export function samePrivateKey(a, b) {
  try {
    const der = value => createPrivateKey(value).export({ type: 'pkcs8', format: 'der' });
    const x = der(a), y = der(b);
    return x.length === y.length && x.equals(y);
  } catch { return false; }
}

// Strips the secret fields from the Durable Object record when the Worker secrets hold the same
// values. Returns 'moved', 'already', 'no_secrets' (Worker secrets absent), 'no_record',
// 'pem_mismatch' or 'webhook_secret_mismatch'. A mismatch leaves the record untouched.
export async function moveAppSecrets(storage, env, now = Date.now) {
  if (!env?.GITHUB_APP_PRIVATE_KEY || !env?.GITHUB_WEBHOOK_SECRET) return 'no_secrets';
  return storage.transaction(async tx => {
    const app = await tx.get('github-app');
    if (!app) return 'no_record';
    if (app.pem === undefined && app.webhookSecret === undefined) return 'already';
    if (app.pem !== undefined && !samePrivateKey(app.pem, env.GITHUB_APP_PRIVATE_KEY)) return 'pem_mismatch';
    if (app.webhookSecret !== undefined && app.webhookSecret !== env.GITHUB_WEBHOOK_SECRET) return 'webhook_secret_mismatch';
    const { pem, webhookSecret, ...rest } = app;
    await tx.put('github-app', { ...rest, secretsMovedAt: now() });
    return 'moved';
  });
}

// One-shot copy of the stored App credentials into this Worker's own secrets through the
// Cloudflare API, with a caller-supplied API token. The target is bound to this deployment:
// the script name and the workers.dev subdomain come from PUBLIC_ORIGIN, and the account must
// own that subdomain. Nothing from the record is returned or logged.
export async function pushAppSecrets({ storage, env, fetcher = fetch, cloudflareToken, accountId }) {
  if (!/^[A-Za-z0-9_-]{20,256}$/.test(cloudflareToken ?? '') || !/^[a-f0-9]{32}$/.test(accountId ?? '')) return { status: 400, error: 'invalid_request' };
  let origin;
  try { origin = new URL(env.PUBLIC_ORIGIN); } catch { return { status: 409, error: 'origin_unknown' }; }
  const match = /^([a-z0-9-]+)\.([a-z0-9-]+)\.workers\.dev$/.exec(origin.host);
  if (origin.protocol !== 'https:' || !match) return { status: 409, error: 'origin_not_workers_dev' };
  const [, script, subdomain] = match;
  const app = await storage.get('github-app');
  if (typeof app?.pem !== 'string' || typeof app?.webhookSecret !== 'string' || !/^\d{1,12}$/.test(app?.id ?? '')) return { status: 409, error: 'nothing_to_move' };
  const headers = { Authorization: `Bearer ${cloudflareToken}` };
  let owner;
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/subdomain`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10_000) });
    const data = await response.json();
    owner = response.ok && data?.success === true ? data.result?.subdomain : null;
  } catch { return { status: 502, error: 'cloudflare_unreachable' }; }
  if (owner !== subdomain) return { status: 403, error: 'account_not_origin_owner' };
  const secrets = Object.fromEntries([['GITHUB_APP_ID', app.id], ['GITHUB_APP_PRIVATE_KEY', app.pem], ['GITHUB_WEBHOOK_SECRET', app.webhookSecret]].map(([name, text]) => [name, { name, text, type: 'secret_text' }]));
  let ok = false;
  try {
    const response = await fetcher(`https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${script}/secrets-bulk`, {
      method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/merge-patch+json' }, body: JSON.stringify({ secrets }), redirect: 'manual', signal: AbortSignal.timeout(30_000),
    });
    const data = await response.json();
    ok = response.ok && data?.success === true;
  } catch { return { status: 502, error: 'cloudflare_unreachable' }; }
  if (!ok) return { status: 502, error: 'secret_write_failed' };
  return { status: 202, script, copied: [...APP_SECRET_NAMES] };
}
