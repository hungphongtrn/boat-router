import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REFRESH_PROGRAM } from '../src/refresh.mjs';
const python = body => {
  const result = spawnSync('python3', ['-I', '-B', '-c', REFRESH_PROGRAM.split("if __name__ == '__main__':")[0] + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
};
test('IPC matches both owner and creator across all previous ci UIDs', () => python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as d:
 root = pathlib.Path(d)
 for kind in ('shm', 'sem', 'msg'):
  (root / kind).write_text('key id perms uid gid cuid cgid\n1 123 666 65534 65534 1001 1001\n2 124 666 1002 1002 0 0\n3 125 666 0 0 0 0\n')
 assert ipc_objects([1001,1002], root) == [(k,i) for k in ('shm','sem','msg') for i in (123,124)]
 calls=[]; run=lambda args,*a,**kw: calls.append(args) or ''
 q=root/'queue';q.mkdir();clear_ipc([1001,1002],root,q)
 assert len(calls)==6
`));
test('UID allocation advances and persists reserved IDs, including after a failed create', () => python(String.raw`
import tempfile, types
with tempfile.TemporaryDirectory() as d:
 STATE=pathlib.Path(d)
 pwd.getpwnam=lambda name: types.SimpleNamespace(pw_uid=1001)
 def lookup(uid):
  if uid in (1001,1002): return types.SimpleNamespace(pw_uid=uid)
  raise KeyError(uid)
 pwd.getpwuid=lookup
 assert reserve_ci_uid()==1003
 assert reserve_ci_uid()==1004
 assert ci_uids()==[1001,1003,1004]
`));
test('home manifest normalizes the ci identity without hiding other ownership', () => python(String.raw`
a={'a':[1,448,1001,1001],'b':[1,448,0,0]}
b={'a':[1,448,1002,1002],'b':[1,448,0,0]}
assert normalize_ci_ownership(a,1001,1001)==normalize_ci_ownership(b,1002,1002)
b['b'][2]=1002
assert normalize_ci_ownership(a,1001,1001)!=normalize_ci_ownership(b,1002,1002)
`));
test('each recreated ci account receives a new UID', () => python(String.raw`
import tempfile, types
from unittest.mock import patch
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d); STATE=root/'state';STATE.mkdir(); HOME=root/'ci'
 work=root/'work'; cache=root/'cache'
 actual_path=type(root)
 def paths(name): return {'/tmp/w':work,'/opt/hostedtoolcache':cache}.get(str(name),actual_path(name))
 current=[1001]; chosen=[]
 def getuser(name):
  if current[0] is None: raise KeyError(name)
  return types.SimpleNamespace(pw_uid=current[0],pw_gid=1001)
 def getuid(uid):
  if uid==current[0]: return getuser('ci')
  raise KeyError(uid)
 def command(args,*a,**kw):
  if args[0]=='userdel': current[0]=None
  if args[0]=='useradd':
   current[0]=int(args[args.index('--uid')+1]); chosen.append(current[0]); raise RuntimeError('stop_after_useradd')
  return ''
 run=command; unmount_job=lambda:None
 with patch.object(pathlib,'Path',paths), patch.object(pwd,'getpwnam',getuser), patch.object(pwd,'getpwuid',getuid), patch.object(shutil,'disk_usage',lambda p:types.SimpleNamespace(free=8*1024**3)):
  for _ in range(2):
   try: fresh_job_filesystem()
   except RuntimeError as e: assert str(e)=='stop_after_useradd'
 assert chosen==[1002,1003]
`));
