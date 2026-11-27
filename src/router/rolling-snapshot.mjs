const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
const prefix = 'peek-ci-';

// Boat names are limited to 63 lowercase characters. Base32 preserves all 256
// manifest bits in the name, so discovery needs no second mutable pointer.
export function rollingSnapshotManifest(name) {
  if (!/^peek-ci-[a-z2-7]{51}[aq]$/.test(name ?? '')) return null;
  let bits = 0, buffer = 0, digest = '';
  for (const char of name.slice(prefix.length)) {
    buffer = (buffer << 5) | alphabet.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      digest += ((buffer >>> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return digest;
}

export function latestRollingSnapshot(snapshots) {
  // The provider lists newest first. A capture is published only when ready.
  for (const item of snapshots) {
    if (item?.status !== 'ready' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(item.snapshotId ?? '')) continue;
    const manifestSha256 = rollingSnapshotManifest(item.name);
    if (manifestSha256) return { name: item.name, manifestSha256, snapshotId: item.snapshotId };
  }
  return null;
}
