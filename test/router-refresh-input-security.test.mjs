import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REFRESH_PROGRAM, parseRefreshResult, refreshCommand, reuseBootstrap } from '../src/refresh.mjs';
import { bootstrap } from '../src/bootstrap.mjs';

function python(body) {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('reusable bootstrap fails when runner setup fails', () => {
  const result = spawnSync('/bin/bash', ['-c', reuseBootstrap().replace(bootstrap(), 'false')], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
});

test('Helper image identity accepts the captured manifest digest', () => {
  const output = python(String.raw`
config = 'sha256:a40c03cbb81c59bfb0e0887ab0b1859727075da7b9cc576a1cec2c771f38c5fb'
observed = 'sha256:59855d3dceb3ae53991193bd03301e082b2a7faa56a514b03527ae0ec2ce3a95'
print(json.dumps([helper_image_valid(observed, config), helper_image_valid(config, config), helper_image_valid('sha256:' + '0'*64, config)]))
`);
  assert.deepEqual(JSON.parse(output), [true, true, false]);
});

test('a forged generation result cannot skip refresh or hide cleanup failure', () => {
  const output = python(String.raw`
import tempfile, types
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    CONTROL = root / 'control'; CONTROL.mkdir()
    (STATE / 'baseline.json').write_text('{}')
    (STATE / 'ci-uids.json').write_text('[]')
    (STATE / 'images.json').write_text('[]')
    (STATE / 'cron.json').write_text('null')
    (STATE / 'path').write_text('/usr/bin')
    (STATE / 'current').write_text('3')
    (STATE / 'started-2').write_text('started')
    forged = {'ok': True, 'gen': 3, 'seconds': 0, 'failed': [], 'baselineHash': digest(b'{}[]/usr/bin')}
    (STATE / 'refresh-3.json').write_text(json.dumps(forged))
    calls = []
    stop_job = lambda: calls.append('stop')
    clear_ipc = lambda uid: None
    docker_reset = lambda allowed: calls.append('docker')
    fresh_job_filesystem = lambda: calls.append('filesystem')
    run = lambda *args, **kwargs: ''
    snapshot = lambda waiter: calls.append('snapshot') or {}
    def dirty(allowed):
        calls.append('check')
        raise RuntimeError('filesystem')
    assert_clean = dirty
    subprocess.run = lambda *args, **kwargs: types.SimpleNamespace(returncode=1)
    pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
    main('refresh', 3, os.getpid(), 'gone-helper')
    print(json.dumps({'calls': calls, 'result': json.loads((CONTROL / 'refresh-3.json').read_text())}))
`);
  const { calls, result } = JSON.parse(output);
  assert.deepEqual(calls, ['stop', 'docker', 'filesystem', 'snapshot', 'check']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failed, ['filesystem']);
  assert.equal(parseRefreshResult({ stdout: JSON.stringify(result) }, 3)?.ok, false);
});

function runnerAttempt(scenario) {
  return JSON.parse(python('\nRUNNER_CASE = ' + JSON.stringify(scenario) + '\n' + String.raw`
import io, tarfile, tempfile, types
from unittest.mock import patch
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    CONTROL = root / 'control'; CONTROL.mkdir()
    HOME = root / 'home/ci'; HOME.mkdir(parents=True)
    work = root / 'tmp/w'; work.mkdir(parents=True)
    cache = root / 'opt/hostedtoolcache'; cache.mkdir(parents=True)
    def make_archive(path, data):
        with tarfile.open(path, 'w:gz') as archive:
            entry = tarfile.TarInfo('run.sh'); entry.size = len(data); entry.mode = 0o755
            archive.addfile(entry, io.BytesIO(data))
    make_archive(CONTROL / 'runner.tar.gz', b'poisoned runner' if RUNNER_CASE == 'poisoned' else b'genuine runner')
    if RUNNER_CASE == 'replaced path':
        RUNNER_SHA256 = digest((CONTROL / 'runner.tar.gz').read_bytes())
        make_archive(CONTROL / 'replacement.tar.gz', b'poisoned runner')
    native_run = run
    def commands(args, allowed=(0,), **kwargs):
        if args[0] == 'tar':
            if RUNNER_CASE == 'replaced path':
                os.replace(CONTROL / 'replacement.tar.gz', CONTROL / 'runner.tar.gz')
            return native_run(args, allowed, **kwargs)
        return ''
    run = commands
    unmount_job = lambda: None
    wipe_temporary = lambda: None
    native_path = type(root)
    def paths(name):
        return {'/tmp/w': work, '/opt/hostedtoolcache': cache}.get(name, native_path(name))
    error = None
    with patch.object(pathlib, 'Path', paths), \
         patch.object(pwd, 'getpwnam', lambda name: types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())), \
         patch.object(shutil, 'disk_usage', lambda path: types.SimpleNamespace(free=8 * 1024**3)), \
         patch.object(shutil, 'copyfile', lambda *args: None), \
         patch.object(os, 'chown', lambda *args: None):
        try:
            fresh_job_filesystem()
        except RuntimeError as failure:
            error = str(failure)
    runner = HOME / 'runner/run.sh'
    print(json.dumps({'rejected': error == 'filesystem', 'runnerContents': runner.read_text() if runner.exists() else None}))
`));
}

test('a modified cached runner archive cannot populate the next generation', () => {
  assert.deepEqual(runnerAttempt('poisoned'), { rejected: true, runnerContents: null });
});

test('runner extraction uses the verified descriptor after its cache path is replaced', () => {
  assert.deepEqual(runnerAttempt('replaced path'), { rejected: false, runnerContents: 'genuine runner' });
});

const fixtureGenerator = String.raw`
import gzip, hashlib, io, json, pathlib, tarfile, sys
root = pathlib.Path(sys.argv[1])
scenario = sys.argv[2]
def archive(exported):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as stream:
        for name in ('bin', 'etc', 'dev', 'proc', 'sys') + (('dev/pts', 'dev/shm') if exported else ()):
            item = tarfile.TarInfo(name); item.type = tarfile.DIRTYPE; item.mode = 0o755
            stream.addfile(item)
        data = b'poisoned busybox' if exported and scenario == 'poisoned executable' else b'genuine busybox'
        item = tarfile.TarInfo('bin/busybox'); item.mode = 0o777 if exported and scenario == 'modified metadata' else 0o755; item.size = len(data)
        stream.addfile(item, io.BytesIO(data))
        if exported:
            for name in ('.dockerenv', 'etc/resolv.conf', 'etc/hosts', 'etc/hostname', 'dev/console'):
                data = b'malicious resolver config' if scenario == 'modified mountpoint' and name == 'etc/resolv.conf' else b''
                item = tarfile.TarInfo(name); item.mode = 0o755; item.size = len(data)
                stream.addfile(item, io.BytesIO(data))
            item = tarfile.TarInfo('etc/mtab'); item.type = tarfile.SYMTYPE; item.mode = 0o777; item.linkname = '/proc/mounts'
            stream.addfile(item)
            if scenario == 'unexpected file':
                item = tarfile.TarInfo('bin/extra'); item.mode = 0o755
                stream.addfile(item, io.BytesIO())
    return output.getvalue()
layer = gzip.compress(archive(False), mtime=0)
config = json.dumps({'architecture': 'amd64', 'os': 'linux', 'config': {'Env': ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']}}).encode()
descriptor = lambda data: {'digest': 'sha256:' + hashlib.sha256(data).hexdigest(), 'size': len(data)}
manifest = json.dumps({'schemaVersion': 2, 'config': descriptor(config), 'layers': [descriptor(layer)]}).encode()
(root / 'manifest').write_bytes(manifest)
(root / 'layer').write_bytes(layer)
(root / 'config').write_bytes(config)
(root / 'export').write_bytes(archive(True))
environment = ['PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin']
if scenario == 'poisoned environment':
    environment.append('LD_PRELOAD=/host/tmp/poison.so')
image = descriptor(manifest)['digest'] if scenario == 'manifest image' else descriptor(config)['digest']
(root / 'inspect').write_text(json.dumps([{'Image': image, 'State': {'Status': 'created'}, 'Config': {'Env': environment, 'Volumes': None, 'Healthcheck': {'Test': ['NONE']}}, 'Mounts': [{'Type': 'bind', 'Source': '/', 'Destination': '/host', 'RW': True}]}]))
if scenario == 'bad layer digest':
    (root / 'layer-response').write_bytes(b'changed registry layer')
`;

for (const scenario of ['poisoned executable', 'modified metadata', 'modified mountpoint', 'unexpected file', 'poisoned environment', 'bad layer digest', 'genuine', 'manifest image', 'offline genuine', 'offline bad layer', 'offline missing layer']) test(`the privileged helper checks ${scenario} before it can execute`, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'boat-helper-integrity-'));
  const binaries = join(directory, 'bin');
  const control = join(directory, 'control');
  await mkdir(binaries);
  await mkdir(control);
  const fixture = spawnSync('python3', ['-I', '-B', '-c', fixtureGenerator, directory, scenario], { encoding: 'utf8' });
  assert.equal(fixture.status, 0, fixture.stderr);
  if (scenario.startsWith('offline')) {
    const cache = join(control, 'helper-oci');
    await mkdir(cache);
    await writeFile(join(control, 'snapshot-mode'), '');
    for (const name of ['manifest', 'config', 'layer']) {
      const data = await readFile(join(directory, name));
      if (name === 'layer' && scenario === 'offline missing layer') continue;
      await writeFile(join(cache, createHash('sha256').update(data).digest('hex')), name === 'layer' && scenario === 'offline bad layer' ? 'tampered' : data);
    }
  }
  const docker = String.raw`#!/usr/bin/python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['TASK_TEST_ROOT'])
args = sys.argv[1:]
if args[0] in ('run', 'start'):
    (root / 'executed').write_text('privileged helper executed')
    (root / 'control/refresh-1.json').write_text(json.dumps({'ok': True, 'gen': 1, 'seconds': 1, 'failed': []}))
elif args[0] == 'export':
    sys.stdout.buffer.write((root / 'export').read_bytes())
elif args[0] == 'inspect':
    sys.stdout.write((root / 'inspect').read_text())
elif args[0] == 'create':
    print('fixture-container')
elif args[0] not in ('pull', 'rm'):
    sys.exit(1)
`;
  await writeFile(join(binaries, 'docker'), docker, { mode: 0o700 });
  await writeFile(join(binaries, 'flock'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  await writeFile(join(binaries, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n', { mode: 0o700 });
  await writeFile(join(binaries, 'sha256sum'), '#!/bin/sh\n/bin/cat >/dev/null\n', { mode: 0o700 });
  await writeFile(join(binaries, 'base64'), '#!/usr/bin/python3\nimport base64,sys\nsys.stdout.buffer.write(base64.b64decode(sys.stdin.buffer.read()))\n', { mode: 0o700 });
  const verifier = String.raw`#!/usr/bin/python3
import hashlib, io, json, os, pathlib, sys, urllib.request
root = pathlib.Path(os.environ['TASK_TEST_ROOT'])
source = pathlib.Path(sys.argv[-3]).read_text().split("if __name__ == '__main__':")[0]
namespace = {}
exec(source, namespace)
namespace['CONTROL'] = root / 'control'
namespace['HELPER_IMAGE_DIGEST'] = 'sha256:' + hashlib.sha256((root / 'manifest').read_bytes()).hexdigest()
def fetch(request, **kwargs):
    if (root / 'control/snapshot-mode').exists():
        raise AssertionError('unexpected network request')
    url = request.full_url if hasattr(request, 'full_url') else request
    if 'auth.docker.io' in url:
        return io.BytesIO(b'{"token":"fixture-token"}')
    if '/manifests/' in url:
        return io.BytesIO((root / 'manifest').read_bytes())
    for name in ('layer', 'config'):
        data = (root / name).read_bytes()
        if url.endswith('sha256:' + hashlib.sha256(data).hexdigest()):
            if name == 'layer' and (root / 'layer-response').exists():
                data = (root / 'layer-response').read_bytes()
            return io.BytesIO(data)
    raise AssertionError('unexpected registry object')
urllib.request.urlopen = fetch
namespace['verify_helper'](sys.argv[-1])
`;
  const verifierPath = join(binaries, 'verify-python');
  await writeFile(verifierPath, verifier, { mode: 0o700 });
  const script = refreshCommand('refresh', 1).replaceAll('/home/user/.boat-ci', control).replaceAll('/usr/bin/python3', verifierPath);
  const result = spawnSync('/bin/sh', ['-c', script], { encoding: 'utf8', timeout: 60000,
    env: { PATH: binaries + ':/usr/bin:/bin', TASK_TEST_ROOT: directory } });
  assert.equal(result.status, 0, result.stderr);
  const parsed = parseRefreshResult({ stdout: result.stdout }, 1);
  if (scenario === 'genuine' || scenario === 'manifest image' || scenario === 'offline genuine') {
    assert.equal(parsed?.ok, true);
    assert.equal(await readFile(join(directory, 'executed'), 'utf8'), 'privileged helper executed');
  } else {
    assert.equal(parsed?.ok, false);
    assert.deepEqual(parsed?.failed, ['command']);
    assert.equal(parsed?.diagnostic?.stage, 'helper_verify');
    await assert.rejects(readFile(join(directory, 'executed')), { code: 'ENOENT' });
  }
});

test('a retired box keeps the failing command message in its diagnostic', () => {
  const result = { ok: false, gen: 1, seconds: 1, failed: ['command'], diagnostic: { stage: 'docker_reset', exception: 'RuntimeError', operation: 'docker', exitCode: 1, output: 'Error response from daemon: remove peek: volume is in use' } };
  assert.equal(parseRefreshResult({ stdout: JSON.stringify(result) }, 1)?.diagnostic?.output, 'Error response from daemon: remove peek: volume is in use');
  // The message is one printable line of bounded length: a control character, a
  // second line or an oversized value refuses the whole result.
  for (const output of ['two\nlines', 'bell\u0007', 'x'.repeat(201), 7]) {
    const broken = { ...result, diagnostic: { ...result.diagnostic, output } };
    assert.equal(parseRefreshResult({ stdout: JSON.stringify(broken) }, 1), null, JSON.stringify(output));
  }
});

test('job paths come from the snapshot marker and stay under /home/user', () => python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    CONTROL = pathlib.Path(directory)
    assert job_paths() == []
    (CONTROL / 'job-paths').write_text('/home/user/ci\n\n/home/user/ci\n')
    assert job_paths() == ['/home/user/ci']
    for bad in ('/home/user/ci/../etc', '/etc', '/home/user/ci/', '/home/user/ci\n/tmp/w'):
        (CONTROL / 'job-paths').write_text(bad + '\n')
        try:
            job_paths()
        except RuntimeError as error:
            assert str(error) == 'filesystem', bad
        else:
            raise AssertionError(bad)
print('ok')
`));

test('the ownership scan leaves the job tree alone', () => python(String.raw`
CONTROL = pathlib.Path(tempfile.mkdtemp())
(CONTROL / 'job-paths').write_text('/home/user/ci\n')
seen = []
run = lambda args, *a, **kw: seen.append(args) or ''
mounts = lambda: []
pathlib.Path.is_dir = lambda self: True
assert_no_owned_files(1234)
root = [args for args in seen if args[1] == '/']
assert root and '/home/user/ci' in root[0], root
print('ok')
`));

test('starting a job hands the primed job tree to the ci user', () => python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    CONTROL = root / 'control'; CONTROL.mkdir()
    HOME = root / 'home'; HOME.mkdir()
    (STATE / 'current').write_text('1')
    (STATE / 'refresh-1.json').write_text(json.dumps({'ok': True, 'gen': 1}))
    (STATE / 'path').write_text('/usr/bin:/bin')
    (CONTROL / 'jit').write_text('jit')
    job = root / 'primed'; (job / 'peek').mkdir(parents=True); (job / 'peek' / 'a').write_text('x')
    chowns, commands = [], []
    def fake(args, allowed=(0,), stdin=None):
        commands.append(args)
        return 'not-found' if args[:2] == ['systemctl', 'show'] else ''
    run = fake
    job_paths = lambda: [str(job)]
    pwd.getpwnam = lambda name: type('U', (), {'pw_uid': 1001, 'pw_gid': 1001})()
    os.chown = lambda path, uid, gid: chowns.append((str(path), uid, gid))
    start_job(1, False)
    assert (['chown', '-R', 'ci:ci', str(job)] in commands), commands
    assert (str(HOME / '.jit'), 1001, 1001) in chowns, chowns
    assert any(args[:2] == ['systemd-run', '--quiet'] for args in commands), commands
print('ok')
`));

test('the docker clean check keeps the snapshot image keeper and names what is left', () => {
  const output = python(String.raw`
def fake(args, allowed=(0,), stdin=None):
    if args[:2] == ['docker', 'ps']:
        return 'keep1\n' if '--filter' in args else 'keep1\n'
    if args[:2] == ['docker', 'volume']:
        return ''
    if args[:2] == ['docker', 'network']:
        return 'bridge\nhost\nnone\n'
    if args[:2] == ['docker', 'inspect']:
        return ''
    return ''
run = fake
image_inventory = lambda: {'ids': ['a'], 'tags': []}
print(json.dumps([docker_problem({'ids': ['a'], 'tags': []}, {'keep1'}), docker_problem({'ids': ['a'], 'tags': []})]))
`);
  assert.deepEqual(JSON.parse(output), [null, 'containers=1']);
});

test('the baseline records an image inventory only once two observations agree', () => {
  const output = python(String.raw`
calls = []
readings = [{'ids': ['a'], 'tags': []}, {'ids': ['a', 'b'], 'tags': []}, {'ids': ['a', 'b'], 'tags': []}]
def inventory():
    calls.append(1)
    return readings[min(len(calls) - 1, len(readings) - 1)]
image_inventory = inventory
time.sleep = lambda seconds: None
print(json.dumps({'value': settle_images(), 'reads': len(calls)}))
`);
  assert.deepEqual(JSON.parse(output), { value: { ids: ['a', 'b'], tags: [] }, reads: 3 });
});

test('an image inventory that never settles fails the baseline as a docker fault', () => {
  const output = python(String.raw`
calls = []
def inventory():
    calls.append(1)
    return {'ids': ['a', str(len(calls))], 'tags': []}
image_inventory = inventory
time.sleep = lambda seconds: None
try:
    settle_images(attempts=3)
    print(json.dumps({'failed': False}))
except RuntimeError as error:
    print(json.dumps({'failed': True, 'kind': str(error), 'output': getattr(error, 'boat_output', None), 'reads': len(calls)}))
`);
  assert.deepEqual(JSON.parse(output), { failed: true, kind: 'docker', output: 'images', reads: 3 });
});

test('a snapshot box baselines without building the /home/ci layout', () => {
  const output = python(String.raw`
import tempfile, types
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    CONTROL = root / 'control'; CONTROL.mkdir()
    (CONTROL / 'snapshot-mode').write_text('')
    (CONTROL / 'reuse-path').write_text('/home/user/.local/bin:/usr/bin')
    calls = []
    settle_docker = lambda allowlist: calls.append(['settle', allowlist])
    image_inventory = lambda: {'ids': ['a'], 'tags': ['a postgres:17']}
    assert_clean = lambda allowlist: calls.append(['clean', allowlist])
    fresh_job_filesystem = lambda: calls.append('filesystem')
    stop_job = lambda: calls.append('stop')
    clear_ipc = lambda uids: calls.append('ipc')
    quiesce_packagekit = lambda: None
    quiesce_idle_reclaim = lambda: None
    quiesce_sysstat = lambda: None
    run = lambda *args, **kwargs: ''
    subprocess.run = lambda *args, **kwargs: types.SimpleNamespace(returncode=1)
    pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
    os.chown = lambda *args: None
    main('baseline', 0, os.getpid(), 'gone-helper')
    print(json.dumps({'calls': calls, 'baseline': json.loads((STATE / 'baseline.json').read_text()), 'uids': json.loads((STATE / 'ci-uids.json').read_text()), 'result': json.loads((CONTROL / 'baseline-0.json').read_text())}))
`);
  const value = JSON.parse(output);
  assert.deepEqual(value.calls, [['settle', null], ['settle', { ids: ['a'], tags: ['a postgres:17'] }], ['clean', { ids: ['a'], tags: ['a postgres:17'] }]]);
  assert.equal(value.baseline.version, 3);
  assert.equal(value.baseline.mode, 'snapshot');
  assert.deepEqual(value.uids, []);
  assert.equal(value.result.ok, true);
  assert.match(value.result.baselineHash, /^[a-f0-9]{64}$/);
});

test('a snapshot box starts its first job as the box user', () => {
  const output = python(String.raw`
import tempfile, types
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    CONTROL = root / 'control'; CONTROL.mkdir()
    (CONTROL / 'snapshot-mode').write_text('')
    (CONTROL / 'jit').write_text('{"encoded":"x"}')
    (STATE / 'current').write_text('0')
    (STATE / 'refresh-0.json').write_text(json.dumps({'ok': True, 'gen': 0, 'seconds': 0, 'failed': []}))
    commands = []
    def fake(args, allowed=(0,), stdin=None):
        commands.append(' '.join(args))
        return 'not-found'
    run = fake
    os.access = lambda *args: True
    os.chown = lambda *args: None
    pwd.getpwnam = lambda name: types.SimpleNamespace(pw_uid=1000, pw_gid=1000)
    start_job(0, False)
    print(json.dumps({'commands': commands, 'started': (STATE / 'started-0').exists()}))
`);
  const value = JSON.parse(output);
  assert.equal(value.started, true);
  const unit = value.commands.find(command => command.startsWith('systemd-run'));
  assert.match(unit, /--property=User=user --property=Group=user/);
  assert.match(unit, /bash \/home\/user\/boat-ci-start\.sh$/);
  assert.equal(value.commands.some(command => command.includes('/home/ci')), false);
});
