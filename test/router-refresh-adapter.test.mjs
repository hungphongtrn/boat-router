import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { APIs } from '../src/apis.mjs';
import { REFRESH_PROGRAM, refreshCommand } from '../src/refresh.mjs';

test('refresh baseline detects a changed socket inventory', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const result = spawnSync('python3', ['-I', '-B', '-c', `${source}\nprint(differences({'sockets': []}, {'sockets': [{'port': 8000}]}))`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "['sockets']");
  assert.doesNotThrow(() => refreshCommand('refresh', 60));
  assert.throws(() => refreshCommand('refresh', 61));
});

test('captured provider and Docker connections may change while listeners stay pinned', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const body = String.raw`
import copy
unix = {'identity': {'protocol':'unix', 'path':'/run/docker.sock'}, 'metadata': [{'flags':0,'state':3,'type':1}, {'flags':0,'state':3,'type':1}, {'flags':65536,'state':1,'type':1}]}
tcp = {'identity': {'protocol':'tcp4', 'port':8911}, 'metadata': [{'state':1,'uid':1000}]*5 + [{'state':10,'uid':1000}]}
before = [unix, tcp]
after = copy.deepcopy(before); after[0]['metadata'].pop(0); after[1]['metadata'].pop(0)
assert differences({'sockets':before}, {'sockets':after}) == []
after[1]['metadata'].append({'state':6,'uid':0})
assert differences({'sockets':before}, {'sockets':after}) == []
for change in ('listener uid', 'foreign connection', 'listener removed', 'other port', 'observed udp'):
    altered = copy.deepcopy(after)
    if change == 'listener uid': altered[1]['metadata'][-2]['uid'] = 1001
    if change == 'foreign connection': altered[1]['metadata'].append({'state':1,'uid':1001})
    if change == 'listener removed': altered[0]['metadata'] = [v for v in altered[0]['metadata'] if v['flags'] != 65536]
    if change == 'other port': altered.append({'identity':{'protocol':'tcp4','port':8888},'metadata':[{'state':10,'uid':1000}]})
    if change == 'observed udp': altered.append({'identity':{'protocol':'udp4','port':35143},'metadata':[]})
    assert differences({'sockets':before}, {'sockets':altered}) == ['sockets'], change
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('socket inventory keeps user listeners and ignores captured system and client sockets', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const body = String.raw`
import tempfile
with tempfile.TemporaryDirectory() as tmp:
    proc = pathlib.Path(tmp)
    (proc / 'net').mkdir()
    (proc / 'sys/net/ipv4').mkdir(parents=True)
    (proc / 'sys/net/ipv4/ip_local_port_range').write_text('32768 60999\n')
    defs = proc / 'login.defs'
    defs.write_text('UID_MIN 1000\nUID_MAX 60000\n')
    def row(port, peer, state, uid):
        return '0: 00000000:%04X %s %02X 0:0 0:0 0 %d 0 1\n' % (port, peer, state, uid)
    zero = '00000000:0000'
    (proc / 'net/tcp').write_text('header\n' + row(8911, zero, 10, 1000) + row(8911, '0100007F:1234', 1, 1000))
    (proc / 'net/udp').write_text('header\n' + row(49384, zero, 7, 114) + row(35143, zero, 7, 0) + row(53, zero, 7, 992) + row(68, zero, 7, 998) + row(5353, zero, 7, 114) + row(40000, zero, 7, 1000) + row(9000, '0100007F:1234', 1, 1000) + row(9001, zero, 7, 1000))
    entries = socket_inventory(proc, defs)
    assert entries == [
        {'identity': {'protocol':'tcp4', 'port':8911}, 'metadata':[{'state':10, 'uid':1000}]},
        {'identity': {'protocol':'udp4', 'port':9001}, 'metadata':[{'state':7, 'uid':1000}]},
    ], entries
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('refresh result requires a completed command with a valid generation and baseline', async () => {
  const api = new APIs({}), job = { machineId: 'bx_23456789' }, hash = 'a'.repeat(64);
  const output = JSON.stringify({ ok: true, gen: 1, seconds: 5, failed: [], baselineHash: hash });
  api.request = async () => ({ running: true });
  assert.equal(await api.refreshResult(job, 5, 1), null);
  api.request = async () => ({ running: false, stdout: output });
  assert.equal((await api.refreshResult(job, 5, 1)).ok, false);
  api.request = async () => ({ running: false, exitCode: 0, stdout: output });
  assert.equal((await api.refreshResult(job, 5, 1)).baselineHash, hash);
  assert.equal(await api.refreshResult(job, 5, 2), null);
});

test('CI listener inventory includes ephemeral UDP and excludes Boat and system sockets', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const body = String.raw`
import tempfile
with tempfile.TemporaryDirectory() as tmp:
    proc = pathlib.Path(tmp)
    (proc / 'net').mkdir(); (proc / 'sys/net/ipv4').mkdir(parents=True)
    (proc / 'sys/net/ipv4/ip_local_port_range').write_text('32768 60999\n')
    defs = proc / 'login.defs'; defs.write_text('UID_MIN 1000\nUID_MAX 60000\n')
    def row(port, state, uid):
        return '0: 00000000:%04X 00000000:0000 %02X 0:0 0:0 0 %d 0 1\n' % (port, state, uid)
    (proc / 'net/tcp').write_text('header\n' + row(8911, 10, 1000) + row(18955, 10, 1001))
    (proc / 'net/udp').write_text('header\n' + row(49384, 7, 114) + row(35143, 7, 1001))
    entries = socket_inventory(proc, defs, uid=1001)
    assert entries == [
      {'identity': {'protocol':'tcp4','port':18955}, 'metadata':[{'state':10,'uid':1001}]},
      {'identity': {'protocol':'udp4','port':35143}, 'metadata':[{'state':7,'uid':1001}]},
    ], entries
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('CI home drift is detected while system runtime files do not enter the snapshot', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const body = String.raw`
import tempfile, types
with tempfile.TemporaryDirectory() as tmp:
    root = pathlib.Path(tmp)
    HOME = root / 'home/ci'; HOME.mkdir(parents=True)
    (HOME / 'work').mkdir()
    (root / 'run/cups/certs').mkdir(parents=True)
    (root / 'run/cups/certs/0').write_text('before')
    before = {'files': tree_manifest(HOME)}
    (root / 'run/cups/certs/0').write_text('after')
    assert differences(before, {'files': tree_manifest(HOME)}) == []
    (HOME / 'work/job-file').write_text('job')
    assert differences(before, {'files': tree_manifest(HOME)}) == ['files']
    (HOME / 'work/job-file').unlink()
    (HOME / 'job-file').write_text('job')
    assert differences(before, {'files': tree_manifest(HOME)}) == ['files']
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('CI processes and their sessions are checked without counting the Boat command', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const body = String.raw`
import tempfile
with tempfile.TemporaryDirectory() as tmp:
    proc = pathlib.Path(tmp)
    uid = os.getuid()
    for pid, session in [('9796', '9796'), ('10014', '10014'), ('9797', '9796')]:
        directory = proc / pid; directory.mkdir()
        (directory / 'stat').write_text(pid + ' (bash) S 1 ' + session + ' ' + session + ' 0')
    processes = lambda ignored, proc: {
      '9796': ['1', uid, '/bin/bash', 'a'],
      '9797': ['2', uid + 1, '/bin/bash', 'b'],
      '10014': ['3', uid + 1, '/bin/bash', 'c'],
    }
    assert set(ci_processes(uid, set(), proc)) == {'9796', '9797'}
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
