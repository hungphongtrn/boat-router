import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { RELEASES, START_COMMAND } from '../bootstrap.mjs';

// In-box reset for Docker-enabled Actions labels (for example
// a Docker test lane). Jobs are trusted: the reset restores a clean,
// known state and fails closed; it is not an isolation boundary.
//
// The box keeps the non-reusable bootstrap: the runner runs as `user` from
// /home/user/boat-ci-runner with work folder /tmp/w and owns the Docker
// socket. A baseline is recorded once after setup (before the first runner
// starts). Each reset kills the job's cgroups, prunes Docker to the baseline
// images, restarts dockerd, stops units the job created, restores /home/user
// from the baseline archive, re-extracts the runner, wipes temp and tool
// caches, and then checks processes, listeners, drift, disk and memory.

export const DOCKER_RESET_STATE_DIR = '/var/lib/boat-ci-docker-reset';
export const DOCKER_RESET_STEPS = Object.freeze(['read baseline', 'stop runner', 'docker prune', 'restart dockerd', 'stop units', 'kill processes', 'clean filesystem', 'prepare runner', 'sanity checks']);
export const DOCKER_RESET_MAX_GENERATION = 60;

const PROGRAM = String.raw`import hashlib, json, os, pathlib, re, shutil, signal, stat, subprocess, sys, tarfile, time

STATE = pathlib.Path('${DOCKER_RESET_STATE_DIR}')
HOME = pathlib.Path('/home/user')
CONTROL = HOME / '.boat-ci'
RUNNER = HOME / 'boat-ci-runner'
WORK = pathlib.Path('/tmp/w')
TOOLCACHE = pathlib.Path('/opt/hostedtoolcache')
RUNNER_SHA256 = '${RELEASES.runner.sha256}'
HOME_OPAQUE = ('.boat-ci', 'boat-ci-runner', '.ascii')
CONTROL_TRANSIENT = ('started', 'jit', 'runner.log', 'runner.lock', 'telemetry.sh', 'setup-hang-proof')
TEMP_DIRS = ('/tmp', '/var/tmp', '/dev/shm')
MANIFEST_ROOTS = ('/usr/local', '/opt', '/etc', '/var/spool/cron', '/root')
MANIFEST_EXCLUDED = ('/opt/hostedtoolcache', '/opt/ascii', '/opt/ascii-agent', '/opt/ascii-baremetal-setup', '/opt/moonlight-web', '/opt/prime-agent', '/usr/local/lib/ascii', '/usr/local/lib/ascii-harnesses',
    '/etc/cups', '/etc/hosts', '/etc/resolv.conf', '/etc/mtab', '/etc/.pwd.lock', '/etc/adjtime', '/etc/.updated', '/etc/machine-id', '/etc/NetworkManager/system-connections', '/etc/lvm/archive', '/etc/lvm/backup',
    '/root/.docker/buildx', '/root/.cache/motd.legal-displayed')
DELETE_EXTRAS = ('/usr/local', '/opt', '/var/spool/cron')
# Kernel settings that change on their own (counters, pids, random values) or that belong to the per-container interfaces.
SYSCTL_VOLATILE = re.compile(r'^(fs\.(dentry-state|file-nr|inode-nr|inode-state|aio-nr|quota\.)|kernel\.(ns_last_pid|random\.|pty\.nr)|net\.netfilter\.nf_conntrack_count|net\.(ipv4|ipv6)\.(conf|neigh)\.(veth|br-|docker)|net\.ipv6\.route\.)')
MOUNT_VOLATILE = re.compile(r' (/run/docker/netns/|/var/lib/docker/)')
STATE_ARCHIVES = (('home.tar', 'homeArchiveSha256'), ('toolcache.tar', 'toolcacheArchiveSha256'), ('hosts', 'hostsSha256'))
DEFAULT_NETWORKS = {'bridge', 'host', 'none'}
RESPAWN = {'systemd', 'systemd-journal', 'systemd-udevd', 'systemd-resolve', 'systemd-network', 'systemd-timesyn', 'systemd-logind', 'systemd-userwor', 'systemd-userdbd', 'systemd-oomd', '(sd-pam)',
    'dbus-daemon', 'dbus-launch', 'dbus-run-sessio', 'dbus-broker', 'polkitd', 'packagekitd', 'udisksd', 'upowerd', 'colord', 'accounts-daemon', 'rtkit-daemon', 'gnome-remote-de', 'fusermount3', 'gvfsd', 'gvfsd-fuse', 'gvfsd-trash', 'gvfsd-metadata', 'gvfs-udisks2-vo', 'gvfs-mtp-volume', 'gvfs-gphoto2-vo', 'gvfs-afc-volume', 'gvfs-goa-volume', 'goa-daemon', 'goa-identity-se', 'dconf-service', 'at-spi-bus-laun', 'at-spi2-registr', 'xdg-desktop-por', 'xdg-document-po', 'xdg-permission-', 'ibus-daemon', 'ibus-memconf', 'ibus-ui-gtk3', 'ibus-extension-', 'ibus-x11', 'ibus-portal', 'ibus-engine-sim',
    'pipewire', 'pipewire-pulse', 'wireplumber', 'pulseaudio', 'dockerd', 'containerd', 'sshd', 'agetty', 'cron', 'atd', 'rsyslogd', 'NetworkManager', 'wpa_supplicant', 'ModemManager', 'cupsd', 'cups-browsed', 'epmd', 'avahi-daemon', 'power-profiles-', 'switcheroo-cont', 'lightdm', 'Xorg', 'openbox', 'multipathd', 'unattended-upgr', 'apt.systemd.dai', 'snapd', 'chronyd', 'irqbalance', 'networkd-dispat', 'cloud-init', 'kerneloops', 'ascii-desktop', 'ascii-agent-sup', 'ascii-agents-se', 'cua-driver', 'sunshine', 'web-server', 'socat'}
DPKG_FORMAT = '$' + '{Package} ' + '$' + '{Version}\n'
DEADLINE = time.monotonic() + 240
STEP = 'read baseline'
DETAILS = []

class ResetFailure(Exception):
    pass

def step(name):
    global STEP
    STEP = name
    sys.stderr.write('BOAT_RESET_STAGE step=%s\n' % name)
    sys.stderr.flush()
    if time.monotonic() > DEADLINE:
        raise ResetFailure('deadline')

def detail(key, value):
    DETAILS.append('%s=%s' % (key, value))
    sys.stderr.write('BOAT_RESET_DETAIL %s=%s\n' % (key, re.sub(r'[^A-Za-z0-9_.:/@=,+-]', '_', str(value))[:120]))

def fail(message, **kwargs):
    for key, value in kwargs.items():
        detail(key, value)
    raise ResetFailure(message)

def run(args, timeout=60, allowed=(0,), check=True, quiet=False):
    try:
        result = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL if quiet else subprocess.STDOUT, timeout=timeout)
    except subprocess.TimeoutExpired:
        fail('timeout', command=args[0])
    if check and result.returncode not in allowed:
        fail('command', command=args[0], exit=result.returncode)
    return result.stdout.decode('utf-8', errors='replace')

def sha256(path):
    hasher = hashlib.sha256()
    with open(path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(chunk)
    return hasher.hexdigest()

def own_cgroup():
    for line in pathlib.Path('/proc/self/cgroup').read_text().splitlines():
        if line.startswith('0::'):
            return line[3:]
    raise ResetFailure('cgroup')

def processes():
    found = {}
    for entry in pathlib.Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        pid = int(entry.name)
        try:
            text = (entry / 'stat').read_text()
            cgroup = (entry / 'cgroup').read_text()
            status = (entry / 'status').read_text()
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        comm = text[text.index('(') + 1:text.rindex(')')]
        fields = text[text.rindex(')') + 2:].split()
        if fields[0] == 'Z':
            continue
        ppid, flags, start = int(fields[1]), int(fields[6]), int(fields[19])
        uid = int(re.search(r'^Uid:\s+(\d+)', status, re.M)[1])
        group = next((line[3:] for line in cgroup.splitlines() if line.startswith('0::')), '')
        kernel = bool(flags & 0x00200000) or pid == 2 or ppid == 2
        found[pid] = {'comm': comm, 'uid': uid, 'ppid': ppid, 'start': start, 'cgroup': group, 'kernel': kernel}
    return found

def listeners():
    found = set()
    for proto, flag in (('tcp', '-t'), ('udp', '-u')):
        for line in run(['ss', '-H', '-l', '-n', flag], quiet=True).splitlines():
            parts = line.split()
            if len(parts) < 5:
                continue
            port = parts[3].rsplit(':', 1)[-1]
            if port.isdigit():
                found.add('%s:%s' % (proto, port))
    return found

def disk():
    usage = shutil.disk_usage('/')
    return {'usedKiB': usage.used // 1024, 'availableKiB': usage.free // 1024}

def memory_available_kib():
    for line in pathlib.Path('/proc/meminfo').read_text().splitlines():
        if line.startswith('MemAvailable:'):
            return int(line.split()[1])
    raise ResetFailure('meminfo')

def units(user=False):
    args = ['systemctl'] + (['--user', '-M', 'user@.host'] if user else []) + ['list-units', '--type=service', '--state=running', '--plain', '--no-legend', '--no-pager']
    return {line.split()[0] for line in run(args, quiet=True).splitlines() if line.strip()}

def timers(user=False):
    args = ['systemctl'] + (['--user', '-M', 'user@.host'] if user else []) + ['list-units', '--type=timer', '--all', '--plain', '--no-legend', '--no-pager']
    found = {}
    for line in run(args, quiet=True).splitlines():
        parts = line.split()
        if len(parts) >= 3:
            found[parts[0]] = parts[2]
    return found

def firewall():
    # Rules without counters. A table that only holds built-in chains with ACCEPT policies and no rules is the
    # kernel default; Docker instantiates such an empty table (raw) the first time a container publishes a port.
    lines = []
    for tool in ('iptables-save', 'ip6tables-save'):
        table = []
        for line in run([tool], timeout=30, quiet=True).splitlines():
            if line.startswith('#'):
                continue
            line = re.sub(r' \[\d+:\d+\]$', '', line)
            table.append(line)
            if line == 'COMMIT':
                if any(not (entry.startswith('*') or entry == 'COMMIT' or re.match(r'^:[A-Z]+ ACCEPT$', entry)) for entry in table):
                    lines.extend(table)
                table = []
    return lines

def sysctl():
    found = {}
    for line in run(['sysctl', '-a'], timeout=30, quiet=True).splitlines():
        key, sep, value = line.partition(' = ')
        if sep and not SYSCTL_VOLATILE.match(key):
            found[key] = value
    return found

def mounts():
    return sorted(line for line in pathlib.Path('/proc/self/mounts').read_text().splitlines() if line.strip() and not MOUNT_VOLATILE.search(line))

def dpkg():
    found = {}
    for line in run(['dpkg-query', '-W', '-f', DPKG_FORMAT], quiet=True).splitlines():
        name, sep, version = line.partition(' ')
        if sep:
            found[name] = version
    return found

def first_difference(expected, current):
    for key in sorted(set(expected) | set(current)):
        if expected.get(key) != current.get(key):
            return key
    return None

def build_cache_entries():
    for line in docker(['system', 'df', '--format', '{{.Type}}={{.TotalCount}}']).splitlines():
        if line.startswith('Build Cache='):
            return int(line.split('=', 1)[1] or 0)
    fail('build cache unknown')

def archive(name, root, opaque=()):
    path = STATE / name
    with tarfile.open(path, 'w', format=tarfile.PAX_FORMAT) as tar:
        for child in sorted(pathlib.Path(root).iterdir()):
            if child.name in opaque:
                continue
            tar.add(child, arcname=child.name, recursive=True)
    return path

def restore(name, root):
    with tarfile.open(STATE / name, 'r') as tar:
        tar.extractall(root, numeric_owner=True, filter='fully_trusted')

def restart_docker():
    # Resets between short jobs can hit docker.service's start rate limit (3 starts in 60 s); clear it and retry once.
    for attempt in range(2):
        run(['systemctl', 'reset-failed', 'docker.service'], timeout=30, check=False)
        result = subprocess.run(['systemctl', 'restart', 'docker.service'], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=90)
        if result.returncode == 0:
            return
        detail('restart_attempt', attempt + 1)
        time.sleep(5)
    fail('command', command='systemctl', exit=result.returncode)

def docker(args, timeout=120, allowed=(0,), check=True):
    return run(['docker'] + list(args), timeout=timeout, allowed=allowed, check=check, quiet=True)

def docker_images():
    found = {}
    for line in docker(['image', 'ls', '-a', '--no-trunc', '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']).splitlines():
        parts = line.split(' ', 1)
        if parts and parts[0]:
            found.setdefault(parts[0], []).append(parts[1] if len(parts) > 1 else '')
    return found

def excluded(path):
    name = str(path)
    return any(name == item or name.startswith(item + '/') for item in MANIFEST_EXCLUDED)

def manifest(root):
    result = {}
    stack = [pathlib.Path(root)]
    while stack:
        current = stack.pop()
        if excluded(current):
            continue
        try:
            metadata = current.lstat()
        except FileNotFoundError:
            continue
        kind = stat.S_IFMT(metadata.st_mode)
        value = [kind, stat.S_IMODE(metadata.st_mode), metadata.st_uid, metadata.st_gid]
        if stat.S_ISLNK(metadata.st_mode):
            value.append(os.readlink(current))
        elif stat.S_ISREG(metadata.st_mode):
            value.extend([metadata.st_size, int(metadata.st_mtime)])
        result[str(current)] = value
        if stat.S_ISDIR(metadata.st_mode):
            try:
                stack.extend(sorted(current.iterdir(), reverse=True))
            except PermissionError:
                pass
    return result

def remove(path):
    path = pathlib.Path(path)
    try:
        if path.is_symlink() or not path.is_dir():
            path.unlink()
        else:
            shutil.rmtree(path)
    except FileNotFoundError:
        pass

def wipe_contents(directory):
    directory = pathlib.Path(directory)
    if not directory.is_dir() or directory.is_symlink():
        return
    for child in directory.iterdir():
        remove(child)

def temp_names():
    return {name: sorted(child.name for child in pathlib.Path(name).iterdir()) for name in TEMP_DIRS if pathlib.Path(name).is_dir()}

def baseline():
    STATE.mkdir(mode=0o700, exist_ok=True)
    os.chmod(STATE, 0o700)
    own = own_cgroup()
    step('docker baseline')
    docker(['info'], timeout=60)
    if docker(['ps', '-aq']).strip():
        fail('containers at baseline')
    step('home archive')
    for name in CONTROL_TRANSIENT:
        remove(CONTROL / name)
    home_archive = archive('home.tar', HOME, HOME_OPAQUE)
    TOOLCACHE.mkdir(mode=0o755, exist_ok=True)
    toolcache_archive = archive('toolcache.tar', TOOLCACHE)
    shutil.copy2('/etc/hosts', STATE / 'hosts')
    if build_cache_entries():
        fail('build cache at baseline')
    # buildx (docker build, docker builder prune) keeps state under /root/.docker/buildx; that subtree is excluded from
    # the /root manifest, the directories themselves are part of the baseline, and /root/.docker/config.json stays covered.
    for name in ('/root/.docker', '/root/.docker/buildx'):
        pathlib.Path(name).mkdir(mode=0o700, exist_ok=True)
        os.chmod(name, 0o700)
    step('record baseline')
    procs = processes()
    record = {
        'version': 2,
        'at': time.time(),
        'processes': {str(pid): [info['uid'], info['comm'], info['start']] for pid, info in procs.items() if not info['kernel'] and not info['cgroup'].startswith(own)},
        'listeners': sorted(listeners()),
        'systemUnits': sorted(units()),
        'userUnits': sorted(unit for unit in units(user=True)),
        'systemTimers': timers(),
        'userTimers': timers(user=True),
        'firewall': firewall(),
        'sysctl': sysctl(),
        'mounts': mounts(),
        'images': docker_images(),
        'manifest': {root: manifest(root) for root in MANIFEST_ROOTS},
        'temp': temp_names(),
        'homeArchiveSha256': sha256(home_archive),
        'toolcacheArchiveSha256': sha256(toolcache_archive),
        'hostsSha256': sha256(STATE / 'hosts'),
        'dpkg': dpkg(),
        'memoryAvailableKiB': memory_available_kib(),
    }
    record['disk'] = disk()
    data = json.dumps(record, sort_keys=True, separators=(',', ':'))
    (STATE / 'baseline.json.new').write_text(data)
    os.chmod(STATE / 'baseline.json.new', 0o600)
    os.replace(STATE / 'baseline.json.new', STATE / 'baseline.json')
    digest = hashlib.sha256(data.encode()).hexdigest()
    sys.stdout.write(json.dumps({'ok': True, 'baselineHash': digest, 'processes': len(record['processes']), 'listeners': len(record['listeners']), 'images': len(record['images']), 'homeArchiveBytes': home_archive.stat().st_size, 'toolcacheArchiveBytes': toolcache_archive.stat().st_size, 'sysctl': len(record['sysctl']), 'mounts': len(record['mounts']), 'firewallRules': len(record['firewall']), 'packages': len(record['dpkg'])}) + '\n')

def keep(pid, info, base, own):
    if pid == 1 or info['kernel'] or info['cgroup'].startswith(own):
        return True
    recorded = base['processes'].get(str(pid))
    if recorded and recorded[0] == info['uid'] and recorded[1] == info['comm'] and recorded[2] == info['start']:
        return True
    if re.search(r'/ascii-cmd-[^/]+\.scope', info['cgroup']) or '/docker-' in info['cgroup']:
        return False
    return info['comm'] in RESPAWN

def kill_cgroup(path):
    group = pathlib.Path('/sys/fs/cgroup') / path.lstrip('/')
    try:
        (group / 'cgroup.kill').write_text('1')
    except FileNotFoundError:
        return
    for _ in range(100):
        try:
            if not (group / 'cgroup.procs').read_text().strip():
                return
        except FileNotFoundError:
            return
        time.sleep(0.1)
    fail('cgroup processes remain', cgroup=path.rsplit('/', 1)[-1])

def reset(generation, expected):
    step('read baseline')
    path = STATE / 'baseline.json'
    data = path.read_text()
    if hashlib.sha256(data.encode()).hexdigest() != expected:
        fail('baseline mismatch')
    base = json.loads(data)
    if base.get('version') != 2:
        fail('baseline version')
    for name, key in STATE_ARCHIVES:
        if sha256(STATE / name) != base[key]:
            fail('baseline archive mismatch', archive=name)
    own = own_cgroup()
    step('stop runner')
    scopes = {info['cgroup'] for info in processes().values() if re.search(r'/ascii-cmd-[^/]+\.scope', info['cgroup']) and not info['cgroup'].startswith(own)}
    for scope in sorted(scopes):
        kill_cgroup(re.sub(r'(/ascii-cmd-[^/]+\.scope).*', r'\1', scope))
    detail('runner_scopes', len(scopes))
    step('docker prune')
    if 'Server Version' not in docker(['info'], timeout=30, check=False):
        restart_docker()
    containers = docker(['ps', '-aq']).split()
    if containers:
        docker(['rm', '-f', '-v'] + containers, timeout=180)
    detail('containers', len(containers))
    volumes = docker(['volume', 'ls', '-q']).split()
    if volumes:
        docker(['volume', 'rm', '-f'] + volumes, timeout=120)
    detail('volumes', len(volumes))
    networks = [line.split()[1] for line in docker(['network', 'ls', '--format', '{{.ID}} {{.Name}}']).splitlines() if len(line.split()) == 2 and line.split()[1] not in DEFAULT_NETWORKS]
    if networks:
        docker(['network', 'rm', '-f'] + networks, timeout=120)
    detail('networks', len(networks))
    current_images = docker_images()
    extra_images = [image for image in current_images if image not in base['images']]
    if extra_images:
        docker(['image', 'rm', '-f'] + extra_images, timeout=300)
    detail('images', len(extra_images))
    extra_tags = [tag for image, tags in current_images.items() if image in base['images'] for tag in tags if tag not in base['images'][image] and tag and '<none>' not in tag]
    if extra_tags:
        docker(['image', 'rm'] + extra_tags, timeout=120)
    detail('tags', len(extra_tags))
    docker(['system', 'prune', '-f', '--volumes'], timeout=300)
    docker(['builder', 'prune', '-af'], timeout=300)
    if build_cache_entries():
        fail('build cache remains')
    step('restart dockerd')
    restart_docker()
    for _ in range(60):
        if 'Server Version' in docker(['info'], timeout=30, check=False):
            break
        time.sleep(1)
    else:
        fail('docker unavailable')
    if docker(['ps', '-aq']).strip():
        fail('containers remain')
    if docker(['volume', 'ls', '-q']).strip():
        fail('volumes remain')
    remaining_networks = {line.split()[1] for line in docker(['network', 'ls', '--format', '{{.ID}} {{.Name}}']).splitlines() if len(line.split()) == 2} - DEFAULT_NETWORKS
    if remaining_networks:
        fail('networks remain', network=sorted(remaining_networks)[0])
    after_images = docker_images()
    unexpected_images = [image for image in after_images if image not in base['images']]
    if unexpected_images:
        fail('images remain', image=unexpected_images[0][:19])
    for image, tags in base['images'].items():
        if sorted(after_images.get(image, [])) != sorted(tags):
            fail('image tags drift', image=image[:19])
    if build_cache_entries():
        fail('build cache remains')
    step('stop units')
    extra_units = sorted(units() - set(base['systemUnits']))
    for unit in extra_units:
        run(['systemctl', 'stop', unit], timeout=60, check=False)
        run(['systemctl', 'kill', '-s', 'KILL', unit], timeout=30, check=False)
    extra_user_units = sorted(units(user=True) - set(base['userUnits']))
    for unit in extra_user_units:
        run(['systemctl', '--user', '-M', 'user@.host', 'stop', unit], timeout=60, check=False)
    detail('units', len(extra_units) + len(extra_user_units))
    extra_timers = sorted(set(timers()) - set(base['systemTimers']))
    for unit in extra_timers:
        run(['systemctl', 'stop', unit], timeout=30, check=False)
    extra_user_timers = sorted(set(timers(user=True)) - set(base['userTimers']))
    for unit in extra_user_timers:
        run(['systemctl', '--user', '-M', 'user@.host', 'stop', unit], timeout=30, check=False)
    detail('timers', len(extra_timers) + len(extra_user_timers))
    step('kill processes')
    killed = 0
    for pid, info in processes().items():
        if keep(pid, info, base, own):
            continue
        try:
            os.kill(pid, signal.SIGKILL)
            killed += 1
        except ProcessLookupError:
            pass
    detail('killed', killed)
    deadline = time.monotonic() + 15
    while True:
        remaining = {pid: info for pid, info in processes().items() if not keep(pid, info, base, own)}
        if not remaining or time.monotonic() > deadline:
            break
        time.sleep(0.5)
    if remaining:
        pid, info = sorted(remaining.items())[0]
        fail('processes remain', count=len(remaining), comm=info['comm'], uid=info['uid'])
    step('clean filesystem')
    wipe_contents(WORK)
    wipe_contents(TOOLCACHE)
    for directory, names in base['temp'].items():
        root = pathlib.Path(directory)
        if not root.is_dir():
            continue
        for child in root.iterdir():
            if child.name not in names:
                remove(child)
            elif child.is_dir() and not child.is_symlink() and child.lstat().st_uid == 1000 and child.name not in ('w',):
                wipe_contents(child)
    for child in HOME.iterdir():
        if child.name not in HOME_OPAQUE:
            remove(child)
    restore('home.tar', HOME)
    TOOLCACHE.mkdir(mode=0o755, exist_ok=True)
    restore('toolcache.tar', TOOLCACHE)
    shutil.copy2(STATE / 'hosts', '/etc/hosts')
    for name in CONTROL_TRANSIENT:
        remove(CONTROL / name)
    drift = []
    for root in MANIFEST_ROOTS:
        expected_tree = base['manifest'].get(root, {})
        current = manifest(root)
        for name in sorted(current, key=len, reverse=True):
            if name not in expected_tree:
                if root in DELETE_EXTRAS and name != root:
                    remove(name)
                else:
                    drift.append(name)
        for name, value in expected_tree.items():
            if current.get(name) != value:
                drift.append(name)
    if drift:
        fail('drift', count=len(drift), path=sorted(drift)[0])
    packages = dpkg()
    if packages != base['dpkg']:
        changed = first_difference(base['dpkg'], packages)
        fail('package drift', package=changed, baseline=base['dpkg'].get(changed, 'absent'), now=packages.get(changed, 'absent'))
    step('prepare runner')
    remove(RUNNER)
    RUNNER.mkdir(mode=0o755)
    if sha256(CONTROL / 'runner.tar.gz') != RUNNER_SHA256:
        fail('runner archive')
    run(['tar', 'xzf', str(CONTROL / 'runner.tar.gz'), '-C', str(RUNNER)], timeout=120)
    run(['chown', '-R', '1000:1000', str(RUNNER)], timeout=60)
    WORK.mkdir(mode=0o755, exist_ok=True)
    os.chown(WORK, 1000, 1000)
    TOOLCACHE.mkdir(mode=0o755, exist_ok=True)
    os.chown(TOOLCACHE, 1000, 1000)
    step('sanity checks')
    unexpected = sorted(listeners() - set(base['listeners']))
    if unexpected:
        fail('listeners remain', count=len(unexpected), listener=unexpected[0])
    remaining = {pid: info for pid, info in processes().items() if not keep(pid, info, base, own)}
    if remaining:
        pid, info = sorted(remaining.items())[0]
        fail('processes remain', count=len(remaining), comm=info['comm'], uid=info['uid'])
    for scope, user in (('systemTimers', False), ('userTimers', True)):
        current_timers = timers(user=user)
        extra = sorted(set(current_timers) - set(base[scope]))
        if extra:
            fail('timers remain', timer=extra[0])
        changed = sorted(name for name, state in base[scope].items() if current_timers.get(name) != state)
        if changed:
            fail('timer drift', timer=changed[0], state=current_timers.get(changed[0], 'gone'))
    current_firewall = firewall()
    if current_firewall != base['firewall']:
        fail('firewall drift', rules=len(current_firewall), baselineRules=len(base['firewall']))
    current_sysctl = sysctl()
    if current_sysctl != base['sysctl']:
        key = first_difference(base['sysctl'], current_sysctl)
        fail('sysctl drift', key=key, now=current_sysctl.get(key, 'absent'))
    current_mounts = mounts()
    if current_mounts != base['mounts']:
        unexpected = sorted(set(current_mounts) ^ set(base['mounts']))
        fail('mount drift', count=len(unexpected), mount=unexpected[0].split()[1] if len(unexpected[0].split()) > 1 else unexpected[0])
    now_disk = disk()
    if now_disk['usedKiB'] > base['disk']['usedKiB'] + 3 * 1024 * 1024 or now_disk['availableKiB'] < 4 * 1024 * 1024:
        fail('disk', usedKiB=now_disk['usedKiB'], baselineUsedKiB=base['disk']['usedKiB'])
    available = memory_available_kib()
    if available < base['memoryAvailableKiB'] - 2 * 1024 * 1024:
        fail('memory', availableKiB=available, baselineAvailableKiB=base['memoryAvailableKiB'])
    sys.stdout.write(json.dumps({'ok': True, 'gen': generation, 'killed': killed, 'containers': len(containers), 'volumes': len(volumes), 'networks': len(networks), 'images': len(extra_images), 'tags': len(extra_tags), 'units': len(extra_units) + len(extra_user_units), 'timers': len(extra_timers) + len(extra_user_timers), 'diskUsedDeltaKiB': now_disk['usedKiB'] - base['disk']['usedKiB'], 'memoryAvailableDeltaKiB': available - base['memoryAvailableKiB']}) + '\n')

def main():
    if os.geteuid() != 0:
        raise ResetFailure('root required')
    mode = sys.argv[1]
    if mode == 'baseline':
        baseline()
    elif mode == 'reset':
        reset(int(sys.argv[2]), sys.argv[3])
    else:
        raise ResetFailure('mode')

try:
    main()
except ResetFailure as error:
    sys.stderr.write('BOAT_RESET_FAILURE step=%s exit=1 reason=%s\n' % (STEP, re.sub(r'[^a-z ]', '', str(error))[:40]))
    sys.exit(1)
except Exception as error:
    sys.stderr.write('BOAT_RESET_FAILURE step=%s exit=2 reason=%s\n' % (STEP, type(error).__name__))
    sys.exit(2)
`;

