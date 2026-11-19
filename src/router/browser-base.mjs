// Configuration is operator-owned; callers can select this name but cannot
// choose the provider image or its verification digests.
export async function browserBase(env) {
  const name = env.BROWSER_BASE_SNAPSHOT_NAME, snapshotId = env.BROWSER_BASE_SNAPSHOT_ID;
  const manifestSha256 = env.BROWSER_BASE_TOOLCHAIN_SHA256, browserManifestSha256 = env.BROWSER_BASE_FILES_SHA256;
  const profileSha256 = env.BROWSER_BASE_PROFILE_SHA256;
  if (!/^browser-ci-\d{8}-[a-f0-9]{8,64}$/.test(name ?? '') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(snapshotId ?? '') ||
      !/^[a-f0-9]{64}$/.test(manifestSha256 ?? '') || !/^[a-f0-9]{64}$/.test(browserManifestSha256 ?? '') || !/^[a-f0-9]{64}$/.test(profileSha256 ?? '')) return null;
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([name, snapshotId, manifestSha256, browserManifestSha256, profileSha256])));
  const baseId = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return { base: 'browser-v1', baseId, routerSnapshot: { kind: 'browser-v1', name, snapshotId, manifestSha256, browserManifestSha256, profileSha256 } };
}
