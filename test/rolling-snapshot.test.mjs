import test from 'node:test';
import assert from 'node:assert/strict';
import { APIs } from '../src/apis.mjs';

const older = `peek-ci-${'a'.repeat(52)}`;
const newer = `peek-ci-${'a'.repeat(51)}q`;

test('a saving generation is invisible; ready generations can boot separate boxes without env or snapshots', async () => {
  const starts = [];
  const captures = [
    { name: newer, status: 'saving' },
    { name: older, status: 'ready', snapshotId: 'snapshot-1' },
  ];
  const api = new APIs({}, async (url, { body }) => {
    if (url.endsWith('/saved-snapshots?namePrefix=peek-ci-')) {
      return Response.json({ snapshots: captures });
    }
    assert.ok(url.endsWith('/sandboxes'));
    starts.push(JSON.parse(body));
    return Response.json({ sandbox: { id: `box-${starts.length}` } });
  });

  const first = await api.rollingSnapshot();
  assert.equal(first.snapshotId, 'snapshot-1');
  captures[0] = { name: newer, status: 'ready', snapshotId: 'snapshot-2' };
  const second = await api.rollingSnapshot();
  assert.equal(second.snapshotId, 'snapshot-2');
  await api.create({ createKey: 'first', routerSnapshot: first }, 600);
  await api.create({ createKey: 'second', routerSnapshot: second }, 600);
  assert.deepEqual(starts.map(start => start.from), [older, newer]);
  assert.match(starts[0].setupScript, new RegExp(`${'0'.repeat(64)}.*toolchain.sha256`));
  assert.match(starts[1].setupScript, new RegExp(`${'0'.repeat(63)}1.*toolchain.sha256`));
  for (const start of starts) {
    assert.equal(start.noEnv, true);
    assert.equal(start.snapshots, false);
    assert.deepEqual(start.env, {});
  }
  await api.create({ createKey: 'reuse', routerSnapshot: first, routerReusable: true }, 600);
  assert.equal(starts.length, 3);
  assert.equal(starts[2].from, older);
  assert.equal(starts[2].noEnv, true);
  assert.match(starts[2].setupScript, /reuse-path/);
});

test('a retained generation can be pinned exactly and an unready pin fails closed', async () => {
  const captures = [
    { name: newer, status: 'ready', snapshotId: 'snapshot-2' },
    { name: older, status: 'ready', snapshotId: 'snapshot-1' },
  ];
  const api = new APIs({}, async url => {
    assert.ok(url.endsWith('/saved-snapshots?namePrefix=peek-ci-'));
    return Response.json({ snapshots: captures });
  });

  assert.deepEqual(await api.rollingSnapshot(older), { name: older, manifestSha256: '0'.repeat(64), snapshotId: 'snapshot-1' });
  assert.equal(await api.rollingSnapshot(`peek-ci-${'b'.repeat(52)}`), null);
  captures[1] = { name: older, status: 'saving' };
  assert.equal(await api.rollingSnapshot(older), null);
});

test('a peek-ci lease boots the same generation and manifest check the CI path uses', async () => {
  const starts = [];
  const api = new APIs({}, async (url, { body }) => {
    if (url.endsWith('/saved-snapshots?namePrefix=peek-ci-')) return Response.json({ snapshots: [{ name: newer, status: 'ready', snapshotId: 'snapshot-2' }] });
    assert.ok(url.endsWith('/sandboxes'));
    starts.push(JSON.parse(body));
    return Response.json({ sandbox: { id: `box-${starts.length}` } });
  });
  const selected = await api.rollingSnapshot();
  await api.create({ createKey: 'lease', routerSnapshot: { kind: 'peek-ci', ...selected }, routerReusable: true }, 1800);
  assert.equal(starts[0].from, newer);
  assert.match(starts[0].setupScript, new RegExp(`${'0'.repeat(63)}1.*toolchain.sha256`));
  assert.equal(starts[0].noEnv, true);
  assert.throws(() => api.create({ createKey: 'mismatch', routerSnapshot: { kind: 'peek-ci', name: older, snapshotId: 'snapshot-1', manifestSha256: 'f'.repeat(64) }, routerReusable: true }, 1800), error => error.code === 'request_not_sent');
  assert.throws(() => api.create({ createKey: 'profile', routerSnapshot: { kind: 'peek-ci', ...selected, profileSha256: 'f'.repeat(64) }, routerReusable: true }, 1800), error => error.code === 'request_not_sent');
});
