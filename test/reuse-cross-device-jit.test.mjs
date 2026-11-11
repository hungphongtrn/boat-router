import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REFRESH_PROGRAM } from '../src/refresh.mjs';

test('JIT transfer stages on the destination filesystem and removes the source', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const python = `
import tempfile, pathlib, os, errno
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    control, home = root / 'control', root / 'home'
    control.mkdir(); home.mkdir()
    source, destination = control / 'jit', home / '.jit'
    source.write_bytes(b'synthetic-jit')
    original = os.replace
    def replace(a, b):
        if pathlib.Path(a).parent != pathlib.Path(b).parent:
            raise OSError(errno.EXDEV, 'cross-device')
        return original(a, b)
    os.replace = replace
    transfer_jit(source, destination)
    assert destination.read_bytes() == b'synthetic-jit'
    assert destination.stat().st_mode & 0o777 == 0o600
    assert not source.exists()
    assert list(home.iterdir()) == [destination]
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + python], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('a failed JIT copy preserves the source and removes its temporary file', () => {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const python = `
import tempfile, pathlib, shutil
with tempfile.TemporaryDirectory() as root:
    root = pathlib.Path(root)
    control, home = root / 'control', root / 'home'
    control.mkdir(); home.mkdir()
    source, destination = control / 'jit', home / '.jit'
    source.write_bytes(b'synthetic-jit')
    def fail(*args): raise OSError('copy failed')
    shutil.copyfileobj = fail
    try: transfer_jit(source, destination)
    except OSError: pass
    else: raise AssertionError('expected failure')
    assert source.read_bytes() == b'synthetic-jit'
    assert not destination.exists()
    assert list(home.iterdir()) == []
`;
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + python], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
