import { createHash } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { bootstrap, RELEASES } from './bootstrap.mjs';
import { REFRESH_HELPER_IMAGE } from './router/reset-constants.mjs';
export { REFRESH_HELPER_IMAGE } from './router/reset-constants.mjs';

const RUNNER_PERMISSION_CHECK = `setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all python3 - <<'PERMISSIONS'
import os
from pathlib import Path
import tempfile
if os.geteuid() == 0:
    raise SystemExit('Runner requires a non-root user')
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines())
if any(int(status[name].strip(), 16) for name in ('CapEff', 'CapAmb')):
    raise SystemExit('Runner requires empty effective and ambient capabilities')
with tempfile.TemporaryDirectory(prefix='boat-permissions-', dir='/tmp/w') as directory:
    probe = Path(directory) / 'unreadable'
    probe.write_bytes(b'probe')
    probe.chmod(0)
    try:
        try:
            probe.read_bytes()
        except PermissionError:
            pass
        else:
            raise SystemExit('Runner requires chmod-000 read denial')
    finally:
        probe.chmod(0o600)
PERMISSIONS`;

export const REFRESH_RESULT_MAX_BYTES = 65536;
export const REFRESH_DRIFT_ARTIFACT_MAX_BYTES = 4 * 1024 * 1024;