export const DOCKER_RESET_PROGRAM_SHA256 = createHash('sha256').update(PROGRAM).digest('hex');

const payload = Buffer.from(PROGRAM).toString('base64');
const invoke = args => `printf %s '${payload}' | base64 -d | sudo -n python3 -I - ${args}`;

export function dockerBaselineCommand() { return invoke('baseline'); }

export function dockerResetCommand(generation, baselineHash) {
  if (!Number.isSafeInteger(generation) || generation < 1 || generation > DOCKER_RESET_MAX_GENERATION) throw new TypeError('Invalid generation');
  if (!/^[a-f0-9]{64}$/.test(baselineHash ?? '')) throw new TypeError('Invalid baseline hash');
  return invoke(`reset ${generation} ${baselineHash}`);
}

// The runner start is the fresh-box start: the reset removed the started
// marker and the previous JIT configuration, and configure() placed a new one.
export function dockerStartCommand() { return START_COMMAND; }

const STAGE = /BOAT_RESET_STAGE step=([a-z ]+)$/;
const FAILURE = /BOAT_RESET_FAILURE step=([a-z ]+) exit=(\d+)(?: reason=([a-z ]*))?/;
const DETAIL = /^BOAT_RESET_DETAIL ([A-Za-z_]+)=([A-Za-z0-9_.:/@=,+-]{0,120})$/;

