import { rollingSnapshotManifest } from './rolling-snapshot.mjs';

const identifier = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const digest = /^[a-f0-9]{64}$/;

// A rolling lease pins one published CI disk exactly as the CI create path
// does. The immutable name encodes the manifest digest, so that digest is also
// the lease's base identity: two leases of one generation compare equal and a
// warm box is reused only inside it.
export function rollingLeaseSelection(selected) {
  if (!selected || !identifier.test(selected.snapshotId ?? '')) return null;
  const manifestSha256 = rollingSnapshotManifest(selected.name);
  if (!manifestSha256 || manifestSha256 !== selected.manifestSha256) return null;
  return {
    baseId: manifestSha256,
    rollingSnapshot: true,
    routerSnapshot: { kind: 'peek-ci', name: selected.name, snapshotId: selected.snapshotId, manifestSha256 },
  };
}

// The one selection shape ExternalLeaseStarts may spend a start on. A base
// kind keeps its own profile digests; a rolling generation carries none.
export function validLeaseSnapshot(selection) {
  if (!selection || typeof selection !== 'object') return false;
  if (!identifier.test(selection.snapshotId ?? '') || !digest.test(selection.manifestSha256 ?? '')) return false;
  if (selection.kind === 'peek-ci') return rollingSnapshotManifest(selection.name) === selection.manifestSha256;
  if (selection.kind === 'browser-v1') return /^browser-ci-\d{8}-[a-f0-9]{8,64}$/.test(selection.name ?? '') && digest.test(selection.browserManifestSha256 ?? '') && digest.test(selection.profileSha256 ?? '');
  if (selection.kind === 'lease-v1') return /^lease-ci-\d{8}-[a-f0-9]{8,64}$/.test(selection.name ?? '') && digest.test(selection.profileSha256 ?? '');
  return false;
}

// Discovery goes through the same provider call the CI create path uses, in the
// account the box will be created in. The operator pin is the exact name that
// must be ready; no ready generation yields null, which the claim reports as
// snapshot_unavailable instead of booting a plain box.
export async function leaseRollingSnapshot({ api, env, account = 'primary' }) {
  const suffix = account === 'secondary' ? '_SECONDARY' : '';
  const preferredName = env?.[`PROJECT_ROLLING_SNAPSHOT_NAME${suffix}`] || null;
  const resolved = typeof api?.forIdentity === 'function' ? await api.forIdentity({ account }) : api;
  if (typeof resolved?.rollingSnapshot !== 'function') return null;
  const selection = rollingLeaseSelection(await resolved.rollingSnapshot(preferredName));
  // The account is part of the lease identity: the generation was resolved in
  // this account, so the box must be created there too.
  return selection && { ...selection, account };
}