export const REFRESH_PROGRAM = String.raw`import fcntl, hashlib, io, json, os, pathlib, pwd, re, resource, select, shutil, signal, stat, subprocess, sys, tarfile, tempfile, time, urllib.request

STATE = pathlib.Path('/var/lib/boat-ci-reuse')
CONTROL = pathlib.Path('/home/user/.boat-ci')
HOME = pathlib.Path('/home/ci')
RUNNER_SHA256 = '${RELEASES.runner.sha256}'
HELPER_IMAGE_DIGEST = '${REFRESH_HELPER_IMAGE.split('@')[1]}'
OPAQUE_PATHS = (
    '/proc', '/sys', '/dev/pts',
    '/home/user/.boat-ci', '/home/user/.ascii', '/var/lib/boat-ci-reuse',
    '/tmp/w', '/opt/hostedtoolcache',
    '/var/lib/docker', '/var/lib/containerd', '/run/docker', '/run/containerd', '/run/runc',
    '/var/log/journal', '/var/log/private', '/run/log/journal',
    '/run/systemd/units', '/run/systemd/journal', '/run/systemd/propagate',
    '/run/systemd/sessions', '/run/systemd/seats', '/run/systemd/users',
    '/run/systemd/machines', '/run/systemd/netif', '/run/systemd/timesync',
    '/run/udev/data', '/run/udev/links', '/run/udev/tags',
    '/var/lib/systemd/random-seed',
)
SYSTEM_LOGS = (
    'alternatives.log', 'apport.log', 'auth.log', 'bootstrap.log', 'btmp',
    'cloud-init.log', 'cloud-init-output.log', 'daemon.log', 'debug', 'dmesg',
    'dpkg.log', 'faillog', 'fontconfig.log', 'kern.log', 'lastlog', 'mail.err',
    'mail.info', 'mail.log', 'mail.warn', 'messages', 'syslog', 'user.log', 'wtmp',
    'apt/history.log', 'apt/term.log',
)
CONTROL_UNIT = re.compile(r'/run/systemd/transient/boat-ci-(?:job-\d+|refresh-(?:baseline|refresh|check|start)-\d+-\d+)\.service(?:\.d(?:/.*)?)?')
SYSTEM_LOG = re.compile(r'/var/log/(?:' + '|'.join(re.escape(name) for name in SYSTEM_LOGS) + r')(?:\.\d+)?(?:\.gz)?')
STAGE = 'initialize'
OPERATIONS = ('docker', 'systemctl', 'systemd-run', 'pkill', 'umount', 'userdel', 'groupdel', 'mkfs.ext4', 'mount', 'useradd', 'chage', 'tar', 'chown', 'dpkg-query', 'dpkg', 'sysctl', 'ip', 'iptables-save')
EXCEPTIONS = ('FileNotFoundError', 'PermissionError', 'IsADirectoryError', 'NotADirectoryError', 'OSError', 'TimeoutError', 'TimeoutExpired', 'RuntimeError', 'KeyError', 'ValueError', 'TypeError', 'JSONDecodeError', 'UnicodeDecodeError', 'OverflowError', 'MemoryError', 'ProcessLookupError', 'FileExistsError', 'BrokenPipeError')
RESULT_MAX_BYTES = ${REFRESH_RESULT_MAX_BYTES}
DRIFT_ARTIFACT_MAX_BYTES = ${REFRESH_DRIFT_ARTIFACT_MAX_BYTES}
NETWORK_FIELDS = frozenset(('ifindex', 'ifname', 'flags', 'mtu', 'qdisc', 'operstate', 'group', 'txqlen', 'link_type', 'address', 'broadcast', 'addr_info', 'family', 'local', 'prefixlen', 'scope', 'label', 'valid_life_time', 'preferred_life_time', 'dst', 'dev', 'protocol', 'prefsrc', 'gateway', 'metric', 'table', 'type', 'tos', 'onlink', 'uid', 'cache', 'expires', 'nhid', 'multipath', 'pref', 'src', 'master', 'link_index', 'link_netnsid', 'altnames', 'linkinfo'))
PROCESS_NAMES = {}

def set_stage(name):
    global STAGE
    STAGE = name

def diagnostic(error):
    name = getattr(error, 'boat_exception', type(error).__name__)
    value = {'stage': STAGE, 'exception': name if name in EXCEPTIONS else 'Exception'}
    number = getattr(error, 'errno', None)
    if type(number) is int and 0 <= number <= 4095:
        value['errno'] = number
    operation = getattr(error, 'boat_operation', None)
    if operation in OPERATIONS or operation == 'other':
        value['operation'] = operation
    code = getattr(error, 'boat_exit_code', None)
    if type(code) is int and -255 <= code <= 255:
        value['exitCode'] = code
    return value

def run(args, allowed=(0,), stdin=None):
    try:
        result = subprocess.run(args, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=120)
        if result.returncode not in allowed:
            error = RuntimeError('command')
            error.boat_exit_code = result.returncode
            raise error
    except Exception as error:
        error.boat_operation = args[0] if args[0] in OPERATIONS else 'other'
        raise
    return result.stdout.decode('utf-8', errors='replace').strip()

def digest(data):
    return hashlib.sha256(data).hexdigest()

def helper_archive(data):
    result = {}
    size = 0
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:*') as archive:
        for item in archive:
            name = item.name.removeprefix('./').rstrip('/')
            if name == '.':
                name = ''
            if name.startswith('/') or '..' in name.split('/') or name in result or len(result) >= 10000:
                raise RuntimeError('helper')
            size += item.size
            if size > 64 * 1024 * 1024 or not (item.isfile() or item.isdir() or item.issym()):
                raise RuntimeError('helper')
            metadata = {key: value for key, value in item.pax_headers.items() if key not in ('mtime', 'atime', 'ctime', 'path', 'linkpath', 'uid', 'gid', 'uname', 'gname', 'size')}
            value = [item.type.decode('ascii'), item.mode, item.uid, item.gid, metadata]
            if item.isfile():
                value.append(digest(archive.extractfile(item).read()))
            elif item.issym():
                value.append(item.linkname)
            result[name] = value
    return result

def helper_image_valid(actual, config_digest):
    return actual in (config_digest, HELPER_IMAGE_DIGEST)

def verify_helper(container):
    with urllib.request.urlopen('https://auth.docker.io/token?service=registry.docker.io&scope=repository:library/alpine:pull', timeout=20) as response:
        token = json.loads(response.read(65537))['token']
    if not isinstance(token, str) or not 1 <= len(token) <= 16384 or any(character.isspace() for character in token):
        raise RuntimeError('helper')
    def fetch(path, expected, size=None):
        if re.fullmatch(r'sha256:[a-f0-9]{64}', expected) is None or (size is not None and (type(size) is not int or not 1 <= size <= 8 * 1024 * 1024)):
            raise RuntimeError('helper')
        request = urllib.request.Request('https://registry-1.docker.io/v2/library/alpine/' + path, headers={'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json'})
        with urllib.request.urlopen(request, timeout=20) as response:
            data = response.read((size if size is not None else 65536) + 1)
        if 'sha256:' + digest(data) != expected or (size is not None and len(data) != size):
            raise RuntimeError('helper')
        return data
    manifest = json.loads(fetch('manifests/' + HELPER_IMAGE_DIGEST, HELPER_IMAGE_DIGEST))
    if manifest.get('schemaVersion') != 2 or len(manifest.get('layers', [])) != 1:
        raise RuntimeError('helper')
    descriptor = manifest['config']
    config = json.loads(fetch('blobs/' + descriptor['digest'], descriptor['digest'], descriptor['size']))
    if config.get('architecture') != 'amd64' or config.get('os') != 'linux':
        raise RuntimeError('helper')
    layer = manifest['layers'][0]
    expected = helper_archive(fetch('blobs/' + layer['digest'], layer['digest'], layer['size']))
    inspected = json.loads(run(['docker', 'inspect', '--type=container', container]))
    if not isinstance(inspected, list) or len(inspected) != 1:
        raise RuntimeError('helper')
    actual = inspected[0]
    settings = actual.get('Config', {})
    mounted = actual.get('Mounts', [])
    if actual.get('State', {}).get('Status') != 'created' or not helper_image_valid(actual.get('Image'), descriptor['digest']) or settings.get('Env') != config.get('config', {}).get('Env') or settings.get('Volumes') not in (None, {}) or settings.get('Healthcheck', {}).get('Test') != ['NONE']:
        raise RuntimeError('helper')
    if len(mounted) != 1 or any(mounted[0].get(key) != value for key, value in {'Type': 'bind', 'Source': '/', 'Destination': '/host', 'RW': True}.items()):
        raise RuntimeError('helper')
    with tempfile.TemporaryFile() as output:
        exported = subprocess.run(['docker', 'export', container], stdout=output, stderr=subprocess.DEVNULL, timeout=30,
            preexec_fn=lambda: resource.setrlimit(resource.RLIMIT_FSIZE, (64 * 1024 * 1024, 64 * 1024 * 1024)))
        if exported.returncode != 0:
            raise RuntimeError('helper')
        output.seek(0)
        observed = helper_archive(output.read(64 * 1024 * 1024 + 1))
    # Docker's init layer replaces these exact mountpoints before any container code runs.
    for name in ('dev/pts', 'dev/shm', 'proc', 'sys'):
        expected[name] = ['5', 0o755, 0, 0, {}]
    for name in ('.dockerenv', 'etc/resolv.conf', 'etc/hosts', 'etc/hostname', 'dev/console'):
        expected[name] = ['0', 0o755, 0, 0, {}, digest(b'')]
    expected['etc/mtab'] = ['2', 0o777, 0, 0, {}, '/proc/mounts']
    for name in ('', 'host'):
        if name in observed and name not in expected:
            expected[name] = ['5', 0o755, 0, 0, {}]
    if observed != expected:
        raise RuntimeError('helper')

def atomic(path, data, mode=0o600):
    temporary = path.with_name(path.name + '.new')
    with open(temporary, 'w') as file:
        file.write(data)
        file.flush()
        os.fsync(file.fileno())
    os.chmod(temporary, mode)
    os.replace(temporary, path)

def fuse_mount_owners(root=pathlib.Path('/'), text=None):
    root = pathlib.Path(root)
    if text is None:
        try:
            text = (root / 'proc/self/mountinfo').read_text()
        except FileNotFoundError:
            if root != pathlib.Path('/'):
                return {}
            raise
    owners = {}
    for line in text.splitlines():
        fields = line.split()
        try:
            separator = fields.index('-')
            target = re.sub(r'\\([0-7]{3})', lambda match: chr(int(match[1], 8)), fields[4])
            match = re.fullmatch(r'/run/user/([1-9]\d*)/(doc|gvfs)', target)
            if match is None or fields[separator + 1] != {'doc': 'fuse.portal', 'gvfs': 'fuse.gvfsd-fuse'}[match[2]]:
                continue
            options = fields[5].split(',') + fields[separator + 3].split(',')
            ids = {}
            for key in ('user_id', 'group_id'):
                values = {item.split('=', 1)[1] for item in options if item.startswith(key + '=')}
                if len(values) != 1 or not next(iter(values)).isdigit():
                    raise ValueError('owner')
                ids[key] = int(next(iter(values)))
                if not 1 <= ids[key] < 4294967295:
                    raise ValueError('owner')
            if ids['user_id'] != int(match[1]):
                raise ValueError('owner')
            owners[str(root / target.lstrip('/'))] = (ids['user_id'], ids['group_id'])
        except (ValueError, IndexError):
            # An unverified mount receives the ordinary root traversal, which must succeed.
            continue
    return owners

def owner_tree_manifest(root, uid, gid):
    reader, writer = os.pipe()
    try:
        child = os.fork()
    except Exception:
        os.close(reader)
        os.close(writer)
        raise
    if child == 0:
        os.close(reader)
        try:
            os.setgroups([])
            os.setresgid(gid, gid, gid)
            os.setresuid(uid, uid, uid)
            if os.getresuid() != (uid, uid, uid) or os.getresgid() != (gid, gid, gid):
                raise PermissionError(13, 'credentials')
            payload = {'ok': True, 'manifest': tree_manifest(root)}
        except Exception as error:
            details = diagnostic(error)
            payload = {'ok': False, 'exception': details['exception']}
            if 'errno' in details:
                payload['errno'] = details['errno']
        try:
            with os.fdopen(writer, 'w') as stream:
                json.dump(payload, stream, separators=(',', ':'))
        finally:
            os._exit(0)
    os.close(writer)
    finished = False
    try:
        data = bytearray()
        deadline = time.monotonic() + 120
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([reader], [], [], max(0, remaining))[0]:
                raise TimeoutError('filesystem')
            chunk = os.read(reader, 1024 * 1024)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > 64 * 1024 * 1024:
                raise MemoryError('filesystem')
        _, status = os.waitpid(child, 0)
        finished = True
        payload = json.loads(data)
        if status != 0 or payload.get('ok') is not True:
            error = RuntimeError('filesystem')
            error.boat_exception = payload.get('exception', 'Exception')
            if type(payload.get('errno')) is int:
                error.errno = payload['errno']
            raise error
        manifest = payload.get('manifest')
        prefix = str(root)
        if not isinstance(manifest, dict) or prefix not in manifest or any(name != prefix and not name.startswith(prefix + '/') for name in manifest):
            raise RuntimeError('filesystem')
        return manifest
    finally:
        os.close(reader)
        if not finished:
            try:
                os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass
            os.waitpid(child, 0)

def tree_manifest(root, excluded=(), opaque=(), ignored=None, owner_mounts=None):
    result = {}
    root = pathlib.Path(root)
    excluded = tuple(str(path) for path in excluded)
    opaque = {str(path) for path in opaque}
    def visit(path):
        name = str(path)
        if any(name == item or name.startswith(item + '/') for item in excluded):
            return
        if ignored is not None and ignored(path):
            return
        try:
            metadata = path.lstat()
            value = [stat.S_IFMT(metadata.st_mode), stat.S_IMODE(metadata.st_mode), metadata.st_uid, metadata.st_gid]
            if stat.S_ISLNK(metadata.st_mode):
                value.append(os.readlink(path))
            elif stat.S_ISREG(metadata.st_mode) and name not in opaque:
                hasher = hashlib.sha256()
                with open(path, 'rb') as file:
                    for chunk in iter(lambda: file.read(1024 * 1024), b''):
                        hasher.update(chunk)
                value.append(hasher.hexdigest())
            elif not stat.S_ISDIR(metadata.st_mode):
                value.append(metadata.st_rdev)
            result[name] = value
            if stat.S_ISDIR(metadata.st_mode) and name not in opaque:
                for child in sorted(path.iterdir()):
                    visit(child)
        except PermissionError:
            owner = (owner_mounts or {}).get(name)
            if owner is None:
                raise
            manifest = owner_tree_manifest(path, *owner)
            for previous in list(result):
                if previous == name or previous.startswith(name + '/'):
                    del result[previous]
            result.update(manifest)
    if root.exists() or root.is_symlink():
        visit(root)
    return result

def owned_loop_artifacts(root):
    if root == pathlib.Path('/'):
        run(['udevadm', 'settle', '--timeout=10'])
    try:
        lines = (root / 'proc/self/mountinfo').read_text().splitlines()
    except FileNotFoundError:
        if root != pathlib.Path('/'):
            return {}
        raise
    mounted = [line.split() for line in lines if len(line.split()) > 4 and line.split()[4] == '/home/ci']
    volume = root / 'var/lib/boat-ci-reuse/job.ext4'
    if not mounted and root != pathlib.Path('/') and not volume.exists():
        return {}
    if len(mounted) != 1:
        raise RuntimeError('mounts')
    fields = mounted[0]
    separator = fields.index('-')
    device_id = fields[2]
    source = fields[separator + 2]
    if fields[separator + 1] != 'ext4' or re.fullmatch(r'/dev/loop(?:0|[1-9]\d*)', source) is None or re.fullmatch(r'7:(?:0|[1-9]\d*)', device_id) is None:
        raise RuntimeError('filesystem')
    device = root / source.lstrip('/')
    metadata = device.lstat()
    sysfs = root / 'sys/class/block' / device.name
    if not stat.S_ISBLK(metadata.st_mode) or str(os.major(metadata.st_rdev)) + ':' + str(os.minor(metadata.st_rdev)) != device_id or (sysfs / 'dev').read_text().strip() != device_id or (sysfs / 'loop/backing_file').read_text().strip() != '/var/lib/boat-ci-reuse/job.ext4':
        raise RuntimeError('filesystem')
    backing = volume.lstat()
    if not stat.S_ISREG(backing.st_mode) or backing.st_uid != 0 or backing.st_gid != 0 or backing.st_nlink != 1:
        raise RuntimeError('filesystem')
    with open(volume, 'rb') as stream:
        stream.seek(1024)
        superblock = stream.read(120)
    if len(superblock) != 120 or superblock[56:58] != b'\x53\xef' or not any(superblock[104:120]):
        raise RuntimeError('filesystem')
    raw_uuid = superblock[104:120].hex()
    uuid = '-'.join((raw_uuid[:8], raw_uuid[8:12], raw_uuid[12:16], raw_uuid[16:20], raw_uuid[20:]))
    sequence = (sysfs / 'diskseq').read_text().strip()
    if re.fullmatch(r'[1-9]\d*', sequence) is None:
        raise RuntimeError('filesystem')
    inode = str(os.major(backing.st_dev)) + ':' + str(os.minor(backing.st_dev)) + '-' + str(backing.st_ino)
    watch_device = 'b' + device_id
    watch = os.readlink(root / 'run/udev/watch' / watch_device)
    if re.fullmatch(r'(?:0|[1-9]\d*)', watch) is None:
        raise RuntimeError('filesystem')
    roles = [
        ('dev/disk/by-diskseq/' + sequence, 'dev/disk/by-diskseq/boat-ci-job-volume', '../../' + device.name, 'boat-ci-job-volume'),
        ('dev/disk/by-loop-inode/' + inode, 'dev/disk/by-loop-inode/boat-ci-job-volume', '../../' + device.name, 'boat-ci-job-volume'),
        ('dev/disk/by-uuid/' + uuid, 'dev/disk/by-uuid/boat-ci-job-volume', '../../' + device.name, 'boat-ci-job-volume'),
        ('run/udev/watch/' + watch_device, 'run/udev/watch/boat-ci-job-volume-device', watch, 'boat-ci-job-volume-watch'),
        ('run/udev/watch/' + watch, 'run/udev/watch/boat-ci-job-volume-watch', watch_device, 'boat-ci-job-volume-device'),
    ]
    artifacts = {}
    for relative, role, expected_target, normalized_target in roles:
        path = root / relative
        metadata = path.lstat()
        if not stat.S_ISLNK(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o777 or metadata.st_uid != 0 or metadata.st_gid != 0 or os.readlink(path) != expected_target:
            raise RuntimeError('filesystem')
        value = [stat.S_IFLNK, 0o777, 0, 0]
        artifacts[str(path)] = {'path': str(root / role), 'observed': value + [expected_target], 'normalized': value + [normalized_target]}
    return artifacts

def waiter_scope_artifacts(root, waiter):
    if waiter is None:
        return set()
    process = root / 'proc' / str(waiter)
    try:
        groups = [line.split(':', 2) for line in (process / 'cgroup').read_text().splitlines()]
    except FileNotFoundError:
        if root != pathlib.Path('/'):
            return set()
        raise
    scopes = []
    for group in groups:
        if len(group) != 3 or group[:2] != ['0', '']:
            continue
        match = re.fullmatch(r'/user\.slice/user-([1-9]\d*)\.slice/user@\1\.service/(?:app\.slice/)?(ascii-cmd-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.scope)', group[2])
        if match is not None:
            scopes.append((group[2], int(match[1]), match[2]))
    if not scopes:
        return set()
    if len(scopes) != 1:
        raise RuntimeError('filesystem')
    group, uid, scope = scopes[0]
    owner = process.stat()
    members = (root / 'sys/fs/cgroup' / group.lstrip('/') / 'cgroup.procs').read_text().split()
    if owner.st_uid != uid or str(waiter) not in members or any(not item.isdigit() for item in members):
        raise RuntimeError('filesystem')
    runtime = root / 'run/user' / str(uid) / 'systemd'
    transient = runtime / 'transient' / scope
    invocation = runtime / 'units' / ('invocation:' + scope)
    metadata = transient.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o644 or metadata.st_uid != uid or metadata.st_gid != owner.st_gid:
        raise RuntimeError('filesystem')
    metadata = invocation.lstat()
    if not stat.S_ISLNK(metadata.st_mode) or stat.S_IMODE(metadata.st_mode) != 0o777 or metadata.st_uid != uid or metadata.st_gid != owner.st_gid or re.fullmatch(r'[a-f0-9]{32}', os.readlink(invocation)) is None:
        raise RuntimeError('filesystem')
    return {str(transient), str(invocation)}

def filesystem_manifest(root=pathlib.Path('/'), waiter=None):
    root = pathlib.Path(root)
    opaque = {root / name.lstrip('/') for name in OPAQUE_PATHS}
    artifacts = owned_loop_artifacts(root)
    scope_paths = waiter_scope_artifacts(root, waiter)
    swaps = root / 'proc/swaps'
    if swaps.is_file():
        for line in swaps.read_text().splitlines()[1:]:
            name = line.split()[0].replace('\\040', ' ')
            if name.startswith('/'):
                opaque.add(root / name.lstrip('/'))
    def ignored(path):
        name = '/' + path.relative_to(root).as_posix()
        return str(path) in scope_paths or CONTROL_UNIT.fullmatch(name) is not None or SYSTEM_LOG.fullmatch(name) is not None
    result = tree_manifest(root, opaque=opaque, ignored=ignored, owner_mounts=fuse_mount_owners(root))
    for path, artifact in artifacts.items():
        if result.get(path) != artifact['observed'] or artifact['path'] in result:
            raise RuntimeError('filesystem')
        del result[path]
        result[artifact['path']] = artifact['normalized']
    return result

def ancestors(pid, proc=pathlib.Path('/proc')):
    found = set()
    while pid > 0 and pid not in found:
        found.add(pid)
        try:
            text = (proc / str(pid) / 'stat').read_text()
            pid = int(text[text.rfind(')') + 2:].split()[1])
        except (FileNotFoundError, ProcessLookupError, ValueError):
            break
    return found

def processes(ignored, proc=pathlib.Path('/proc')):
    result = {}
    for directory in proc.iterdir():
        if not directory.name.isdigit() or int(directory.name) in ignored:
            continue
        try:
            text = (directory / 'stat').read_text()
            fields = text[text.rfind(')') + 2:].split()
            if fields[0] == 'Z':
                continue
            cmd = (directory / 'cmdline').read_bytes()
            if not cmd:
                continue
            result[directory.name] = [fields[19], directory.stat().st_uid, os.readlink(directory / 'exe'), digest(cmd)]
            PROCESS_NAMES[(str(proc), directory.name, fields[19])] = safe_text(text[text.find('(') + 1:text.rfind(')')], 256)
        except (FileNotFoundError, ProcessLookupError):
            continue
    return result

def mounts():
    result = []
    for line in pathlib.Path('/proc/self/mountinfo').read_text().splitlines():
        fields = line.split()
        split = fields.index('-')
        target = fields[4]
        source = fields[split + 2]
        if target in ('/home/ci', '/tmp/w', '/opt/hostedtoolcache'):
            source = 'boat-ci-job-volume'
        result.append([target, fields[3], fields[5], fields[split + 1], source])
    return sorted(result)

def firewall_rules(text):
    return '\n'.join(re.sub(r'^(:[^ \t]+[ \t]+[^ \t]+[ \t]+)\[\d+:\d+\]$', r'\g<1>[0:0]', line) for line in text.splitlines() if not line.lstrip().startswith('#'))

def address_state(text):
    values = json.loads(text)
    if not isinstance(values, list):
        raise ValueError('network')
    lifetimes = []
    for interface in values:
        if not isinstance(interface, dict) or not isinstance(interface.get('addr_info', []), list):
            raise ValueError('network')
        for address in interface.get('addr_info', []):
            if not isinstance(address, dict):
                raise ValueError('network')
            for field in ('valid_life_time', 'preferred_life_time'):
                if field not in address:
                    continue
                value = address[field]
                if value == 'forever':
                    continue
                if type(value) is not int or not 0 <= value <= 4294967295:
                    raise ValueError('network')
                if 0 < value < 4294967295:
                    lifetimes.append(value)
                    address[field] = 'finite'
    return values, lifetimes

def address_sample(sections):
    if len(sections) == 3:
        return None
    value = sections[3]
    if not isinstance(value, dict) or set(value) != {'addressSample'}:
        raise ValueError('network')
    sample = value['addressSample']
    if not isinstance(sample, list) or len(sample) != 2 or any(type(number) not in (int, float) or not 0 <= number < float('inf') for number in sample) or sample[0] > sample[1]:
        raise ValueError('network')
    return sample

def addresses_equal(before, after):
    try:
        if any(not isinstance(sections, list) or len(sections) not in (3, 4) or any(not isinstance(text, str) for text in sections[:3]) for sections in (before, after)):
            return False
        old_state, old_lifetimes = address_state(before[0])
        new_state, new_lifetimes = address_state(after[0])
        old_sample, new_sample = address_sample(before), address_sample(after)
        if old_state != new_state:
            return False
        if not old_lifetimes:
            return True
        if old_sample is None or new_sample is None or new_sample[0] < old_sample[0]:
            return False
        for old, new in zip(old_lifetimes, new_lifetimes):
            if max(old_sample[0] + old, new_sample[0] + new) > min(old_sample[1] + old + 1, new_sample[1] + new + 1):
                return False
        return True
    except (ValueError, TypeError, IndexError):
        return False

def network_equal(before, after):
    return addresses_equal(before, after) and before[1] == after[1] and firewall_rules(before[2]) == firewall_rules(after[2])

def capture_network():
    started = time.monotonic()
    addresses = run(['ip', '-j', 'address'])
    sample = [started, time.monotonic()]
    address_state(addresses)
    routes = run(['ip', '-j', 'route'])
    set_stage('snapshot_firewall')
    firewall = firewall_rules(run(['iptables-save']))
    return [addresses, routes, firewall, {'addressSample': sample}]

def normalize_ci_ownership(files, uid, gid):
    normalized = {}
    for path, entry in files.items():
        value = list(entry)
        if value[2] == uid:
            value[2] = 'ci'
        if value[3] == gid:
            value[3] = 'ci'
        normalized[path] = value
    return normalized

def snapshot(waiter):
    set_stage('snapshot_files')
    user = pwd.getpwnam('ci')
    files = normalize_ci_ownership(tree_manifest(HOME), user.pw_uid, user.pw_gid)
    uid = user.pw_uid
    set_stage('snapshot_processes')
    ignored = ancestors(os.getpid()) | ancestors(waiter)
    for directory in pathlib.Path('/proc').iterdir():
        if directory.name.isdigit() and waiter in ancestors(int(directory.name)):
            ignored.add(int(directory.name))
    owned = ci_processes(uid, ignored)
    set_stage('snapshot_network')
    sockets = socket_inventory(uid=uid)
    cron = pathlib.Path('/var/spool/cron/crontabs/ci')
    return {'files': files, 'processes': owned, 'sockets': sockets,
            'cron': digest(cron.read_bytes()) if cron.exists() else None}


def ci_processes(uid, ignored, proc=pathlib.Path('/proc')):
    all_processes = processes(ignored, proc)
    sessions = set()
    for pid, value in all_processes.items():
        if value[1] != uid:
            continue
        try:
            text = (proc / pid / 'stat').read_text()
            session = text[text.rfind(')') + 2:].split()[3]
            if (proc / session).stat().st_uid == uid:
                sessions.add(session)
        except (FileNotFoundError, ProcessLookupError):
            continue
    result = {}
    for pid, value in all_processes.items():
        try:
            text = (proc / pid / 'stat').read_text()
            session = text[text.rfind(')') + 2:].split()[3]
            if value[1] == uid or session in sessions:
                result[pid] = value
        except (FileNotFoundError, ProcessLookupError):
            continue
    return result

def stable_sockets(entries):
    if not isinstance(entries, list) or any(not isinstance(entry, dict) or not isinstance(entry.get('identity'), dict) or not isinstance(entry.get('metadata'), list) for entry in entries):
        return entries
    result = []
    for entry in entries:
        identity, metadata = entry['identity'], entry['metadata']
        if identity == {'protocol': 'unix', 'path': '/run/docker.sock'} and {'flags': 65536, 'type': 1, 'state': 1} in metadata:
            metadata = [value for value in metadata if value != {'flags': 0, 'type': 1, 'state': 3}]
        elif identity == {'protocol': 'tcp4', 'port': 8911}:
            listeners = [value for value in metadata if value.get('state') == 10]
            if len(listeners) == 1:
                uid = listeners[0].get('uid')
                metadata = [value for value in metadata if value != {'state': 1, 'uid': uid} and value != {'state': 6, 'uid': 0}]
        result.append({'identity': identity, 'metadata': metadata})
    return result

def differences(baseline, current):
    return sorted(key for key in baseline if (not network_equal(baseline[key], current.get(key)) if key == 'network' else stable_sockets(baseline[key]) != stable_sockets(current.get(key, [])) if key == 'sockets' else baseline[key] != current.get(key)))

def safe_text(value, maximum=4096, absolute=False):
    if not isinstance(value, str) or not value or any(ord(char) < 32 or 127 <= ord(char) <= 159 or 0xd800 <= ord(char) <= 0xdfff for char in value):
        raise ValueError('diagnostics')
    if len(value.encode('utf-8')) > maximum or (absolute and not value.startswith('/')):
        raise ValueError('diagnostics')
    return value

def process_names(identities, proc=pathlib.Path('/proc')):
    names = {}
    for pid, identity in identities.items():
        captured = PROCESS_NAMES.get((str(proc), pid, identity[0]))
        if captured is not None:
            names[pid] = captured
            continue
        name = '[unavailable]'
        try:
            text = (proc / pid / 'stat').read_text()
            fields = text[text.rfind(')') + 2:].split()
            if fields[19] == identity[0]:
                name = text[text.find('(') + 1:text.rfind(')')]
        except (FileNotFoundError, ProcessLookupError, IndexError):
            pass
        names[pid] = safe_text(name, 256)
    return names

def socket_inventory(proc=pathlib.Path('/proc'), login_defs=pathlib.Path('/etc/login.defs'), uid=None):
    endpoints = {}
    uid_filter = uid
    low, high = map(int, (proc / 'sys/net/ipv4/ip_local_port_range').read_text().split())
    if not 0 < low <= high <= 65535:
        raise ValueError('diagnostics')
    uid_min, uid_max = 1000, 60000
    for line in login_defs.read_text().splitlines():
        fields = line.split('#', 1)[0].split()
        if len(fields) == 2 and fields[0] == 'UID_MIN':
            uid_min = int(fields[1])
        elif len(fields) == 2 and fields[0] == 'UID_MAX':
            uid_max = int(fields[1])
    if not 0 < uid_min <= uid_max < 65535:
        raise ValueError('diagnostics')
    def add(identity, values):
        key = json.dumps(identity, sort_keys=True, separators=(',', ':'))
        entry = endpoints.setdefault(key, {'identity': identity, 'metadata': []})
        entry['metadata'].append(values)
    for protocol in ('tcp', 'tcp6', 'udp', 'udp6'):
        try:
            lines = (proc / 'net' / protocol).read_text().splitlines()[1:]
        except FileNotFoundError:
            continue
        for line in lines:
            fields = line.split()
            port = int(fields[1].rsplit(':', 1)[1], 16)
            state, uid = int(fields[3], 16), int(fields[7])
            if not 0 <= port <= 65535:
                raise ValueError('diagnostics')
            if uid_filter is not None and uid != uid_filter:
                continue
            if uid_filter is None and not uid_min <= uid <= uid_max:
                continue
            if protocol.startswith('tcp'):
                if state != 10:
                    continue
            else:
                peer_address, peer_port = fields[2].rsplit(':', 1)
                if state != 7 or int(peer_address, 16) != 0 or int(peer_port, 16) != 0 or port == 0 or (uid_filter is None and low <= port <= high):
                    continue
            add({'protocol': protocol if protocol.endswith('6') else protocol + '4', 'port': port}, {'state': state, 'uid': uid})
    for entry in endpoints.values():
        entry['metadata'].sort(key=lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')))
    return [endpoints[key] for key in sorted(endpoints)]

def diagnostic_inventory(current, proc=pathlib.Path('/proc')):
    return {'processNames': process_names(current.get('processes', {}), proc), 'sockets': current.get('sockets', [])}

def file_fields(value):
    fields = ['type', 'mode', 'uid', 'gid']
    if len(value) > 4:
        fields.append('linkTarget' if value[0] == stat.S_IFLNK else 'contents' if value[0] == stat.S_IFREG and isinstance(value[4], str) else 'device')
    return fields

def network_fields(before, after):
    found = set()
    def field(name):
        return name if name in NETWORK_FIELDS else 'other'
    def visit(left, right, parent=None):
        if left == right:
            return
        if isinstance(left, dict) and isinstance(right, dict):
            for key in sorted(set(left) | set(right)):
                if key not in left or key not in right:
                    found.add(field(key))
                else:
                    visit(left[key], right[key], key)
        elif isinstance(left, list) and isinstance(right, list):
            if parent == 'flags':
                found.add('flags')
            elif sorted(json.dumps(item, sort_keys=True) for item in left) == sorted(json.dumps(item, sort_keys=True) for item in right):
                found.add('order')
            else:
                if len(left) != len(right):
                    found.add('membership')
                for old, new in zip(left, right):
                    visit(old, new, parent)
        else:
            found.add(field(parent))
    try:
        left, right = json.loads(before), json.loads(after)
    except (ValueError, TypeError):
        return ['other']
    visit(left, right)
    return sorted(found or {'serialization'})

def firewall_fields(before, after):
    def without_counters(text):
        return re.sub(r'(?m)(?<=\s)-c \d+ \d+(?=\s|$)', '-c COUNTERS', re.sub(r'\[\d+:\d+\]', '[COUNTERS]', text))
    left, right = without_counters(before), without_counters(after)
    fields = set()
    counters = r'\[\d+:\d+\]|(?<=\s)-c \d+ \d+(?=\s|$)'
    if re.findall(counters, before) != re.findall(counters, after):
        fields.add('counters')
    if left != right:
        if sorted(left.splitlines()) == sorted(right.splitlines()):
            fields.add('order')
        else:
            fields.add('rules')
        if len(left.splitlines()) != len(right.splitlines()):
            fields.add('membership')
    return sorted(fields or {'serialization'})

def drift_entries(baseline, current, previous_details, current_details):
    entries = []
    before, after = baseline.get('files', {}), current.get('files', {})
    for path in sorted(set(before) | set(after)):
        if path in before and path in after and before[path] == after[path]:
            continue
        change = 'added' if path not in before else 'removed' if path not in after else 'changed'
        fields = {'presence'}
        if change == 'changed':
            fields = set()
            old_fields, new_fields = file_fields(before[path]), file_fields(after[path])
            for index in range(max(len(before[path]), len(after[path]))):
                if index >= len(before[path]) or index >= len(after[path]) or before[path][index] != after[path][index]:
                    if index < len(old_fields): fields.add(old_fields[index])
                    if index < len(new_fields): fields.add(new_fields[index])
        entries.append({'kind': 'file', 'path': safe_text(path, absolute=True), 'change': change, 'fields': sorted(fields)})
    before, after = baseline.get('processes', {}), current.get('processes', {})
    process_entries = {}
    for pid in sorted(set(before) | set(after)):
        if pid in before and pid in after and before[pid] == after[pid]:
            continue
        change = 'added' if pid not in before else 'removed' if pid not in after else 'changed'
        fields = ['presence'] if change != 'changed' else [name for index, name in enumerate(('startTime', 'uid', 'executable', 'command')) if before[pid][index] != after[pid][index]]
        old_name = previous_details.get('processNames', {}).get(pid, '[unavailable]')
        new_name = current_details.get('processNames', {}).get(pid, '[unavailable]')
        names = [(old_name if change == 'removed' else new_name, change)]
        if change == 'changed' and old_name != new_name:
            fields.append('name')
            names = [(old_name, 'removed'), (new_name, 'added')]
        for name, status in names:
            entry = {'kind': 'process', 'name': safe_text(name, 256), 'change': status, 'fields': sorted(fields)}
            key = json.dumps(entry, sort_keys=True, separators=(',', ':'))
            if key not in process_entries:
                process_entries[key] = {**entry, 'count': 0}
            process_entries[key]['count'] += 1
    entries.extend(process_entries.values())
    before = {json.dumps(entry['identity'], sort_keys=True, separators=(',', ':')): entry for entry in stable_sockets(previous_details.get('sockets', []))}
    after = {json.dumps(entry['identity'], sort_keys=True, separators=(',', ':')): entry for entry in stable_sockets(current_details.get('sockets', []))}
    for key in sorted(set(before) | set(after)):
        old, new = before.get(key), after.get(key)
        if old == new:
            continue
        fields = {'membership'}
        if old is not None and new is not None:
            fields = set()
            if len(old['metadata']) != len(new['metadata']):
                fields.add('membership')
            for field in ('state', 'uid', 'flags', 'type'):
                if sorted(str(item[field]) for item in old['metadata'] if field in item) != sorted(str(item[field]) for item in new['metadata'] if field in item):
                    fields.add(field)
        entries.append({'kind': 'socket', **(new or old)['identity'], 'change': 'added' if old is None else 'removed' if new is None else 'changed', 'fields': sorted(fields or {'membership'})})
    before, after = baseline.get('network', []), current.get('network', [])
    if ('network' in baseline or 'network' in current) and not network_equal(before, after):
        for index, section in enumerate(('addresses', 'routes', 'firewall')):
            old = before[index] if index < len(before) else ''
            new = after[index] if index < len(after) else ''
            equal = addresses_equal(before, after) if section == 'addresses' else firewall_rules(old) == firewall_rules(new) if section == 'firewall' else old == new
            if not equal:
                entries.append({'kind': 'network', 'section': section, 'change': 'changed', 'fields': firewall_fields(firewall_rules(old), firewall_rules(new)) if section == 'firewall' else network_fields(old, new)})
    for component in ('packages', 'packageFiles', 'units', 'mounts', 'kernel', 'modules', 'cron'):
        if component in baseline and baseline[component] != current.get(component):
            entries.append({'kind': 'component', 'component': component, 'change': 'changed', 'fields': ['value']})
    return sorted(entries, key=lambda value: json.dumps(value, sort_keys=True, separators=(',', ':')))

def save_drift(result, entries, mode, generation):
    if not entries:
        return
    artifact = {'version': 1, 'gen': generation, 'mode': mode, 'totalEntries': len(entries), 'entries': entries}
    text = json.dumps(artifact, sort_keys=True, separators=(',', ':'))
    size = len(text.encode('utf-8'))
    if size > DRIFT_ARTIFACT_MAX_BYTES:
        raise MemoryError('drift_artifact')
    filename = 'drift-' + mode + '-' + str(generation) + '.json'
    path = CONTROL / filename
    atomic(path, text)
    user = pwd.getpwnam('user')
    os.chown(path, user.pw_uid, user.pw_gid)
    prefix = entries[:200]
    result['drift'] = {'version': 1, 'totalEntries': len(entries), 'omittedEntries': len(entries) - len(prefix), 'truncated': len(prefix) < len(entries), 'entries': prefix, 'artifact': {'path': '/home/user/.boat-ci/' + filename, 'bytes': size}}
    while len(json.dumps(result).encode('utf-8')) > RESULT_MAX_BYTES - 2048:
        prefix.pop()
        result['drift']['omittedEntries'] += 1
        result['drift']['truncated'] = True

def quiesce_packagekit():
    unit = 'packagekit.service'
    state = run(['systemctl', 'show', unit, '--property=LoadState', '--value'], (0, 1))
    if state == 'not-found':
        return
    if state not in ('loaded', 'masked'):
        raise RuntimeError('processes')
    run(['systemctl', 'mask', '--runtime', '--now', unit])
    if run(['systemctl', 'show', unit, '--property=LoadState', '--value']) != 'masked' or run(['systemctl', 'is-active', unit], (0, 3, 4)) not in ('inactive', 'failed'):
        raise RuntimeError('processes')

def quiesce_timed_units(names, flag_name, unit_root):
    flag = STATE / flag_name
    if flag.exists() or flag.is_symlink():
        raise RuntimeError('baseline')
    units = []
    for unit in names:
        state = run(['systemctl', 'show', unit, '--property=LoadState', '--value'], (0, 1))
        if state == 'not-found':
            continue
        if state != 'loaded':
            raise RuntimeError('baseline')
        directory = unit_root / (unit + '.d')
        directory.mkdir(mode=0o755, parents=True, exist_ok=True)
        atomic(directory / 'boat-ci-reuse.conf', '[Unit]\nConditionPathExists=' + str(flag) + '\n', 0o644)
        units.append(unit)
    if not units:
        return
    run(['systemctl', 'daemon-reload'])
    for unit in units:
        run(['systemctl', 'stop', unit])
    for unit in units:
        run(['systemctl', 'start', unit])
        if run(['systemctl', 'show', unit, '--property=ActiveState', '--value']) != 'inactive' or run(['systemctl', 'show', unit, '--property=ConditionResult', '--value']) != 'no':
            raise RuntimeError('baseline')

def quiesce_idle_reclaim(unit_root=pathlib.Path('/run/systemd/system')):
    quiesce_timed_units(('ascii-idle-reclaim.timer', 'ascii-idle-reclaim.service'), 'idle-reclaim-enabled', unit_root)

def quiesce_sysstat(unit_root=pathlib.Path('/run/systemd/system')):
    quiesce_timed_units(('sysstat-collect.timer', 'sysstat-collect.service', 'sysstat-summary.timer', 'sysstat-summary.service'), 'sysstat-enabled', unit_root)

def stop_job():
    units = run(['systemctl', 'list-units', '--all', '--plain', '--no-legend', 'boat-ci-job-*']).splitlines()
    for line in units:
        unit = line.split()[0]
        if unit.startswith('boat-ci-job-'):
            run(['systemctl', 'stop', unit])
    try:
        uid = pwd.getpwnam('ci').pw_uid
    except KeyError:
        return
    owned = ci_processes(uid, ancestors(os.getpid()))
    for pid in owned:
        try:
            os.kill(int(pid), signal.SIGKILL)
        except ProcessLookupError:
            pass
    run(['pkill', '-KILL', '-u', str(uid)], (0, 1))
    if ci_processes(uid, ancestors(os.getpid())):
        raise RuntimeError('processes')

def ci_uids():
    path = STATE / 'ci-uids.json'
    if not path.exists() and (STATE / 'baseline.json').exists():
        raise RuntimeError('filesystem')
    values = json.loads(path.read_text()) if path.exists() else []
    if not isinstance(values, list) or any(type(uid) is not int or not 0 < uid < 2147483647 for uid in values) or len(values) != len(set(values)):
        raise RuntimeError('filesystem')
    try:
        current = pwd.getpwnam('ci').pw_uid
        if current not in values:
            values.append(current)
    except KeyError:
        pass
    return values

def reserve_ci_uid():
    values = ci_uids()
    candidate = max([999] + values) + 1
    while candidate < 2147483647:
        try:
            pwd.getpwuid(candidate)
        except KeyError:
            atomic(STATE / 'ci-uids.json', json.dumps(values + [candidate]))
            directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            return candidate
        candidate += 1
    raise RuntimeError('filesystem')

def ipc_objects(uids, root=pathlib.Path('/proc/sysvipc')):
    if isinstance(uids, int):
        uids = [uids]
    uids = set(uids)
    result = []
    for kind in ('shm', 'sem', 'msg'):
        lines = (root / kind).read_text().splitlines()
        fields = lines[0].split()
        uid_index, cuid_index = fields.index('uid'), fields.index('cuid')
        for line in lines[1:]:
            values = line.split()
            if int(values[uid_index]) in uids or int(values[cuid_index]) in uids:
                result.append((kind, int(values[1])))
    return result

def clear_ipc(uids, root=pathlib.Path('/proc/sysvipc'), queues=pathlib.Path('/dev/mqueue')):
    for kind, identifier in ipc_objects(uids, root):
        run(['ipcrm', {'shm': '-m', 'sem': '-s', 'msg': '-q'}[kind], str(identifier)])
    if queues.is_dir():
        for queue in queues.iterdir():
            remove_path(queue)

def assert_no_owned_files(uids):
    if isinstance(uids, int):
        uids = [uids]
    excluded = sorted(set(OPAQUE_PATHS) | {str(HOME)})
    roots = {'/', '/run', '/run/lock', '/dev', '/dev/shm', '/tmp'}
    for root in sorted(roots):
        if any(root == path or root.startswith(path + '/') for path in excluded):
            continue
        if not pathlib.Path(root).is_dir():
            continue
        expression = ['find', root, '-ignore_readdir_race', '-xdev', '(']
        for index, path in enumerate(excluded):
            if index:
                expression.append('-o')
            expression.extend(['-path', path])
        expression.extend([')', '-prune', '-o', '('])
        for index, uid in enumerate(uids):
            if index:
                expression.append('-o')
            expression.extend(['-uid', str(uid)])
        expression.extend([')', '-print', '-quit'])
        if run(expression):
            raise RuntimeError('filesystem')

def restore_cron(cron):
    if not shutil.which('crontab'):
        return
    if cron is None:
        run(['crontab', '-u', 'ci', '-r'], (0, 1))
    else:
        run(['crontab', '-u', 'ci', '-'], stdin=cron.encode())

def image_inventory():
    ids = sorted(set(run(['docker', 'image', 'ls', '-aq', '--no-trunc']).split()))
    tags = sorted(set(run(['docker', 'image', 'ls', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']).splitlines()))
    return {'ids': ids, 'tags': tags}

def assert_images(allowlist):
    if image_inventory() != allowlist:
        raise RuntimeError('docker')

def docker_reset(allowlist):
    containers = run(['docker', 'ps', '-aq']).split()
    if containers:
        run(['docker', 'rm', '-f', *containers])
    run(['docker', 'builder', 'prune', '-af'])
    run(['docker', 'volume', 'prune', '-af'])
    volumes = run(['docker', 'volume', 'ls', '-q']).split()
    if volumes:
        run(['docker', 'volume', 'rm', '-f', *volumes])
    run(['docker', 'network', 'prune', '-f'])
    images = set(run(['docker', 'image', 'ls', '-aq', '--no-trunc']).split())
    for image in sorted(images - set(allowlist['ids'])):
        run(['docker', 'image', 'rm', '-f', image])
    if run(['docker', 'ps', '-aq']) or run(['docker', 'volume', 'ls', '-q']):
        raise RuntimeError('docker')
    assert_images(allowlist)
    if set(run(['docker', 'network', 'ls', '--format', '{{.Name}}']).split()) != {'bridge', 'host', 'none'}:
        raise RuntimeError('docker')

def unmount_job():
    roots = ('/home/ci', '/tmp/w', '/opt/hostedtoolcache')
    targets = [entry[0] for entry in mounts() if any(entry[0] == root or entry[0].startswith(root + '/') for root in roots)]
    for target in sorted(set(targets), key=lambda value: (value.count('/'), value), reverse=True):
        run(['umount', target])
    if any(entry[0] in roots for entry in mounts()):
        raise RuntimeError('mounts')

def remove_path(path):
    if path.is_symlink() or not path.is_dir():
        path.unlink(missing_ok=True)
    else:
        shutil.rmtree(path)

def wipe_temporary(roots=None):
    for index, root in enumerate(roots or (pathlib.Path('/tmp'), pathlib.Path('/var/tmp'), pathlib.Path('/dev/shm'))):
        for path in root.iterdir():
            if index == 0 and path.name == 'w':
                continue
            remove_path(path)

def fresh_job_filesystem():
    next_uid = reserve_ci_uid()
    set_stage('fresh_unmount')
    unmount_job()
    set_stage('fresh_user_delete')
    try:
        pwd.getpwnam('ci')
        run(['userdel', 'ci'])
    except KeyError:
        pass
    run(['groupdel', 'ci'], (0, 6))
    set_stage('fresh_volume_create')
    for path in (HOME, pathlib.Path('/tmp/w'), pathlib.Path('/opt/hostedtoolcache')):
        remove_path(path)
        path.mkdir(mode=0o755, parents=True)
    volume = STATE / 'job.ext4'
    volume.unlink(missing_ok=True)
    free = shutil.disk_usage(STATE).free
    size = min(40 * 1024**3, int(free * 0.60))
    if size < 4 * 1024**3:
        raise RuntimeError('disk')
    with open(volume, 'wb') as file:
        file.truncate(size)
    run(['mkfs.ext4', '-q', '-F', str(volume)])
    run(['mount', '-o', 'loop,nosuid,nodev', str(volume), str(HOME)])
    set_stage('fresh_user_create')
    run(['useradd', '--home-dir', str(HOME), '--shell', '/bin/bash', '--no-create-home', '--user-group', '--uid', str(next_uid), 'ci'])
    run(['chage', '--lastday', '0', 'ci'])
    for name in ('passwd', 'shadow', 'group', 'gshadow'):
        shutil.copyfile('/etc/' + name, '/etc/' + name + '-')
    uid = pwd.getpwnam('ci').pw_uid
    gid = pwd.getpwnam('ci').pw_gid
    for name in ('runner', 'work', 'toolcache'):
        path = HOME / name
        path.mkdir()
        os.chown(path, uid, gid)
    os.chown(HOME, uid, gid)
    os.chmod(HOME, 0o700)
    set_stage('fresh_runner_verify')
    descriptor = os.open(CONTROL / 'runner.tar.gz', os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, 'rb') as archive:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: archive.read(1024 * 1024), b''):
            hasher.update(chunk)
        if hasher.hexdigest() != RUNNER_SHA256:
            raise RuntimeError('filesystem')
        archive.seek(0)
        set_stage('fresh_runner_extract')
        run(['tar', 'xzf', '-', '-C', str(HOME / 'runner')], stdin=archive)
    run(['chown', '-R', 'ci:ci', str(HOME / 'runner')])
    set_stage('fresh_bind')
    run(['mount', '--bind', str(HOME / 'work'), '/tmp/w'])
    run(['mount', '--bind', str(HOME / 'toolcache'), '/opt/hostedtoolcache'])
    set_stage('fresh_temporary')
    wipe_temporary()

def assert_clean(allowlist):
    if run(['docker', 'ps', '-aq']) or run(['docker', 'volume', 'ls', '-q']):
        raise RuntimeError('docker')
    assert_images(allowlist)
    uid = pwd.getpwnam('ci').pw_uid
    if ci_processes(uid, ancestors(os.getpid())):
        raise RuntimeError('processes')
    previous_uids = ci_uids()
    if ipc_objects(previous_uids) or (pathlib.Path('/dev/mqueue').is_dir() and any(pathlib.Path('/dev/mqueue').iterdir())):
        raise RuntimeError('filesystem')
    assert_no_owned_files(previous_uids)
    if socket_inventory(uid=uid):
        raise RuntimeError('processes')
    for path in (HOME / 'work', HOME / 'toolcache'):
        if any(path.iterdir()):
            raise RuntimeError('filesystem')
    if shutil.disk_usage(STATE).free < 1024**3:
        raise RuntimeError('disk')

def transfer_jit(source, destination):
    # The control directory and /home/ci can be on different filesystems.
    # Stage in the destination directory so the final rename stays atomic.
    flags = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0)
    source_fd = os.open(source, flags)
    temporary = None
    try:
        info = os.fstat(source_fd)
        if not stat.S_ISREG(info.st_mode) or info.st_size == 0:
            raise RuntimeError('jit')
        temp_fd, temporary_name = tempfile.mkstemp(prefix='.jit-', dir=destination.parent)
        temporary = pathlib.Path(temporary_name)
        with os.fdopen(temp_fd, 'wb') as target, os.fdopen(source_fd, 'rb', closefd=False) as input_file:
            shutil.copyfileobj(input_file, target)
            target.flush()
            os.fsync(target.fileno())
        os.replace(temporary, destination)
        temporary = None
        source.unlink()
    finally:
        os.close(source_fd)
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def start_job(generation, docker_access):
    if int((STATE / 'current').read_text()) != generation:
        raise RuntimeError('generation')
    ready = json.loads((STATE / ('refresh-' + str(generation) + '.json')).read_text())
    if not ready['ok'] or ready['gen'] != generation:
        raise RuntimeError('generation')
    marker = STATE / ('started-' + str(generation))
    unit = 'boat-ci-job-' + str(generation)
    existing = run(['systemctl', 'show', unit, '--property=LoadState', '--value'], (0, 1))
    if existing != 'not-found':
        atomic(marker, 'started')
        return
    jit = CONTROL / 'jit'
    destination = HOME / '.jit'
    if not destination.is_file():
        if not jit.is_file() or jit.is_symlink() or jit.stat().st_size == 0:
            raise RuntimeError('jit')
        transfer_jit(jit, destination)
    user = pwd.getpwnam('ci')
    os.chown(destination, user.pw_uid, user.pw_gid)
    os.chmod(destination, 0o600)
    atomic(HOME / '.path', (STATE / 'path').read_text(), 0o644)
    script = HOME / 'start.sh'
    atomic(script, '''#!/usr/bin/env bash
set -euo pipefail
umask 022
export HOME=/home/ci
PATH="$(cat /home/ci/.path)"
export PATH
export TMPDIR=/tmp TZ=UTC LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export RUNNER_TOOL_CACHE=/opt/hostedtoolcache AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
cd /home/ci/runner
jit="$(cat /home/ci/.jit)"
rm -f /home/ci/.jit
test "$(git --version)" = 'git version 2.55.0'
${RUNNER_PERMISSION_CHECK}
exec setpriv --no-new-privs --inh-caps=-all --ambient-caps=-all ./run.sh --jitconfig "$jit"
''', 0o700)
    os.chown(script, user.pw_uid, user.pw_gid)
    run(['systemd-run', '--quiet', '--unit=' + unit, '--property=User=ci', '--property=Group=ci'] + (['--property=SupplementaryGroups=docker'] if docker_access else []) + ['--property=KillMode=control-group', '--property=RemainAfterExit=yes', '--property=TimeoutStopSec=10', '--property=RuntimeMaxSec=14400', '--property=WorkingDirectory=/home/ci/runner', '--property=StandardOutput=null', '--property=StandardError=null', str(script)])
    atomic(marker, 'started')

def main(mode, generation, waiter, helper, docker_access=False):
    started = time.monotonic()
    set_stage('initialize')
    STATE.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(STATE, 0o700)
    with open(STATE / 'lock', 'w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        result_path = CONTROL / (mode + '-' + str(generation) + '.json')
        baseline_path = STATE / 'baseline.json'
        result = {'ok': False, 'gen': generation, 'seconds': 0, 'failed': []}
        try:
            set_stage('helper_exit')
            for attempt in range(150):
                if subprocess.run(['docker', 'inspect', helper], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode != 0:
                    break
                time.sleep(0.2)
            else:
                raise RuntimeError('helper')
            if mode == 'start':
                set_stage('start_job')
                start_job(generation, docker_access)
            else:
                if mode == 'baseline' and not baseline_path.exists():
                    set_stage('baseline_init')
                    if generation != 0:
                        raise RuntimeError('generation')
                    quiesce_packagekit()
                    quiesce_idle_reclaim()
                    quiesce_sysstat()
                    os.chmod('/home/user', 0o755)
                    run(['chown', '-R', 'root:root', '/home/user/.local', '/home/user/boat-ci-runner'])
                    allowlist = image_inventory()
                    atomic(STATE / 'images.json', json.dumps(allowlist))
                    atomic(STATE / 'path', (CONTROL / 'reuse-path').read_text())
                    set_stage('stop_job')
                    stop_job()
                    clear_ipc(ci_uids())
                    set_stage('docker_reset')
                    docker_reset(allowlist)
                    set_stage('fresh_filesystem')
                    fresh_job_filesystem()
                    cron = pathlib.Path('/var/spool/cron/crontabs/ci')
                    atomic(STATE / 'cron.json', json.dumps(cron.read_text() if cron.exists() else None))
                    baseline = snapshot(waiter)
                    set_stage('snapshot_diagnostics')
                    atomic(STATE / 'baseline-diagnostics.json', json.dumps(diagnostic_inventory(baseline), sort_keys=True, separators=(',', ':')))
                    set_stage('baseline_save')
                    atomic(baseline_path, json.dumps(baseline, sort_keys=True, separators=(',', ':')))
                    atomic(STATE / 'current', '0')
                else:
                    set_stage('baseline_load')
                    if not baseline_path.exists():
                        raise RuntimeError('baseline')
                    allowlist = json.loads((STATE / 'images.json').read_text())
                    if mode == 'refresh':
                        previous = STATE / ('started-' + str(generation - 1))
                        current = int((STATE / 'current').read_text())
                        if generation < 1 or current not in (generation - 1, generation) or not previous.exists() or (STATE / ('started-' + str(generation))).exists():
                            raise RuntimeError('generation')
                        atomic(STATE / 'current', str(generation))
                        set_stage('stop_job')
                        stop_job()
                        clear_ipc(ci_uids())
                        set_stage('docker_reset')
                        docker_reset(allowlist)
                        set_stage('fresh_filesystem')
                        fresh_job_filesystem()
                        cron = json.loads((STATE / 'cron.json').read_text())
                        restore_cron(cron)
                    set_stage('baseline_load')
                    baseline = json.loads(baseline_path.read_text())
                    current = snapshot(waiter)
                    result['failed'] = differences(baseline, current)
                    if result['failed']:
                        set_stage('snapshot_diagnostics')
                        details_path = STATE / 'baseline-diagnostics.json'
                        previous_details = json.loads(details_path.read_text()) if details_path.exists() else {}
                        current_details = diagnostic_inventory(current)
                        set_stage('drift_save')
                        save_drift(result, drift_entries(baseline, current, previous_details, current_details), mode, generation)
                set_stage('assert_clean')
                assert_clean(allowlist)
                set_stage('baseline_hash')
                result['baselineHash'] = digest(baseline_path.read_bytes() + (STATE / 'images.json').read_bytes() + (STATE / 'path').read_bytes())
            result['ok'] = not result['failed']
        except Exception as error:
            code = str(error)
            result['failed'] = sorted(set(result['failed']) | {code if code in ('command', 'processes', 'docker', 'mounts', 'disk', 'filesystem', 'generation', 'jit', 'baseline') else 'controller'})
            result['diagnostic'] = diagnostic(error)
        result['seconds'] = round(time.monotonic() - started, 3)
        if mode in ('baseline', 'refresh'):
            atomic(STATE / ('refresh-' + str(generation) + '.json'), json.dumps(result))
        atomic(result_path, json.dumps(result))
        user = pwd.getpwnam('user')
        os.chown(result_path, user.pw_uid, user.pw_gid)

if __name__ == '__main__':
    if sys.argv[1] == 'helper':
        try:
            verify_helper(sys.argv[2])
        except Exception:
            sys.exit(1)
    else:
        main(sys.argv[1], int(sys.argv[2]), int(sys.argv[3]), sys.argv[4], sys.argv[5] == '1')
`;

