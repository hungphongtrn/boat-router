import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { REFRESH_PROGRAM } from '../src/refresh.mjs';

function python(body) {
  const source = REFRESH_PROGRAM.split("if __name__ == '__main__':")[0];
  const result = spawnSync('python3', ['-I', '-B', '-c', source + '\n' + body], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

const fixtures = String.raw`
import copy
def addresses(valid=1200, preferred=600):
    return [{'ifindex': 2, 'ifname': 'eth0', 'flags': ['BROADCAST', 'UP', 'LOWER_UP'], 'mtu': 1500,
             'addr_info': [{'family': 'inet', 'local': '192.0.2.10', 'prefixlen': 24, 'scope': 'global',
                            'valid_life_time': valid, 'preferred_life_time': preferred}]}]
def network(values, sample=(100.0, 100.02), firewall='*filter\n:INPUT ACCEPT [0:0]\nCOMMIT'):
    sections = [json.dumps(values), '[{"dst":"default","gateway":"192.0.2.1","dev":"eth0"}]', firewall]
    if sample is not None:
        sections.append({'addressSample': list(sample)})
    return sections
def changed(before, after):
    return differences({'network': before}, {'network': after})
`;

test('the clean network comparison accepts measured lifetime countdown without changing the baseline', () => {
  python(fixtures + String.raw`
before = network(addresses())
saved = json.dumps(before)
after = network(addresses(1130, 530), (170.03, 170.05))
assert changed(before, after) == []
assert json.dumps(before) == saved
after[0] = json.dumps(addresses(1130, 530)).replace('192.0.2.10', '192.0.2.11')
assert changed(before, after) == ['network']
`);
});

test('integer lifetime rounding is bounded and lease changes still fail', () => {
  python(fixtures + String.raw`
before = network(addresses(), (100.99, 101.01))
assert changed(before, network(addresses(1131, 531), (170.01, 170.03))) == []
for valid, preferred in ((1133, 533), (1127, 527), (1200, 600), (1131, 0), (4294967295, 4294967295)):
    assert changed(before, network(addresses(valid, preferred), (170.01, 170.03))) == ['network']
expired = network(addresses(4294967295, 0))
assert changed(expired, network(addresses(4294967295, 0), (170.0, 170.02))) == []
assert changed(expired, network(addresses(1200, 0), (170.0, 170.02))) == ['network']
`);
});

test('address configuration routes and firewall rules remain strict', () => {
  python(fixtures + String.raw`
before = network(addresses())
after = network(addresses(1130, 530), (170.03, 170.05))
assert changed(before, after) == []
for field, value in (('ifindex', 3), ('ifname', 'eth1'), ('mtu', 1400), ('flags', ['BROADCAST', 'UP'])):
    edited = copy.deepcopy(after)
    values = json.loads(edited[0]); values[0][field] = value; edited[0] = json.dumps(values)
    assert changed(before, edited) == ['network'], field
for field, value in (('prefixlen', 16), ('scope', 'link'), ('local', '192.0.2.12'), ('family', 'inet6')):
    edited = copy.deepcopy(after)
    values = json.loads(edited[0]); values[0]['addr_info'][0][field] = value; edited[0] = json.dumps(values)
    assert changed(before, edited) == ['network'], field
edited = copy.deepcopy(after); edited[1] = edited[1].replace('192.0.2.1', '192.0.2.2')
assert changed(before, edited) == ['network']
edited = copy.deepcopy(after); edited[2] = edited[2].replace('ACCEPT', 'DROP')
assert changed(before, edited) == ['network']
`);
});

test('firewall chain counters are observation data while quoted rule comments remain checked', () => {
  python(fixtures + String.raw`
first = '*filter\n:INPUT ACCEPT [1:64]\n-A INPUT -m comment --comment "[7:8]" -j ACCEPT\nCOMMIT'
second = '*filter\n:INPUT ACCEPT [100:6400]\n-A INPUT -m comment --comment "[7:8]" -j ACCEPT\nCOMMIT'
assert changed(network(addresses(), firewall=first), network(addresses(), firewall=second)) == []
assert firewall_rules(first) == '*filter\n:INPUT ACCEPT [0:0]\n-A INPUT -m comment --comment "[7:8]" -j ACCEPT\nCOMMIT'
altered_comment = second.replace('"[7:8]"', '"[9:10]"')
assert changed(network(addresses(), firewall=first), network(addresses(), firewall=altered_comment)) == ['network']
altered_rule = second.replace('-j ACCEPT', '-j DROP')
assert changed(network(addresses(), firewall=first), network(addresses(), firewall=altered_rule)) == ['network']
`);
});

test('finite legacy baselines and invalid sampling metadata fail closed', () => {
  python(fixtures + String.raw`
before = network(addresses())
assert changed(network(addresses(), sample=None), before) == ['network']
for sample in ((-1, 0), (101, 100), (False, 100), (float('inf'), float('inf')), (float('nan'), 100)):
    assert changed(before, network(addresses(), sample)) == ['network']
for value in (-1, 4294967296, True, '1200', None):
    assert changed(before, network(addresses(value, 600))) == ['network']
forever = network(addresses(4294967295, 4294967295), sample=None)
assert changed(forever, network(addresses(4294967295, 4294967295), (170.0, 170.02))) == []
assert changed(before, ['invalid JSON', before[1], before[2], before[3]]) == ['network']
`);
});

test('network capture records the actual address sampling interval and normalized counters', () => {
  python(fixtures + String.raw`
samples = iter((100.0, 100.02))
time.monotonic = lambda: next(samples)
outputs = iter((json.dumps(addresses()), '[]', '# generated timestamp\n*filter\n:INPUT ACCEPT [9:80]\nCOMMIT'))
run = lambda args: next(outputs)
captured = capture_network()
assert captured == [json.dumps(addresses()), '[]', '*filter\n:INPUT ACCEPT [0:0]\nCOMMIT', {'addressSample': [100.0, 100.02]}]
`);
});

test('drift records omit accepted lifetime and counter changes beside an actual leftover', () => {
  python(fixtures + String.raw`
before = {'files': {}, 'network': network(addresses(), firewall='*filter\n:INPUT ACCEPT [1:64]\nCOMMIT')}
after = {'files': {'/etc/leftover': [stat.S_IFREG, 0o644, 0, 0, 'digest']},
         'network': network(addresses(1130, 530), (170.03, 170.05), '*filter\n:INPUT ACCEPT [9:576]\nCOMMIT')}
details = {'processNames': {}, 'sockets': []}
assert differences(before, after) == ['files']
assert drift_entries(before, after, details, details) == [
    {'kind': 'file', 'path': '/etc/leftover', 'change': 'added', 'fields': ['presence']}]
after['network'][1] = after['network'][1].replace('192.0.2.1', '192.0.2.2')
assert differences(before, after) == ['files', 'network']
entries = drift_entries(before, after, details, details)
assert [entry for entry in entries if entry['kind'] == 'network'] == [
    {'kind': 'network', 'section': 'routes', 'change': 'changed', 'fields': ['gateway']}]
`);
});

test('baseline quiescing masks only PackageKit and repeated calls prevent its activation', () => {
  python(String.raw`
states = {'packagekit.service': {'loaded': True, 'active': True, 'masked': False},
          'unrelated.service': {'loaded': True, 'active': True, 'masked': False}}
def commands(args, allowed=(0,)):
    assert args[0] == 'systemctl'
    unit = 'packagekit.service'
    if args[1] == 'show':
        return 'masked' if states[unit]['masked'] else 'loaded'
    if args[1:4] == ['mask', '--runtime', '--now'] and args[4:] == [unit]:
        states[unit]['masked'] = True; states[unit]['active'] = False
        return ''
    if args[1:] == ['is-active', unit]:
        return 'active' if states[unit]['active'] else 'inactive'
    raise AssertionError(args)
run = commands
quiesce_packagekit()
quiesce_packagekit()
if not states['packagekit.service']['masked']:
    states['packagekit.service']['active'] = True
assert states == {'packagekit.service': {'loaded': True, 'active': False, 'masked': True},
                  'unrelated.service': {'loaded': True, 'active': True, 'masked': False}}
`);
});

test('missing PackageKit is optional while an active masked daemon fails closed', () => {
  python(String.raw`
run = lambda args, allowed=(0,): 'not-found'
quiesce_packagekit()
def active(args, allowed=(0,)):
    if args[1] == 'show': return 'loaded'
    if args[1] == 'mask': return ''
    return 'active'
run = active
try:
    quiesce_packagekit()
except RuntimeError as error:
    assert str(error) == 'processes'
else:
    raise AssertionError('An active PackageKit daemon was accepted.')
`);
});

test('idle reclaim uses exact checked runtime conditions and leaves its marker untouched', () => {
  python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    units = root / 'units'; units.mkdir()
    marker = root / 'ascii-idle-reclaim'; marker.write_text('provider marker')
    active = {'ascii-idle-reclaim.timer': True, 'ascii-idle-reclaim.service': True, 'unrelated.service': True}
    condition = {}
    def commands(args, allowed=(0,)):
        assert args[0] == 'systemctl'
        if args[1] == 'daemon-reload': return ''
        unit = args[2]
        if args[1] == 'show':
            if args[3:] == ['--property=LoadState', '--value']: return 'loaded'
            if args[3:] == ['--property=ActiveState', '--value']: return 'active' if active[unit] else 'inactive'
            if args[3:] == ['--property=ConditionResult', '--value']: return 'yes' if condition[unit] else 'no'
        if args[1] == 'stop': active[unit] = False; return ''
        if args[1] == 'start':
            expected = '[Unit]\nConditionPathExists=' + str(STATE / 'idle-reclaim-enabled') + '\n'
            assert (units / (unit + '.d') / 'boat-ci-reuse.conf').read_text() == expected
            condition[unit] = (STATE / 'idle-reclaim-enabled').exists()
            active[unit] = condition[unit]
            return ''
        raise AssertionError(args)
    run = commands
    quiesce_idle_reclaim(units)
    quiesce_idle_reclaim(units)
    assert active == {'ascii-idle-reclaim.timer': False, 'ascii-idle-reclaim.service': False, 'unrelated.service': True}
    assert marker.read_text() == 'provider marker'
    assert not (STATE / 'idle-reclaim-enabled').exists()
    assert sorted(path.name for path in units.iterdir()) == ['ascii-idle-reclaim.service.d', 'ascii-idle-reclaim.timer.d']
`);
});

test('idle reclaim refuses a preexisting enable flag or a condition that did not block starts', () => {
  python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    root = pathlib.Path(directory)
    STATE = root / 'state'; STATE.mkdir()
    flag = STATE / 'idle-reclaim-enabled'; flag.write_text('unexpected')
    try:
        quiesce_idle_reclaim(root / 'units')
    except RuntimeError as error:
        assert str(error) == 'baseline'
    else:
        raise AssertionError('A present reclaim enable flag was accepted.')
    flag.unlink()
    def commands(args, allowed=(0,)):
        if args[1] == 'show':
            if args[3:] == ['--property=LoadState', '--value']: return 'loaded'
            if args[3:] == ['--property=ActiveState', '--value']: return 'inactive'
            return 'yes'
        return ''
    run = commands
    try:
        quiesce_idle_reclaim(root / 'units')
    except RuntimeError as error:
        assert str(error) == 'baseline'
    else:
        raise AssertionError('An ineffective reclaim condition was accepted.')
`);
});

test('process diagnostics retain the name read with a short-lived identity and keep identity drift strict', () => {
  python(String.raw`
import tempfile
with tempfile.TemporaryDirectory() as directory:
    proc = pathlib.Path(directory)
    process = proc / '10'; process.mkdir()
    def write_process(name, started):
        fields = ['S', '1'] + ['0'] * 17 + [str(started)]
        (process / 'stat').write_text('10 (' + name + ') ' + ' '.join(fields))
        (process / 'cmdline').write_bytes(b'synthetic-command\0private-argument\0')
        if not (process / 'exe').is_symlink(): (process / 'exe').symlink_to('/usr/bin/synthetic-command')
    write_process('short-lived', 100)
    before = processes(set(), proc)
    (process / 'stat').unlink()
    assert process_names(before, proc) == {'10': 'short-lived'}
    write_process('replacement', 101)
    after = processes(set(), proc)
    assert process_names(before, proc) == {'10': 'short-lived'}
    assert process_names(after, proc) == {'10': 'replacement'}
    assert differences({'processes': before}, {'processes': after}) == ['processes']
    assert 'private-argument' not in json.dumps(process_names(after, proc))
`);
});
