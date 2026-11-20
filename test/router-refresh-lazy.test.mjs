// The lazy-disk hydration race (Gap 2, 2026-11-20). A snapshot box serves its
// saved disk through the provider's lazy layer at /var/lib/ascii-lazy and copies
// each entry up on its first read. A job that starts before the primed tree
// settles can resolve a path into the layer's retired copy: on 2026-11-20
// nextest read its package graph from /var/lib/ascii-lazy/retired instead of
// /home/user/ci/peek and failed a module that passed on the next box. The
// baseline and the first job now walk the job tree's metadata and wait, bounded,
// until no job path resolves into the layer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REFRESH_PROGRAM } from '../src/refresh.mjs';

function python(body) {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

// A temporary tree, a temporary layer root, and a fake clock so a bounded wait
// is proven without spending its wall time.
const fixtures = String.raw`
import tempfile
class Clock:
    def __init__(self):
        self.value = 100.0
        self.sleeps = 0
        self.on_sleep = None
    def monotonic(self):
        return self.value
    def sleep(self, seconds):
        assert seconds == 0.25
        self.sleeps += 1
        self.value += seconds
        if self.on_sleep:
            self.on_sleep(self.sleeps)
def tree(root, count=3):
    for index in range(count):
        directory = root / ('d' + str(index))
        directory.mkdir(parents=True)
        (directory / 'file').write_text('x')
    return root
`;

test('a box without the lazy layer settles instantly', () => {
  python(fixtures + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    layer = root / 'missing-layer'
    assert not layer.exists()
    assert settle_lazy_disk(paths=[str(tree(root / 'job'))], seconds=30, root=layer) == 0.0
`);
});

test('a settled job tree costs a metadata walk and no wait', () => {
  python(fixtures + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    layer = root / 'layer'; layer.mkdir()
    job = tree(root / 'job')
    clock = Clock(); time.monotonic = clock.monotonic; time.sleep = clock.sleep
    seconds = settle_lazy_disk(paths=[str(job)], seconds=30, root=layer)
    assert 0.0 <= seconds <= 1.0, seconds
    assert clock.sleeps == 0, clock.sleeps
`);
});

test('a path still resolving into the layer is waited on until it settles', () => {
  python(fixtures + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    layer = root / 'layer'; (layer / 'retired' / 'ci').mkdir(parents=True)
    (layer / 'retired' / 'ci' / 'peek').mkdir()
    job = root / 'job'; job.mkdir()
    link = job / 'peek'
    link.symlink_to(layer / 'retired' / 'ci' / 'peek')
    clock = Clock(); time.monotonic = clock.monotonic; time.sleep = clock.sleep
    clock.on_sleep = lambda count: link.unlink() if count == 2 else None
    seconds = settle_lazy_disk(paths=[str(link)], seconds=30, root=layer)
    assert clock.sleeps == 2, clock.sleeps
    assert 0.4 <= seconds <= 0.6, seconds
    assert lazy_pending([str(link)], layer) is False
`);
});

test('the wait is bounded even when the layer never settles', () => {
  python(fixtures + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    layer = root / 'layer'; (layer / 'retired').mkdir(parents=True)
    job = root / 'job'; job.mkdir()
    link = job / 'peek'
    link.symlink_to(layer / 'retired')
    clock = Clock(); time.monotonic = clock.monotonic; time.sleep = clock.sleep
    seconds = settle_lazy_disk(paths=[str(link)], seconds=1.0, root=layer)
    assert 1.0 <= seconds <= 1.3, seconds
    assert clock.sleeps == 4, clock.sleeps
    assert lazy_pending([str(link)], layer) is True
`);
});

test('the metadata walk stops at its entry limit', () => {
  python(fixtures + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    layer = root / 'layer'; layer.mkdir()
    job = tree(root / 'job', 40)
    clock = Clock(); time.monotonic = clock.monotonic; time.sleep = clock.sleep
    # Every directory is entered once, and the walk stops once the cap is met.
    settle_lazy_disk(paths=[str(job)], seconds=30, limit=5, root=layer)
    assert clock.sleeps == 0
`);
});

test('lazy_pending reads a resolved path and tolerates a missing one', () => {
  python(fixtures + String.raw`
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    layer = root / 'layer'; (layer / 'retired').mkdir(parents=True)
    outside = root / 'outside'; outside.mkdir()
    assert lazy_pending([str(layer / 'retired')], layer) is True
    assert lazy_pending([str(outside)], layer) is False
    assert lazy_pending([str(root / 'missing')], layer) is False
    assert lazy_pending([], layer) is False
`);
});

test('the baseline and the first job both settle the layer before the tree is used', () => {
  const source = REFRESH_PROGRAM;
  assert.match(source, /def settle_lazy_disk\(/);
  assert.match(source, /result\['lazySettleSeconds'\] = settle_lazy_disk\(seconds=LAZY_SETTLE_SECONDS\)/);
  assert.match(source, /seconds = settle_lazy_disk\(seconds=LAZY_START_SETTLE_SECONDS\)/);
  assert.match(source, /result\['lazySettleSeconds'\] = start_job\(generation, docker_access\)/);
  const constant = name => Number(new RegExp('^' + name + ' = (\\d+)$', 'm').exec(source)?.[1]);
  const settle = constant('LAZY_SETTLE_SECONDS'), start = constant('LAZY_START_SETTLE_SECONDS'), limit = constant('LAZY_ENTRY_LIMIT');
  assert.equal(settle, 30);
  assert.equal(start, 15);
  assert.equal(limit, 20000);
  // The controller's RuntimeMaxSec is 285 s: the settle plus the baseline work
  // has to stay well inside it.
  assert.ok(settle + start + 60 < 285, settle + start);
});