export const REFRESH_HASH = createHash('sha256').update(REFRESH_PROGRAM).digest('hex');
const HASH = REFRESH_HASH;
const PAYLOAD = Buffer.from(REFRESH_PROGRAM).toString('base64');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

function command(mode, generation, dockerAccess = false) {
  if (!['baseline', 'refresh', 'check', 'start'].includes(mode)) throw new TypeError('Invalid refresh mode');
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 60) throw new TypeError('Invalid generation');
  const helper = `boat-ci-control-${mode}-${generation}`;
  const result = `/home/user/.boat-ci/${mode}-${generation}.json`;
  const host = `set -euo pipefail
install -d -m 700 /var/lib/boat-ci-reuse
printf '%s  %s\\n' '${HASH}' /home/user/.boat-ci/reuse-payload.py | sha256sum --check --strict - >/dev/null
install -m 700 /home/user/.boat-ci/reuse-payload.py /var/lib/boat-ci-reuse/controller.py
systemd-run --quiet --no-block --collect --property=RuntimeMaxSec=285 --property=TimeoutStopSec=10 --property=KillMode=control-group --property=StandardOutput=null --property=StandardError=null --unit=boat-ci-refresh-${mode}-${generation}-$$ /usr/bin/python3 /var/lib/boat-ci-reuse/controller.py '${mode}' '${generation}' "$1" '${helper}' '${dockerAccess ? 1 : 0}' >/dev/null 2>&1`;
  const script = `#!/usr/bin/env bash
set -euo pipefail
umask 077
mkdir -p /home/user/.boat-ci
exec 7>/home/user/.boat-ci/reuse-command.lock
flock 7
command_started=$SECONDS
deadline=$((command_started+300))
rm -f '${result}'
printf '%s' '${PAYLOAD}' | base64 --decode > /home/user/.boat-ci/reuse-payload.py
printf '%s  %s\\n' '${HASH}' /home/user/.boat-ci/reuse-payload.py | sha256sum --check --strict - >/dev/null
helper_stage=helper_start
launch_helper() {
  timeout 30 docker create --rm --name '${helper}' --privileged --pid=host --network=host --volume /:/host:rw --entrypoint /bin/busybox --user 0:0 --workdir / --no-healthcheck --read-only '${REFRESH_HELPER_IMAGE}' chroot /host /usr/bin/nsenter --target 1 --mount --uts --ipc --net --pid -- /bin/bash --noprofile --norc -c ${quote(host)} boat-ci-control "$$" >/dev/null 2>&1 || return $?
  helper_stage=helper_verify
  timeout 120 /usr/bin/python3 -I -B /home/user/.boat-ci/reuse-payload.py helper '${helper}' >/dev/null 2>&1 || return $?
  helper_stage=helper_start
  timeout 30 docker start --attach '${helper}' >/dev/null 2>&1
}
if launch_helper; then
  helper_status=0
else
  helper_status=$?
fi
timeout 30 docker rm -f '${helper}' >/dev/null 2>&1 || true
if ((helper_status!=0)); then
  printf '%s\\n' '{"ok":false,"gen":${generation},"seconds":'"$((SECONDS-command_started))"',"failed":["command"],"diagnostic":{"stage":"'"$helper_stage"'","exception":"RuntimeError","operation":"docker","exitCode":'"$helper_status"'}}'
  exit 0
fi
while ((SECONDS<deadline)); do
  if test -f '${result}'; then cat '${result}'; exit 0; fi
  sleep 1
done
printf '%s\\n' '{"ok":false,"gen":${generation},"seconds":300,"failed":["timeout"]}'
`;
  // Command APIs execute shell text; a shebang inside that text does not select its interpreter.
  return `exec /bin/bash --noprofile --norc -c ${quote(script)} boat-ci-reuse`;
}