function failure(response, fallbackStep) {
  const output = [response?.stdout, response?.stderr].filter(value => typeof value === 'string').join('\n');
  const match = FAILURE.exec(output);
  const stages = [...output.matchAll(/BOAT_RESET_STAGE step=([a-z ]+)/g)];
  const step = match?.[1]?.trim() ?? stages.at(-1)?.[1]?.trim() ?? fallbackStep;
  const exitCode = match ? Number(match[2]) : Number.isInteger(response?.exitCode) ? response.exitCode : null;
  const details = {};
  const tail = output.split('\n').slice(-40).map(line => STAGE.test(line) || FAILURE.test(line) ? line : DETAIL.test(line) ? (details[DETAIL.exec(line)[1]] = DETAIL.exec(line)[2], line) : '[redacted]').filter((line, i, all) => line !== '[redacted]' || all[i - 1] !== '[redacted]').join('\n');
  return { ok: false, step, exitCode, output: tail.slice(-2048), ...(match?.[3] ? { reason: match[3].trim() } : {}), ...(Object.keys(details).length ? { details } : {}), ...(/BOAT_RESET_FAILURE step=sanity checks exit=1 reason=disk/.test(output) ? { guard: 'disk' } : {}) };
}

export function parseDockerBaselineResult(response) {
  if (response?.running === true) return null;
  if (response?.exitCode !== 0) return failure(response, 'baseline command');
  if (response?.stdoutTruncated === true || typeof response?.stdout !== 'string' || response.stdout.length > 4096) return { ok: false, step: 'read baseline result', exitCode: 0, output: '' };
  try {
    const result = JSON.parse(response.stdout.trim().split('\n').at(-1));
    if (result?.ok !== true || !/^[a-f0-9]{64}$/.test(result.baselineHash ?? '')) return { ok: false, step: 'read baseline result', exitCode: 0, output: '' };
    return { ok: true, baselineHash: result.baselineHash, summary: { processes: result.processes, listeners: result.listeners, images: result.images, homeArchiveBytes: result.homeArchiveBytes, ...(Number.isSafeInteger(result.toolcacheArchiveBytes) ? { toolcacheArchiveBytes: result.toolcacheArchiveBytes, packages: result.packages, sysctl: result.sysctl, mounts: result.mounts, firewallRules: result.firewallRules } : {}) } };
  } catch { return { ok: false, step: 'read baseline result', exitCode: 0, output: '' }; }
}

export function parseDockerResetResult(response, generation) {
  if (response?.running === true) return null;
  if (response?.exitCode !== 0) return failure(response, 'reset command');
  if (response?.stdoutTruncated === true || typeof response?.stdout !== 'string' || response.stdout.length > 4096) return { ok: false, step: 'read reset result', exitCode: 0, output: '' };
  try {
    const result = JSON.parse(response.stdout.trim().split('\n').at(-1));
    if (result?.ok !== true || result.gen !== generation) return { ok: false, step: 'read reset result', exitCode: 0, output: '' };
    const { ok, gen, ...summary } = result;
    return { ok: true, summary };
  } catch { return { ok: false, step: 'read reset result', exitCode: 0, output: '' }; }
}
