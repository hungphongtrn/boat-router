// The operator pins the immutable snapshot and its audited toolchain inputs.
export async function leaseBase(env) {
  const name=env.LEASE_BASE_SNAPSHOT_NAME, snapshotId=env.LEASE_BASE_SNAPSHOT_ID;
  const manifestSha256=env.LEASE_BASE_MANIFEST_SHA256, profileSha256=env.LEASE_BASE_PROFILE_SHA256;
  if (!/^lease-ci-\d{8}-[a-f0-9]{8,64}$/.test(name??'') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(snapshotId??'') || !/^[a-f0-9]{64}$/.test(manifestSha256??'') || !/^[a-f0-9]{64}$/.test(profileSha256??'')) return null;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify([name,snapshotId,manifestSha256,profileSha256])));
  const baseId=[...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('');
  return {base:'lease-v1',baseId,routerSnapshot:{kind:'lease-v1',name,snapshotId,manifestSha256,profileSha256}};
}