export function reuseBootstrap() {
  return `set -e\n(\n${bootstrap()}\n)\nprintf '%s' "/home/user/.local/bin:$PATH" > /home/user/.boat-ci/reuse-path\nchmod 600 /home/user/.boat-ci/reuse-path\ndocker pull '${REFRESH_HELPER_IMAGE}' >/dev/null 2>&1\ndocker run --rm '${REFRESH_HELPER_IMAGE}' true >/dev/null 2>&1\n`;
}

export function refreshCommand(mode, generation) {
  if (mode === 'start') throw new TypeError('Use reuseStartCommand');
  return command(mode, generation);
}

export function reuseStartCommand(generation, dockerAccess = false) { return command('start', generation, dockerAccess); }

const FAILURES = new Set(['cron', 'files', 'packages', 'packageFiles', 'processes', 'units', 'mounts', 'kernel', 'modules', 'network', 'sockets', 'command', 'docker', 'disk', 'filesystem', 'generation', 'jit', 'baseline', 'controller', 'timeout']);
const DIAGNOSTIC_STAGES = new Set(['initialize', 'helper_start', 'helper_verify', 'helper_exit', 'start_job', 'baseline_init', 'baseline_load', 'baseline_save', 'baseline_hash', 'stop_job', 'docker_reset', 'fresh_filesystem', 'fresh_unmount', 'fresh_user_delete', 'fresh_volume_create', 'fresh_user_create', 'fresh_runner_verify', 'fresh_runner_extract', 'fresh_bind', 'fresh_temporary', 'snapshot_files', 'snapshot_processes', 'snapshot_packages', 'snapshot_package_files', 'snapshot_units', 'snapshot_mounts', 'snapshot_kernel', 'snapshot_modules', 'snapshot_network', 'snapshot_firewall', 'snapshot_diagnostics', 'drift_save', 'assert_clean']);
const DIAGNOSTIC_EXCEPTIONS = new Set(['Exception', 'FileNotFoundError', 'PermissionError', 'IsADirectoryError', 'NotADirectoryError', 'OSError', 'TimeoutError', 'TimeoutExpired', 'RuntimeError', 'KeyError', 'ValueError', 'TypeError', 'JSONDecodeError', 'UnicodeDecodeError', 'OverflowError', 'MemoryError', 'ProcessLookupError', 'FileExistsError', 'BrokenPipeError']);
const DIAGNOSTIC_OPERATIONS = new Set(['other', 'docker', 'systemctl', 'systemd-run', 'pkill', 'umount', 'userdel', 'groupdel', 'mkfs.ext4', 'mount', 'useradd', 'chage', 'tar', 'chown', 'dpkg-query', 'dpkg', 'sysctl', 'ip', 'iptables-save']);
const DRIFT_CHANGES = new Set(['added', 'removed', 'changed']);
const DRIFT_COMPONENTS = new Set(['cron', 'packages', 'packageFiles', 'units', 'mounts', 'kernel', 'modules']);
const DRIFT_FILE_FIELDS = new Set(['type', 'mode', 'uid', 'gid', 'contents', 'linkTarget', 'device', 'presence']);
const DRIFT_PROCESS_FIELDS = new Set(['startTime', 'uid', 'executable', 'command', 'presence', 'name']);
const DRIFT_SOCKET_FIELDS = new Set(['membership', 'state', 'uid', 'flags', 'type']);
const DRIFT_NETWORK_FIELDS = new Set(['ifindex', 'ifname', 'flags', 'mtu', 'qdisc', 'operstate', 'group', 'txqlen', 'link_type', 'address', 'broadcast', 'addr_info', 'family', 'local', 'prefixlen', 'scope', 'label', 'valid_life_time', 'preferred_life_time', 'dst', 'dev', 'protocol', 'prefsrc', 'gateway', 'metric', 'table', 'type', 'tos', 'onlink', 'uid', 'cache', 'expires', 'nhid', 'multipath', 'pref', 'src', 'master', 'link_index', 'link_netnsid', 'altnames', 'linkinfo', 'membership', 'order', 'serialization', 'other']);
const DRIFT_FIREWALL_FIELDS = new Set(['rules', 'counters', 'membership', 'order', 'serialization', 'other']);

