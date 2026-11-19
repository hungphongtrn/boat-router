import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REFRESH_PROGRAM } from '../src/refresh.mjs';
function python(body) {
  const result = spawnSync('python3', ['-I', '-B', '-c', REFRESH_PROGRAM.split("if __name__ == '__main__':")[0] + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}
test('IPC cleanup removes ci objects and queues and verification rejects leaks', () => python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    for kind in ('shm', 'sem', 'msg'):
        (root / kind).write_text('key id perms uid gid cuid cgid\n0 123 600 1001 1001 1001 1001\n0 124 600 0 0 0 0\n')
    queue = root / 'mqueue'; queue.mkdir(); (queue / 'job').write_text('')
    calls = []
    run = lambda args, *a, **kw: calls.append(args) or ''
    assert ipc_objects(1001, root) == [('shm', 123), ('sem', 123), ('msg', 123)]
    clear_ipc(1001, root, queue)
    assert len(calls) == 3 and not list(queue.iterdir())
`));
test('host ownership check fails for a ci-owned file outside home', () => python(String.raw`
run = lambda args, *a, **kw: '/var/tmp/leak'
mounts = lambda: []
try:
    assert_no_owned_files(1234)
except RuntimeError as error:
    assert str(error) == 'filesystem'
else:
    raise AssertionError('leak passed')
`));
test('cron restore skips absent crontab', () => python(String.raw`
shutil.which = lambda name: None
run = lambda *a, **kw: (_ for _ in ()).throw(AssertionError('called crontab'))
restore_cron(None)
`));
test('docker image verification rejects an extra tag for an allowed ID', () => python(String.raw`
run = lambda args, *a, **kw: 'sha256:abc node:20'
try:
    assert_images({'ids': ['sha256:abc'], 'tags': ['sha256:abc alpine:latest']})
except RuntimeError as error:
    assert str(error) == 'docker'
else:
    raise AssertionError('extra tag passed')
`));
test('ownership scan covers the separate run filesystem', () => python(String.raw`
seen = []
def fake(args, *a, **kw):
    seen.append(args[1])
    return '/run/lock/leak' if args[1] == '/run' else ''
run = fake
mounts = lambda: []
pathlib.Path.is_dir = lambda self: True
try:
    assert_no_owned_files(1234)
except RuntimeError as error:
    assert str(error) == 'filesystem' and '/run' in seen
else:
    raise AssertionError('run mount leak passed')
`));

test('ownership scan covers a nested writable mount', () => python(String.raw`
seen = []
pathlib.Path.is_dir = lambda self: True
def fake(args, *a, **kw):
    seen.append(args[1])
    return '/run/lock/leak' if args[1] == '/run/lock' else ''
run = fake
try:
    assert_no_owned_files(1234)
except RuntimeError as error:
    assert str(error) == 'filesystem' and '/run/lock' in seen
else:
    raise AssertionError('nested mount leak passed')
`));
