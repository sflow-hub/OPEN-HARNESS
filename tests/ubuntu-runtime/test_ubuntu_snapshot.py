"""The Ubuntu snapshot helper: live CA bootstrap, the fixed signed snapshot, and the exact repair (fake APT tools)."""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import support

HELPER = support.HELPERS / 'ubuntu-snapshot.sh'
SNAPSHOT = '20260929T180000Z'
CA = 'ca-certificates=20260601~26.04.1'
PINS = f'openssl=3.5.5-1ubuntu3.5\n{CA}\nlibheif1=1.21.2-3ubuntu0.5\n'
BASE = {'libc6': '2.43-2ubuntu2.4', 'libssl3t64': '3.5.5-1ubuntu3.5', 'openssl-provider-legacy': '3.5.5-1ubuntu3.5'}
LIVE = {'libssl3t64': '3.5.5-1ubuntu3.6', 'openssl-provider-legacy': '3.5.5-1ubuntu3.6', 'openssl': '3.5.5-1ubuntu3.6'}
INDEX = ' 500 {uri} {suite}/main amd64 Packages\n     release v=26.04,o=Ubuntu,a={suite},n=resolute,l=Ubuntu,c=main,b=amd64\n'
SUITES = ('resolute', 'resolute-updates', 'resolute-backports', 'resolute-security')


def policy(uri=f'https://snapshot.ubuntu.com/ubuntu/{SNAPSHOT}', extra=''):
    indexes = ''.join(INDEX.format(uri=uri, suite=suite) for suite in SUITES) if uri else ''
    return f'Package files:\n 100 /var/lib/dpkg/status\n     release a=now\n{indexes}{extra}Pinned packages:\n'


# apt-get, apt-cache and dpkg-query over a JSON state: the live install of ca-certificates applies state['live'].
FAKE = '''
import json, os, sys
path = os.environ['FAKE_APT_STATE']
state = json.load(open(path))
tool, args = os.path.basename(sys.argv[0]), sys.argv[1:]
state['calls'].append([tool] + args)
snapshot = os.path.exists(os.path.join(os.environ['OH_APT_ETC'], 'apt.conf.d', '99-open-harness-snapshot'))
code = 0
if tool == 'dpkg-query':
    print(''.join(f'ii  {name} {version}\\n' for name, version in sorted(state['installed'].items())), end='')
elif tool == 'apt-cache':
    print(state['policy'], end='')
elif 'update' in args:
    code = state['update'].get('snapshot' if snapshot else 'live', 0)
elif 'install' in args:
    options = {i + 1 for i, arg in enumerate(args) if arg == '-o'}
    for name, _, version in (arg.partition('=') for i, arg in enumerate(args) if '=' in arg and i not in options):
        if not (snapshot and name in state['ignore']):
            state['installed'][name] = version
        if name == 'ca-certificates' and not snapshot:
            for package, live in state['live'].items():
                state['installed'].pop(package) if live is None else state['installed'].update({package: live})
json.dump(state, open(path, 'w'))
sys.exit(code)
'''