function keysAre(value, required, optional = []) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

function safeText(value, maximum = 4096, absolute = false) {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u.test(value) && (!absolute || value.startsWith('/'));
}

function canonicalEntry(value) {
  return JSON.stringify(Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])))
    .replace(/[\u0080-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
}

function parseDriftEntries(values) {
  if (!Array.isArray(values)) return null;
  const entries = [];
  let previous = '';
  for (const value of values) {
    let fields;
    if (value?.kind === 'file') {
      if (!keysAre(value, ['kind', 'path', 'change', 'fields']) || !safeText(value.path, 4096, true)) return null;
      fields = DRIFT_FILE_FIELDS;
    } else if (value?.kind === 'process') {
      if (!keysAre(value, ['kind', 'name', 'change', 'fields', 'count']) || !safeText(value.name, 256) || !Number.isSafeInteger(value.count) || value.count < 1) return null;
      fields = DRIFT_PROCESS_FIELDS;
    } else if (value?.kind === 'socket') {
      if (value.protocol === 'unix') {
        if (!keysAre(value, ['kind', 'protocol', 'path', 'change', 'fields']) || (value.path !== null && !safeText(value.path))) return null;
      } else if (!keysAre(value, ['kind', 'protocol', 'port', 'change', 'fields']) || !['tcp4', 'tcp6', 'udp4', 'udp6'].includes(value.protocol) || !Number.isSafeInteger(value.port) || value.port < 0 || value.port > 65535) return null;
      fields = DRIFT_SOCKET_FIELDS;
    } else if (value?.kind === 'network') {
      if (!keysAre(value, ['kind', 'section', 'change', 'fields']) || !['addresses', 'routes', 'firewall'].includes(value.section) || value.change !== 'changed') return null;
      fields = value.section === 'firewall' ? DRIFT_FIREWALL_FIELDS : DRIFT_NETWORK_FIELDS;
    } else if (value?.kind === 'component') {
      if (!keysAre(value, ['kind', 'component', 'change', 'fields']) || !DRIFT_COMPONENTS.has(value.component) || value.change !== 'changed') return null;
      fields = new Set(['value']);
    } else return null;
    if (!DRIFT_CHANGES.has(value.change) || !Array.isArray(value.fields) || !value.fields.length || value.fields.some((field, index) => !fields.has(field) || (index > 0 && field <= value.fields[index - 1]))) return null;
    const key = canonicalEntry(value);
    if (key <= previous) return null;
    previous = key;
    entries.push({ ...value, fields: [...value.fields] });
  }
  return entries;
}

function parseDrift(value, generation) {
  if (!keysAre(value, ['version', 'totalEntries', 'omittedEntries', 'truncated', 'entries', 'artifact']) || value.version !== 1 || !Number.isSafeInteger(value.totalEntries) || value.totalEntries < 1 || !Number.isSafeInteger(value.omittedEntries) || value.omittedEntries < 0 || typeof value.truncated !== 'boolean') return null;
  const entries = parseDriftEntries(value.entries);
  if (!entries || entries.length > 200 || value.totalEntries !== entries.length + value.omittedEntries || value.truncated !== (value.omittedEntries > 0)) return null;
  const artifact = value.artifact;
  if (!keysAre(artifact, ['path', 'bytes']) || typeof artifact.path !== 'string' || !new RegExp('^/home/user/\\.boat-ci/drift-(baseline|refresh|check)-' + generation + '\\.json$').test(artifact.path) || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || artifact.bytes > REFRESH_DRIFT_ARTIFACT_MAX_BYTES) return null;
  return { version: 1, totalEntries: value.totalEntries, omittedEntries: value.omittedEntries, truncated: value.truncated, entries, artifact: { path: artifact.path, bytes: artifact.bytes } };
}

function parseDiagnostic(value) {
  if (!keysAre(value, ['stage', 'exception'], ['errno', 'operation', 'exitCode']) || !DIAGNOSTIC_STAGES.has(value.stage) || !DIAGNOSTIC_EXCEPTIONS.has(value.exception)) return null;
  if (value.errno !== undefined && (!Number.isSafeInteger(value.errno) || value.errno < 0 || value.errno > 4095)) return null;
  if (value.operation !== undefined && !DIAGNOSTIC_OPERATIONS.has(value.operation)) return null;
  if (value.exitCode !== undefined && (!Number.isSafeInteger(value.exitCode) || value.exitCode < -255 || value.exitCode > 255)) return null;
  return { stage: value.stage, exception: value.exception,
    ...(value.errno !== undefined ? { errno: value.errno } : {}),
    ...(value.operation !== undefined ? { operation: value.operation } : {}),
    ...(value.exitCode !== undefined ? { exitCode: value.exitCode } : {}) };
}

export function parseRefreshResult(response, generation) {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 60) return null;
  if (response?.running === true || response?.stdoutTruncated === true || (response?.exitCode != null && response.exitCode !== 0)) return null;
  const text = response?.stdout ?? response?.output;
  if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > REFRESH_RESULT_MAX_BYTES) return null;
  let result;
  try { result = JSON.parse(text.trim()); } catch { return null; }
  if (!result || result.gen !== generation || typeof result.ok !== 'boolean' || !Number.isFinite(result.seconds) || result.seconds < 0 || !Array.isArray(result.failed) || result.failed.some(code => !FAILURES.has(code)) || result.ok !== (result.failed.length === 0)) return null;
  if (result.baselineHash !== undefined && !/^[a-f0-9]{64}$/.test(result.baselineHash)) return null;
  const diagnostic = result.diagnostic === undefined ? null : parseDiagnostic(result.diagnostic);
  if (result.diagnostic !== undefined && (!diagnostic || result.ok)) return null;
  const drift = result.drift === undefined ? null : parseDrift(result.drift, generation);
  if (result.drift !== undefined && (!drift || result.ok)) return null;
  return { ok: result.ok, gen: generation, seconds: result.seconds, failed: [...new Set(result.failed)], ...(result.baselineHash ? { baselineHash: result.baselineHash } : {}), ...(diagnostic ? { diagnostic } : {}), ...(drift ? { drift } : {}) };
}

