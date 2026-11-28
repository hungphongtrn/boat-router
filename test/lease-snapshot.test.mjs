import test from 'node:test';
import assert from 'node:assert/strict';
import { leaseRollingSnapshot, rollingLeaseSelection, validLeaseSnapshot } from '../src/router/lease-snapshot.mjs';
import { rollingSnapshotManifest } from '../src/router/rolling-snapshot.mjs';

const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
// The immutable name is the manifest digest re-encoded in base32, so a test can
// name a generation from the digest it pins.
function rollingName(manifestSha256) {
  const value = BigInt(`0x${manifestSha256}`) << 4n;
  let encoded = '';
  for (let index = 51; index >= 0; index--) encoded += alphabet[Number((value >> BigInt(index * 5)) & 31n)];
  return `peek-ci-${encoded}`;
}

test('the name encodes its manifest and becomes the lease base identity', () => {
  for (const manifestSha256 of ['0'.repeat(64), '1'.repeat(64), 'a'.repeat(63) + 'b', 'deadbeef'.repeat(8)]) {
    const name = rollingName(manifestSha256);
    assert.equal(rollingSnapshotManifest(name), manifestSha256);
    assert.deepEqual(rollingLeaseSelection({ name, manifestSha256, snapshotId: 'snapshot-1' }), {
      baseId: manifestSha256,
      rollingSnapshot: true,
      routerSnapshot: { kind: 'peek-ci', name, snapshotId: 'snapshot-1', manifestSha256 },
    });
  }
});

test('a mismatched name, digest or snapshot id is never selected', () => {
  const manifestSha256 = '0'.repeat(64), name = rollingName(manifestSha256);
  assert.equal(rollingLeaseSelection({ name, manifestSha256: '1'.repeat(64), snapshotId: 'snapshot-1' }), null);
  assert.equal(rollingLeaseSelection({ name, manifestSha256, snapshotId: 'bad id' }), null);
  assert.equal(rollingLeaseSelection({ name: 'peek-ci-20260101-abcd', manifestSha256, snapshotId: 'snapshot-1' }), null);
  assert.equal(rollingLeaseSelection(null), null);
});

test('a stored peek-ci selection is valid only with the digest its name encodes', () => {
  const manifestSha256 = 'b'.repeat(64), name = rollingName(manifestSha256);
  const snapshot = { kind: 'peek-ci', name, snapshotId: 'snapshot-1', manifestSha256 };
  assert.equal(validLeaseSnapshot(snapshot), true);
  assert.equal(validLeaseSnapshot({ ...snapshot, manifestSha256: 'c'.repeat(64) }), false);
  assert.equal(validLeaseSnapshot({ ...snapshot, profileSha256: 'c'.repeat(64) }), true, 'profile digests are ignored for a rolling generation');
  assert.equal(validLeaseSnapshot({ ...snapshot, kind: 'lease-v1' }), false, 'a lease base needs its profile digest');
  assert.equal(validLeaseSnapshot({ kind: 'browser-v1', name: 'browser-ci-20260101-abcdef12', snapshotId: 's', manifestSha256, browserManifestSha256: 'c'.repeat(64), profileSha256: 'd'.repeat(64) }), true);
  assert.equal(validLeaseSnapshot(undefined), false);
});

test('discovery honours the exact pin and the box account', async () => {
  const manifestSha256 = 'e'.repeat(64), name = rollingName(manifestSha256);
  const seen = [];
  const api = {
    forIdentity: async identity => {
      seen.push(identity);
      return { rollingSnapshot: async preferred => { seen.push(preferred); return { name, manifestSha256, snapshotId: 'snapshot-2' }; } };
    },
  };
  const selection = await leaseRollingSnapshot({ api, env: { PROJECT_ROLLING_SNAPSHOT_NAME: name, PROJECT_ROLLING_SNAPSHOT_NAME_SECONDARY: 'other' }, account: 'secondary' });
  assert.deepEqual(seen, [{ account: 'secondary' }, 'other']);
  assert.equal(selection.routerSnapshot.kind, 'peek-ci');
  assert.equal(selection.routerSnapshot.snapshotId, 'snapshot-2');
  assert.equal(await leaseRollingSnapshot({ api: { rollingSnapshot: async () => null }, env: {}, account: 'primary' }), null);
  assert.equal(await leaseRollingSnapshot({ api: {}, env: {} }), null);
});