class SnapshotHelper(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir)
        tools = self.dir / 'bin'
        tools.mkdir()
        for name in ('apt-get', 'apt-cache', 'dpkg-query'):
            (tools / name).write_text(f'#!{sys.executable}\n{FAKE}')
            (tools / name).chmod(0o755)
        (self.dir / 'etc/apt.conf.d').mkdir(parents=True)
        self.conf = self.dir / 'etc/apt.conf.d/99-open-harness-snapshot'
        self.env = dict(os.environ, PATH=f'{tools}:{os.environ["PATH"]}', OH_APT_ETC=str(self.dir / 'etc'),
                        FAKE_APT_STATE=str(self.dir / 'state.json'))

    def run_helper(self, snapshot=SNAPSHOT, pins=PINS, live=LIVE, index=None, update=None, ignore=()):
        (self.dir / 'pins.txt').write_text(pins)
        (self.dir / 'state.json').write_text(json.dumps({
            'installed': BASE, 'live': live, 'policy': index or policy(), 'update': update or {}, 'ignore': list(ignore),
            'calls': []}))
        result = subprocess.run(['sh', str(HELPER), snapshot, str(self.dir / 'pins.txt')],
                                capture_output=True, text=True, env=self.env)
        state = json.loads((self.dir / 'state.json').read_text())
        return result, state, [call[1:] for call in state['calls'] if call[0] == 'apt-get']

    def test_bootstrap_changes_are_reinstalled_from_the_snapshot_exactly(self):
        result, state, apt = self.run_helper()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.conf.read_text(), f'APT::Snapshot "{SNAPSHOT}";\nAPT::Update::Error-Mode "any";\n')
        self.assertEqual(apt, [
            ['-o', 'Acquire::Retries=0', '-o', 'APT::Update::Error-Mode=any', 'update'],
            ['install', '-y', '--no-install-recommends', CA],
            ['-o', 'Acquire::Retries=0', 'update'],
            ['install', '-y', '--no-install-recommends', '--allow-downgrades', 'libssl3t64=3.5.5-1ubuntu3.5',
             'openssl-provider-legacy=3.5.5-1ubuntu3.5', 'openssl=3.5.5-1ubuntu3.5']])
        self.assertEqual(state['installed'], {**BASE, 'ca-certificates': '20260601~26.04.1', 'openssl': '3.5.5-1ubuntu3.5'})
        self.assertIn(f'APT::Snapshot {SNAPSHOT}; 3 package(s) reinstalled', result.stdout)

    def test_nothing_is_reinstalled_when_the_bootstrap_only_adds_its_pin(self):
        result, state, apt = self.run_helper(live={})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(apt), 3)
        self.assertEqual(state['installed'], {**BASE, 'ca-certificates': '20260601~26.04.1'})

    def test_indexes_outside_the_snapshot_are_refused_before_the_repair(self):
        live_index = INDEX.format(uri='http://archive.ubuntu.com/ubuntu', suite='resolute')
        for index, message in ((policy(extra=live_index), 'not from the snapshot:  500 http://archive.ubuntu.com/ubuntu resolute/main'),
                               (policy(uri='https://snapshot.ubuntu.com/ubuntu/20260930T000000Z'), 'not from the snapshot'),
                               (policy(uri=''), 'APT has no package indexes')):
            with self.subTest(message=message):
                self.conf.unlink(missing_ok=True)
                result, _, apt = self.run_helper(index=index)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual(len(apt), 3)

    def test_unexpected_bootstrap_changes_are_refused_before_the_repair(self):
        for live, message in (({**LIVE, 'libfoo1': '1.0-1'}, 'installed libfoo1, which the OS package list does not pin'),
                              ({**LIVE, 'libc6': None}, 'the CA bootstrap removed libc6')):
            with self.subTest(message=message):
                self.conf.unlink(missing_ok=True)
                result, _, apt = self.run_helper(live=live)
                self.assertEqual(result.returncode, 1)
                self.assertIn(message, result.stderr)
                self.assertEqual(len(apt), 3)

    def test_repair_must_reach_the_base_state_plus_the_pins(self):
        result, state, _ = self.run_helper(ignore=('libssl3t64',))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(state['installed']['libssl3t64'], '3.5.5-1ubuntu3.6')
        self.assertIn('not the base state plus the pins', result.stderr)

    def test_failed_snapshot_update_stops_the_step(self):
        result, _, apt = self.run_helper(update={'snapshot': 100})
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(apt), 3)

    def test_bad_arguments_are_refused_before_any_apt_call(self):
        cases = [('latest', PINS, 'is not YYYYMMDDTHHMMSSZ'), (SNAPSHOT, 'openssl=3.5.5-1ubuntu3.5\n', 'exactly once'),
                 (SNAPSHOT, PINS + CA + '\n', 'exactly once')]
        for snapshot, pins, message in cases:
            with self.subTest(message=message, snapshot=snapshot):
                result, _, apt = self.run_helper(snapshot=snapshot, pins=pins)
                self.assertEqual((result.returncode, apt), (1, []))
                self.assertIn(message, result.stderr)
        self.conf.write_text('')
        result, _, apt = self.run_helper()
        self.assertEqual((result.returncode, apt), (1, []))
        self.assertIn('already exists', result.stderr)

    def test_signature_checks_are_not_relaxed(self):
        text = HELPER.read_text()
        for forbidden in ('allow-unauthenticated', 'trusted', 'insecure', 'check-valid-until', 'force-yes', 'verify-peer',
                          'cainfo', '--no-check'):
            self.assertNotIn(forbidden, text.lower())
        self.assertEqual(text.count('--allow-downgrades'), 1)
        self.assertIn('--allow-downgrades < "$work/repair"', text)


if __name__ == '__main__':
    unittest.main()