export function parseRefreshDriftArtifact(text, generation, expectedDrift) {
  if (!Number.isSafeInteger(generation) || generation < 0 || generation > 60 || typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > REFRESH_DRIFT_ARTIFACT_MAX_BYTES) return null;
  const expected = parseDrift(expectedDrift, generation);
  if (!expected || Buffer.byteLength(text, 'utf8') !== expected.artifact.bytes) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!keysAre(value, ['version', 'gen', 'mode', 'totalEntries', 'entries']) || value.version !== 1 || value.gen !== generation || !['baseline', 'refresh', 'check'].includes(value.mode) || expected.artifact.path !== `/home/user/.boat-ci/drift-${value.mode}-${generation}.json` || value.totalEntries !== expected.totalEntries) return null;
  const entries = parseDriftEntries(value.entries);
  if (!entries || entries.length !== value.totalEntries || expected.entries.some((entry, index) => canonicalEntry(entry) !== canonicalEntry(entries[index]))) return null;
  return { version: 1, gen: generation, mode: value.mode, totalEntries: value.totalEntries, entries };
}

// A complete result prefix already contains the entire fixed-schema artifact.
// Reconstruct only its canonical bytes and revalidate the declared size and path.
export function inlineRefreshDriftArtifact(result) {
  const generation = result?.gen;
  const drift = parseDrift(result?.drift, generation);
  if (!drift || drift.truncated) return null;
  const match = /^\/home\/user\/\.boat-ci\/drift-(baseline|refresh|check)-\d+\.json$/.exec(drift.artifact.path);
  if (!match) return null;
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === 'object' ?
    Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
  const text = JSON.stringify(canonical({ version: 1, gen: generation, mode: match[1], totalEntries: drift.totalEntries, entries: drift.entries }))
    .replace(/[\u0080-\uffff]/g, character => '\\u' + character.charCodeAt(0).toString(16).padStart(4, '0'));
  return parseRefreshDriftArtifact(text, generation, drift) ? text : null;
}
