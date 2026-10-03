"""Offline tests of scripts/debian-origin-gate.py, the supplemental Debian-origin release gate.

Simulated (fakes/fake_docker.py and fakes/fake_trivy.py): the Docker daemon and CLI (version, image inspect,
container inspect and removal, run), the probe containers (the reviewed helper runs on this host with in-image paths
mapped to a synthetic Ubuntu root and the three bind mounts mapped to their sources), the scanner and its database.
Real: the gate, every reviewed helper (inside the simulated probes and for each host-side check), real-format
synthetic .deb archives, the build-time inventory written by debian_origin.record, and the publication validator in
scripts/release-images.mjs (through node, when node is installed).

Nothing here contacts Docker, a registry or the network. The real Docker CLI is never called: every run passes
--docker <fake>. Timeout, deadline, collision and non-root-caller cases run the gate in this process to shorten its
timeouts, fix its nonce or report another user ID.
Real Docker, Trivy, databases, images and CI behaviour remain for root to validate natively.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import platform
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import types
import unittest
from pathlib import Path
from unittest import mock

import support
from support import ohpkg

import debian_origin
from test_debian_origin import DEBIAN_OS_RELEASE, UBUNTU_EXCLUDES

GATE = support.REPO / 'scripts' / 'debian-origin-gate.py'
RELEASE_IMAGES = support.REPO / 'scripts' / 'release-images.mjs'
READINESS = support.REPO / 'runtime' / 'readiness.ts'
FAKES = support.HERE / 'fakes'
NATIVE = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}
ARCH = NATIVE.get(platform.machine().lower())
OTHER_ARCH = {'arm64': 'amd64', 'amd64': 'arm64'}.get(ARCH)
IMAGE, OTHER_IMAGE = 'sha256:' + 'ab' * 32, 'sha256:' + 'cd' * 32
DOCKER_HOST = 'unix:///var/run/docker.sock'
PROBE_LABEL = 'dev.openharness.debian-origin-gate'
# As root the gate needs an explicit non-root probe user; otherwise the probes run as the invoking user.
PROBE_USER = '1000:1000' if os.getuid() == 0 else f'{os.getuid()}:{os.getgid()}'
STEPS = ['probe-component-root', 'probe-bind', 'component-scan', 'check-component', 'component-sbom', 'check-sbom',
         'sbom-scan', 'check-sbom-scan', 'make-negative', 'negative-scan', 'check-negative', 'image-scan', 'check-image']
CHILD_ENV = {'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'DOCKER_CONFIG', 'PYTHONDONTWRITEBYTECODE'}
SHELL_ENV = {'PWD', 'OLDPWD', 'SHLVL', '_'}  # set by the /bin/sh wrappers around the fakes
NODE = shutil.which('node')
FOREIGN = {  # containers this invocation did not create; the gate must never touch them
    'f1' * 32: {'Id': 'f1' * 32, 'Name': '/oh-debian-origin-gate-0000000000000000-probe-component-root', 'Image': IMAGE,
                'Config': {'Image': IMAGE, 'Labels': {PROBE_LABEL: '0000000000000000'}}, 'State': {'Running': True}},
    'f2' * 32: {'Id': 'f2' * 32, 'Name': '/open-harness-hermes', 'Image': IMAGE, 'Config': {'Image': IMAGE, 'Labels': {}},
                'State': {'Running': True}},
}


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_gate(path):
    spec = importlib.util.spec_from_file_location(f'debian_origin_gate_{time.monotonic_ns()}', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def contains(sequence, part):
    return any(sequence[i:i + len(part)] == part for i in range(len(sequence) - len(part) + 1))


def install(root, contents, lock, arch):
    """dpkg installing the synthetic Debian packages into an Ubuntu root under its path policy, for any architecture."""
    rules = ohpkg.dpkg_path_rules(root / 'etc/dpkg/dpkg.cfg.d')
    for content in contents.values():
        for path, data in content['files'].items():
            if ohpkg.path_installed_by_policy(path, rules):
                target = root / path.lstrip('/')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        for path, link in content['links'].items():
            target = root / path.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(link)
    paragraphs = [f'Package: base-files\nStatus: install ok installed\nArchitecture: {arch}\nVersion: 14ubuntu1\n']
    for name, record in lock['debian']['packages'][arch].items():
        source = f'Source: {record["Source"]}\n' if 'Source' in record else ''
        paragraphs.append(f'Package: {name}\nStatus: install ok installed\n{source}Architecture: {arch}\n'
                          f'Version: {record["Version"]}\nDescription: synthetic\n')
    (root / 'var/lib/dpkg').mkdir(parents=True, exist_ok=True)
    (root / 'var/lib/dpkg/status').write_text('\n'.join(paragraphs))


class Fixture:
    """A checkout copy, a synthetic verified Hermes image root, a scanner database and the two fake CLIs."""

    def __init__(self, test, arch=ARCH):
        self.dir = Path(tempfile.mkdtemp(prefix='oh-debian-gate-'))
        test.addCleanup(shutil.rmtree, self.dir, True)
        self.arch = arch
        self.repo, self.root, self.bin, self.cache = (self.dir / n for n in ('repo', 'image-root', 'bin', 'trivy-cache'))
        self.out = self.dir / 'out'
        # The checkout inputs the gate hashes: gate, helpers, lock files, Dockerfile, readiness.
        (self.repo / 'scripts').mkdir(parents=True)
        shutil.copy2(GATE, self.repo / 'scripts/debian-origin-gate.py')
        shutil.copytree(support.HELPERS, self.repo / 'runtime/ubuntu/helpers', ignore=shutil.ignore_patterns('__pycache__'))
        (self.repo / 'runtime/ubuntu/lock').mkdir(parents=True)
        shutil.copy2(support.OS_PACKAGES, self.repo / 'runtime/ubuntu/lock/ubuntu-os-packages.txt')
        (self.repo / 'runtime/hermes').mkdir(parents=True)
        shutil.copy2(READINESS, self.repo / 'runtime/readiness.ts')
        # The image: an Ubuntu root with the Debian packages installed, their retained archives and the inventory.
        packages = self.root / 'opt/open-harness/debian-browser/packages'
        self.lock, self.contents = support.synthetic_debian(packages, arch)
        self.lock_path = self.repo / 'runtime/ubuntu/lock/runtime-inputs.lock.json'
        support.write_lock(self.lock, self.lock_path)
        dockerfile, pinned = support.DOCKERFILE.read_text(encoding='utf-8'), sha256(support.LOCK)
        assert dockerfile.count(pinned) == 1, 'the Dockerfile pins the committed lock once'
        (self.repo / 'runtime/hermes/Dockerfile').write_text(dockerfile.replace(pinned, sha256(self.lock_path)), encoding='utf-8')
        (self.root / 'etc/dpkg/dpkg.cfg.d').mkdir(parents=True)
        (self.root / 'etc/dpkg/dpkg.cfg.d/excludes').write_text(UBUNTU_EXCLUDES)
        (self.root / 'usr/lib').mkdir(parents=True)
        (self.root / 'usr/lib/os-release').write_text('PRETTY_NAME="Ubuntu 26.04 LTS"\nNAME="Ubuntu"\nVERSION_ID="26.04"\nID=ubuntu\n')
        (self.root / 'etc/os-release').symlink_to('../usr/lib/os-release')
        (self.root / 'lib').symlink_to('usr/lib')
        install(self.root, self.contents, self.lock, arch)
        debian = self.dir / 'debian-os'  # the build's Debian input stage; not part of the image
        debian.mkdir()
        (debian / 'os-release').write_text(DEBIAN_OS_RELEASE)
        (debian / 'debian_version').write_text('13.7\n')
        inventory = debian_origin.record(self.lock, arch, self.root, packages, debian / 'os-release', debian / 'debian_version')
        ohpkg.write_json(self.root / 'opt/open-harness/verification/debian-origin-inventory.json', inventory)
        # Scanner database, with a stale scan cache beside it that must never be used.
        (self.cache / 'db').mkdir(parents=True)
        (self.cache / 'db/trivy.db').write_bytes(os.urandom(4096))
        self.metadata = {'Version': 2, 'NextUpdate': '2026-09-30T00:00:00Z', 'UpdatedAt': '2026-09-29T00:00:00Z',
                         'DownloadedAt': '2026-09-29T01:00:00Z'}
        (self.cache / 'db/metadata.json').write_text(json.dumps(self.metadata))
        (self.cache / 'fanal').mkdir()
        (self.cache / 'fanal/fanal.db').write_bytes(b'stale scan cache')
        # The fake CLIs, each copied beside its state file and wrapped as an executable.
        self.bin.mkdir()
        for name in ('docker', 'trivy'):
            shutil.copy2(FAKES / f'fake_{name}.py', self.bin / f'fake_{name}.py')
            wrapper = self.bin / name
            wrapper.write_text(f"#!/bin/sh\nexec '{sys.executable}' -I -B '{self.bin / f'fake_{name}.py'}' \"$@\"\n")
            wrapper.chmod(0o755)
        self.inspect = {'Id': IMAGE, 'RepoTags': ['open-harness-hermes:release-candidate'], 'RepoDigests': [], 'Os': 'linux',
                        'Architecture': arch, 'Created': '2026-09-29T00:00:00Z',
                        'Config': {'User': 'hermes', 'Labels': {'dev.openharness.runtime': '7',
                                                                'org.opencontainers.image.revision': 'a' * 40}},
                        'RootFS': {'Type': 'layers', 'Layers': ['sha256:' + '1' * 64]}}
        self.state = {'arch': arch, 'os': 'linux', 'dockerHost': DOCKER_HOST, 'python': sys.executable, 'lock': str(self.lock_path),
                      'sourceCache': str(self.cache), 'images': {IMAGE: {'inspect': self.inspect, 'root': str(self.root)}},
                      'containers': json.loads(json.dumps(FOREIGN)), 'scenario': {}}
        self.save()

    def save(self):
        (self.bin / 'fake-state.json').write_text(json.dumps(self.state, indent=2), encoding='utf-8')

    def load(self):
        return json.loads((self.bin / 'fake-state.json').read_text(encoding='utf-8'))

    def scenario(self, steps):
        self.state['scenario'] = steps
        self.save()

    def log(self, name):
        path = self.bin / f'{name}-log.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def docker_calls(self):
        return [entry['argv'] for entry in self.log('docker') if 'argv' in entry]

    def probe_runs(self):
        return [entry for entry in self.log('docker') if 'probe' in entry]

    def scans(self):
        return [entry['argv'] for entry in self.log('trivy') if entry['argv'][0] != 'version']

    def argv(self, extra=(), image=IMAGE, arch=None, out=None):
        return ['--image', image, '--arch', arch or self.arch, '--trivy', str(self.bin / 'trivy'), '--cache-dir', str(self.cache),
                '--out', str(out or self.out), '--docker', str(self.bin / 'docker'), '--probe-user', PROBE_USER, *extra]

    def run(self, *extra, env=None, cwd=None, image=IMAGE, arch=None, out=None):
        command = [sys.executable, '-I', '-B', str(self.repo / 'scripts/debian-origin-gate.py'), *self.argv(extra, image, arch, out)]
        environment = env if env is not None else {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8'}
        return subprocess.run(command, capture_output=True, text=True, env=environment, cwd=cwd or self.dir, timeout=600)

    def run_in_process(self, *extra, timeouts=None, nonce=None, before=None, prepare=None):
        module = load_gate(self.repo / 'scripts/debian-origin-gate.py')
        if prepare:
            prepare(module)
        if timeouts:
            module.TIMEOUTS = dict(module.TIMEOUTS, **timeouts)
        if nonce:
            module.secrets = types.SimpleNamespace(token_hex=lambda _: nonce)
        gate = module.Gate(module.parse(self.argv(extra)))
        if before:
            before(gate)
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            code = gate.execute()
        return code, gate

    def read(self, name):
        return json.loads((self.out / name).read_text(encoding='utf-8'))

    def expected_sources(self):
        files = {}
        for relative in ('scripts/debian-origin-gate.py', 'runtime/hermes/Dockerfile', 'runtime/readiness.ts'):
            files[relative] = sha256(self.repo / relative)
        for directory in ('runtime/ubuntu/helpers', 'runtime/ubuntu/lock'):
            for path in (self.repo / directory).rglob('*'):
                if path.is_file() and '__pycache__' not in path.parts:
                    files[path.relative_to(self.repo).as_posix()] = sha256(path)
        return files


@unittest.skipIf(os.name == 'nt' or ARCH is None, 'the fake CLIs are POSIX scripts and the gate needs a native arm64/amd64 host')
class GateCase(unittest.TestCase):
    maxDiff = None

    def fixture(self, **kwargs):
        return Fixture(self, **kwargs)

    def assertFailed(self, fixture, result, message, step=None, work_kept=False):
        """A failed gate: exit 1, the error in failure.json and stderr, no receipt, the failing step named."""
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        failure = fixture.read('failure.json')
        self.assertIn(message, failure['error'])
        self.assertIn(message, result.stderr)
        self.assertEqual(failure['failedStep'], step)
        self.assertFalse((fixture.out / 'receipt.json').exists())
        self.assertFalse(fixture.read('status.json')['ok'])
        self.assertEqual((fixture.out / 'work').exists(), work_kept, 'the private database copy and component root are removed')
        return failure

    def assertNoContainerOrScan(self, fixture):
        self.assertEqual(fixture.probe_runs(), [])
        self.assertEqual(fixture.scans(), [])

    def assertForeignUntouched(self, fixture):
        containers = fixture.load()['containers']
        for identifier, container in FOREIGN.items():
            self.assertEqual(containers.get(identifier), container)
        self.assertFalse([argv for argv in fixture.docker_calls() if argv[2:4] == ['rm', '--force'] and argv[4] in FOREIGN])

    def assertRecordedSteps(self, fixture, names, codes):
        steps = fixture.read('status.json')['steps']
        self.assertEqual([s['name'] for s in steps], names)
        self.assertEqual([s['returncode'] for s in steps], codes)
        for entry in steps:
            for stream in ('stdout', 'stderr'):
                self.assertEqual(sha256(fixture.out / entry[stream]['path']), entry[stream]['sha256'])
            for path, digest in entry['outputs'].items():
                self.assertEqual(sha256(fixture.out / path) if (fixture.out / path).exists() else None, digest)
        return steps


class GateSuccess(GateCase):
    def test_success_binds_image_sources_scanner_and_database(self):
        fixture = self.fixture()
        result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = fixture.read('receipt.json')
        self.assertEqual(json.loads(result.stdout)['receipt'], str(fixture.out / 'receipt.json'))
        self.assertFalse((fixture.out / 'failure.json').exists())
        self.assertTrue(fixture.read('status.json')['ok'])
        self.assertEqual((receipt['schema'], receipt['ok'], receipt['architecture']), ('open-harness-debian-origin-gate/1', True, fixture.arch))
        # Image: the exact ID, native architecture and runtime contract, as docker image inspect reported it.
        self.assertEqual((receipt['image']['id'], receipt['image']['architecture'], receipt['image']['labels']['dev.openharness.runtime']),
                         (IMAGE, fixture.arch, '7'))
        self.assertEqual(receipt['host']['docker']['Arch'], fixture.arch)
        # Sources, scanner and database identities, unchanged across the gate; the stale scan cache is never copied.
        self.assertEqual(receipt['sources']['files'], fixture.expected_sources())
        self.assertEqual(receipt['sources']['runtimeContract'], '7')
        self.assertEqual(receipt['scanner']['sha256'], sha256(fixture.bin / 'trivy'))
        self.assertEqual(receipt['scanner']['version']['VulnerabilityDB'], fixture.metadata)
        database = receipt['database']
        self.assertEqual(sorted(database['sourceBefore']), ['db/metadata.json', 'db/trivy.db'])
        self.assertEqual(database['sourceBefore']['db/trivy.db'], sha256(fixture.cache / 'db/trivy.db'))
        for key in ('usedBefore', 'sourceAfter', 'usedAfter'):
            self.assertEqual(database[key], database['sourceBefore'], key)
        self.assertEqual(database['metadata'], fixture.metadata)
        # Thirteen steps in order with their expected exit codes; every stream and report retained and hashed.
        steps = self.assertRecordedSteps(fixture, STEPS, [1 if name == 'negative-scan' else 0 for name in STEPS])
        self.assertEqual([s['name'] for s in receipt['steps']], STEPS)
        self.assertEqual({s['name']: s['expectedReturncode'] for s in receipt['steps']}['negative-scan'], 1)
        self.assertEqual(receipt['steps'], [{k: s[k] for k in receipt['steps'][0]} for s in steps])
        self.assertEqual(sorted(p for s in receipt['steps'] for p in s['outputs']),
                         ['reports/component-scan.json', 'reports/component.cdx.json', 'reports/control.cdx.json',
                          'reports/image-scan.json', 'reports/negative-scan.json', 'reports/sbom-scan.json'])
        for call in receipt['calls']:
            self.assertEqual(sha256(fixture.out / call['stdout']['path']), call['stdout']['sha256'])
        # Each report names exactly what it was asked to scan.
        component = str(fixture.out / 'work/probe/component')
        self.assertEqual(receipt['reports'], {
            'component-scan': {'artifactName': component, 'artifactType': 'filesystem'},
            'component-sbom': {'bomFormat': 'CycloneDX', 'componentName': component},
            'sbom-scan': {'artifactName': str(fixture.out / 'reports/component.cdx.json'), 'artifactType': 'cyclonedx'},
            'negative-scan': {'artifactName': str(fixture.out / 'reports/control.cdx.json'), 'artifactType': 'cyclonedx'},
            'image-scan': {'artifactName': IMAGE, 'artifactType': 'container_image', 'imageId': IMAGE, 'os': 'linux',
                           'architecture': fixture.arch}})
        # Component bound to the image inventory; checks and the negative control.
        debian = sorted(fixture.lock['debian']['packages'][fixture.arch])
        probe = receipt['probe']
        self.assertEqual((probe['user'], probe['bind']['architecture'], probe['bind']['packages']), (PROBE_USER, fixture.arch, debian))
        self.assertEqual((probe['bind']['files'], probe['bind']['omittedByPolicy'], probe['bind']['links']), (9, 2, 2))
        self.assertEqual(probe['componentRoot']['files'], 11)
        self.assertEqual(receipt['checks']['check-component'], {'architecture': fixture.arch, 'packages': debian, 'vulnerabilities': 0, 'secrets': 0})
        self.assertEqual(receipt['checks']['check-image']['packages'], len(fixture.lock['finalPackages'][fixture.arch]))
        self.assertEqual(receipt['checks']['check-image']['debianOriginSeenAsUbuntu'], debian)
        self.assertEqual(receipt['negativeControl'], {'source': 'chromium', 'version': support.OLDER_CHROMIUM, 'severeFindings': 4, 'ids': 2})
        # Probes: two containers of this run, each gone afterwards; nothing else touched.
        nonce = receipt['nonce']
        self.assertEqual(probe['containers'], [{'container': f'oh-debian-origin-gate-{nonce}-{name}', 'action': 'absent'}
                                               for name in ('probe-component-root', 'probe-bind')])
        self.assertEqual({k for k in fixture.load()['containers']}, set(FOREIGN))
        self.assertForeignUntouched(fixture)
        self.assertFalse((fixture.out / 'work').exists())

    def test_probe_containers_are_read_only_offline_non_root_and_see_only_their_mounts(self):
        fixture = self.fixture()
        padded = ':'.join('0' + part for part in PROBE_USER.split(':'))  # recorded and used in canonical form
        result = fixture.run('--probe-user', padded)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(fixture.read('receipt.json')['probe']['user'], PROBE_USER)
        runs = fixture.probe_runs()
        self.assertEqual([run['probe'] for run in runs], ['probe-component-root', 'probe-bind'])
        nonce = fixture.read('receipt.json')['nonce']
        for run in runs:
            options = run['options']
            self.assertEqual(run['image'], IMAGE)
            for flag in ('--rm', '--read-only'):
                self.assertIs(options[flag], True)
            for flag, value in (('--network', 'none'), ('--cap-drop', 'ALL'), ('--security-opt', 'no-new-privileges'),
                                ('--user', PROBE_USER), ('--pull', 'never'), ('--entrypoint', '/usr/local/bin/python3'),
                                ('--workdir', '/out'), ('--pids-limit', '256'), ('--memory', '3g')):
                self.assertEqual(options[flag], [value], flag)
            self.assertFalse({'--privileged', '--cap-add', '--volume', '--volumes-from', '--device', '--ipc', '--pid'} & set(options))
            self.assertEqual(run['labels'], {PROBE_LABEL: nonce})
            self.assertEqual(sorted((m['dst'], m['src'], m.get('readonly', False), m['type']) for m in run['mounts']), sorted([
                ('/gate/helpers', str(fixture.repo / 'runtime/ubuntu/helpers'), True, 'bind'),
                ('/gate/lock', str(fixture.repo / 'runtime/ubuntu/lock'), True, 'bind'),
                ('/out', str(fixture.out / 'work/probe'), False, 'bind')]))
            self.assertEqual(run['command'][:5], ['-I', '-B', '-X', 'pycache_prefix=/gate/no-pycache', '/gate/helpers/debian_origin.py'])
        self.assertEqual(runs[0]['command'][5:], ['component-root', '--lock', '/gate/lock/runtime-inputs.lock.json', '--arch', fixture.arch,
                                                  '--packages', '/opt/open-harness/debian-browser/packages', '--inventory',
                                                  '/opt/open-harness/verification/debian-origin-inventory.json', '--out', '/out/component'])
        self.assertEqual(runs[1]['command'][5:], ['bind', '--lock', '/gate/lock/runtime-inputs.lock.json', '--arch', fixture.arch,
                                                  '--inventory', '/opt/open-harness/verification/debian-origin-inventory.json',
                                                  '--image-root', '/', '--component-root', '/out/component'])
        # Every Docker call names the daemon explicitly; only these subcommands are used.
        for argv in fixture.docker_calls():
            self.assertEqual(argv[:2], ['--host', DOCKER_HOST])
        self.assertEqual({tuple(argv[2:4]) if argv[2] in ('image', 'inspect', 'rm') else (argv[2],) for argv in fixture.docker_calls()},
                         {('version',), ('image', 'inspect'), ('run',), ('inspect', '--type')})

    def test_scanner_commands_keep_every_threshold_and_use_only_the_private_database(self):
        fixture = self.fixture()
        result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        private = str(fixture.out / 'work/trivy-cache')
        common = ['--cache-dir', private, '--skip-db-update', '--offline-scan', '--disable-telemetry', '--skip-version-check',
                  '--config', '/dev/null']
        thresholds = ['--list-all-pkgs', '--severity', 'HIGH,CRITICAL', '--ignorefile', '/dev/null', '--exit-code', '1', '--format', 'json']
        scans = fixture.scans()
        self.assertEqual([argv[0] for argv in scans], ['rootfs', 'rootfs', 'sbom', 'sbom', 'image'])
        for index, argv in enumerate(scans):
            self.assertTrue(contains(argv, common), argv)
            self.assertFalse({'--skip-dirs', '--skip-files', '--ignore-unfixed', '--ignore-policy', '--vex', '--ignored-licenses'} & set(argv))
            self.assertNotIn(str(fixture.cache), argv)
            if index != 1:  # every scan except the CycloneDX export judges findings at HIGH/CRITICAL with exit code 1
                self.assertTrue(contains(argv, thresholds), argv)
        self.assertTrue(contains(scans[1], ['--format', 'cyclonedx']))
        self.assertTrue(contains(scans[0], ['--scanners', 'vuln,secret']) and contains(scans[4], ['--scanners', 'vuln,secret']))
        self.assertEqual(scans[4][:3], ['image', '--image-src', 'docker'])
        self.assertEqual(scans[4][-1], IMAGE)
        self.assertEqual(scans[3][-1], str(fixture.out / 'reports/control.cdx.json'))
        for entry in fixture.log('trivy'):
            self.assertEqual(entry['cwd'], str(fixture.out / 'work/cwd'))
            self.assertEqual(entry['home'], str(fixture.out / 'work/home'))
            self.assertEqual(entry['dockerHost'], DOCKER_HOST if entry['argv'][0] == 'image' else None)

    def test_leaked_probe_is_removed_by_its_own_identity_only(self):
        fixture = self.fixture()
        fixture.scenario({'probe-component-root': 'leak'})
        result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = fixture.read('receipt.json')
        leaked = next(run['container'] for run in fixture.probe_runs() if run['probe'] == 'probe-component-root')
        self.assertEqual(receipt['probe']['containers'][0], {'container': f'oh-debian-origin-gate-{receipt["nonce"]}-probe-component-root',
                                                              'id': leaked, 'action': 'removed'})
        self.assertEqual([argv for argv in fixture.docker_calls() if argv[2] == 'rm'], [['--host', DOCKER_HOST, 'rm', '--force', leaked]])
        self.assertEqual(set(fixture.load()['containers']), set(FOREIGN))
        self.assertForeignUntouched(fixture)

    def test_hostile_environment_working_directory_and_configuration_are_ignored(self):
        fixture = self.fixture()
        hostile = fixture.dir / 'hostile'
        hostile.mkdir()
        marker = fixture.dir / 'hostile-code-ran'
        payload = f'open({str(marker)!r}, "w").write("ran")\n'
        for name in ('ohpkg.py', 'debian_origin.py', 'json.py', 'sitecustomize.py', 'startup.py'):
            (hostile / name).write_text(payload)
        (hostile / 'trivy.yaml').write_text('severity: LOW\nexit-code: 0\nscan:\n  skip-dirs: ["/"]\n')
        (hostile / '.trivyignore').write_text('CVE-2026-1001\nCVE-2026-1002\n')
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8', 'HOME': str(hostile),
               'TRIVY_SEVERITY': 'LOW', 'TRIVY_EXIT_CODE': '0', 'TRIVY_IGNOREFILE': str(hostile / '.trivyignore'),
               'TRIVY_CONFIG': str(hostile / 'trivy.yaml'), 'TRIVY_CACHE_DIR': str(hostile), 'TRIVY_SKIP_DIRS': '/',
               'TRIVY_SCANNERS': 'license', 'TRIVY_IGNORE_UNFIXED': 'true', 'DOCKER_HOST': 'tcp://127.0.0.1:9',
               'DOCKER_CONFIG': str(hostile), 'DOCKER_CONTEXT': 'hostile', 'HTTPS_PROXY': 'http://127.0.0.1:9',
               'https_proxy': 'http://127.0.0.1:9', 'PYTHONPATH': str(hostile), 'PYTHONSTARTUP': str(hostile / 'startup.py'),
               'PYTHONINSPECT': '', 'PYTHONWARNINGS': 'error'}
        result = fixture.run(env=env, cwd=hostile)
        self.assertEqual(result.returncode, 0, result.stderr)  # the fake scanner refuses any inherited TRIVY_* variable
        self.assertFalse(marker.exists(), 'no hostile module or startup file ran')
        for entry in fixture.log('trivy'):
            allowed = CHILD_ENV | ({'DOCKER_HOST'} if entry['argv'][0] == 'image' else set())
            self.assertLessEqual(set(entry['env']) - SHELL_ENV, allowed, entry['argv'][0])
            self.assertEqual(entry['cwd'], str(fixture.out / 'work/cwd'))
            if entry['argv'][0] == 'image':
                self.assertEqual(entry['dockerHost'], DOCKER_HOST)
        for entry in fixture.log('docker'):
            if 'argv' in entry:
                self.assertLessEqual(set(entry['env']) - SHELL_ENV, CHILD_ENV)
                self.assertIsNone(entry['dockerHost'])
                self.assertEqual(entry['dockerConfig'], str(fixture.out / 'work/docker-config'))
                self.assertEqual(entry['argv'][:2], ['--host', DOCKER_HOST])

    @unittest.skipUnless(NODE, 'node is not installed; tests/debian-origin-gate.test.ts covers the validator on its own')
    def test_publication_validator_accepts_this_receipt_and_refuses_altered_evidence(self):
        fixture = self.fixture()
        result = fixture.run()
        self.assertEqual(result.returncode, 0, result.stderr)

        def verify(directory, image=IMAGE):
            return subprocess.run([NODE, str(RELEASE_IMAGES), 'verify-debian-origin-gate', str(directory), fixture.arch, image],
                                  capture_output=True, text=True, cwd=fixture.repo, timeout=120,
                                  env={'PATH': os.environ.get('PATH', '/usr/bin:/bin')})
        accepted = verify(fixture.out)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        summary = json.loads(accepted.stdout)
        self.assertEqual((summary['image'], summary['architecture'], summary['receiptSha256']),
                         (IMAGE, fixture.arch, sha256(fixture.out / 'receipt.json')))
        self.assertEqual(summary['negativeControl'], {'severeFindings': 4, 'ids': 2})
        self.assertIn('another image', verify(fixture.out, OTHER_IMAGE).stderr)
        altered = fixture.dir / 'altered'
        shutil.copytree(fixture.out, altered)
        report = altered / 'reports/image-scan.json'
        report.write_text(report.read_text().replace('"Results"', '"Results" ', 1))
        self.assertIn('changed after the gate', verify(altered).stderr)
        (fixture.repo / 'runtime/ubuntu/helpers/debian_origin.py').write_text('# changed after the gate\n', encoding='utf-8')
        self.assertIn('other gate, helper, lock, Dockerfile or readiness sources', verify(fixture.out).stderr)


class GateRefusesBeforeAnyContainer(GateCase):
    def test_mutable_absent_or_foreign_image_is_refused(self):
        cases = [
            ('open-harness-hermes:release-candidate', None, 'is not an immutable local image ID'),
            ('sha256:' + 'AB' * 32, None, 'is not an immutable local image ID'),
            (OTHER_IMAGE, None, 'image-inspect: docker exited 1'),
            (OTHER_IMAGE, lambda f: f.state['images'].update({OTHER_IMAGE: {'inspect': f.inspect, 'root': str(f.root)}}),
             f'docker resolved {OTHER_IMAGE} to {IMAGE}'),
            (IMAGE, lambda f: f.inspect['Config']['Labels'].update({'dev.openharness.runtime': '6'}), "runtime contract is '6', not 7"),
            (IMAGE, lambda f: f.inspect['Config']['Labels'].pop('dev.openharness.runtime'), 'runtime contract is None, not 7'),
            (IMAGE, lambda f: f.inspect.update(Architecture=OTHER_ARCH), f'the image is linux/{OTHER_ARCH}, not linux/{ARCH}'),
            (IMAGE, lambda f: f.inspect.update(Os='windows'), f'the image is windows/{ARCH}'),
        ]
        for image, change, message in cases:
            with self.subTest(message=message):
                fixture = self.fixture()
                if change:
                    change(fixture)
                    fixture.save()
                failure = self.assertFailed(fixture, fixture.run(image=image), message)
                self.assertEqual(failure['image'], image)
                self.assertNoContainerOrScan(fixture)

    def test_foreign_architecture_is_refused(self):
        fixture = self.fixture()
        result = fixture.run(arch=OTHER_ARCH)
        self.assertFailed(fixture, result, f'not native {OTHER_ARCH}')
        self.assertEqual(fixture.docker_calls(), [])
        fixture = self.fixture()
        fixture.state['arch'] = OTHER_ARCH
        fixture.save()
        self.assertFailed(fixture, fixture.run(), f'the Docker server is linux/{OTHER_ARCH}, not native linux/{ARCH}')
        self.assertNoContainerOrScan(fixture)

    def test_lock_must_be_the_one_the_dockerfile_builds_with(self):
        fixture = self.fixture()
        with fixture.lock_path.open('a', encoding='utf-8') as handle:
            handle.write(' ')
        self.assertFailed(fixture, fixture.run(), 'runtime-inputs.lock.json differs from the hash runtime/hermes/Dockerfile builds with')
        self.assertEqual(fixture.docker_calls(), [])

    def test_source_links_are_refused_and_bytecode_caches_ignored(self):
        fixture = self.fixture()
        module = load_gate(fixture.repo / 'scripts/debian-origin-gate.py')
        before = module.source_files(fixture.repo)
        self.assertEqual(before, fixture.expected_sources())
        cache = fixture.repo / 'runtime/ubuntu/helpers/__pycache__'
        cache.mkdir()
        (cache / 'debian_origin.cpython-312.pyc').write_bytes(b'never read: -B and a missing pycache prefix')
        self.assertEqual(module.source_files(fixture.repo), before)
        (fixture.repo / 'runtime/ubuntu/lock/extra.json').symlink_to('runtime-inputs.lock.json')
        with self.assertRaisesRegex(module.GateError, 'links are not accepted'):
            module.source_files(fixture.repo)
        self.assertFailed(fixture, fixture.run(), 'links are not accepted among the gate inputs')
        self.assertEqual(fixture.docker_calls(), [])

    def test_database_must_be_present_and_be_the_one_the_scanner_reports(self):
        fixture = self.fixture()
        (fixture.cache / 'db/metadata.json').unlink()
        self.assertFailed(fixture, fixture.run(), 'needs db/trivy.db and db/metadata.json')
        self.assertEqual(fixture.docker_calls(), [])
        fixture = self.fixture()
        fixture.scenario({'version': 'other-db'})
        self.assertFailed(fixture, fixture.run(), 'the scanner does not report the copied database')
        self.assertNoContainerOrScan(fixture)

    def test_probe_user_must_be_non_root_and_output_must_be_new(self):
        for user in ('0:0', '1000:0', 'root', '0:1000'):
            with self.subTest(user=user):
                fixture = self.fixture()
                self.assertFailed(fixture, fixture.run('--probe-user', user), 'must be a non-root UID:GID')
                self.assertEqual(fixture.docker_calls(), [])
        with mock.patch.object(os, 'getuid', return_value=4321), mock.patch.object(os, 'getgid', return_value=4321):
            fixture = self.fixture()
            code, _ = fixture.run_in_process('--probe-user', '1000:1000')
            self.assertEqual(code, 1)
            self.assertIn('the probes run as this user (4321:4321)', fixture.read('failure.json')['error'])
            self.assertEqual(fixture.docker_calls(), [])
        fixture = self.fixture()
        fixture.out.mkdir()
        result = fixture.run()
        self.assertEqual(result.returncode, 1)
        self.assertIn('already exists; each run needs a new output directory', result.stderr)
        self.assertEqual(list(fixture.out.iterdir()), [])
        self.assertEqual(fixture.docker_calls(), [])


class GateFailuresPropagate(GateCase):
    def test_vulnerabilities_and_secrets_fail_and_their_reports_are_retained(self):
        cases = [
            ({'component-scan': 'vulnerable'}, 'component-scan exited 1, expected 0', 'component-scan', 3),
            ({'component-scan': 'secret'}, 'component-scan exited 1, expected 0', 'component-scan', 3),
            ({'sbom-scan': 'silent-vulnerable'}, '1 vulnerabilities', 'check-sbom-scan', 8),
            ({'image-scan': 'vulnerable'}, 'image-scan exited 1, expected 0', 'image-scan', 12),
            ({'image-scan': 'secret'}, 'image-scan exited 1, expected 0', 'image-scan', 12),
            ({'image-scan': 'silent-vulnerable'}, 'image scan: 1 vulnerabilities', 'check-image', 13),
        ]
        for scenario, message, step, count in cases:
            with self.subTest(scenario=scenario):
                fixture = self.fixture()
                fixture.scenario(scenario)
                self.assertFailed(fixture, fixture.run(), message, step)
                expected = [1 if name == 'negative-scan' else 0 for name in STEPS[:count]]
                expected[-1] = 1
                steps = self.assertRecordedSteps(fixture, STEPS[:count], expected)
                scanned = next(s for s in steps if s['name'] == next(iter(scenario)))
                report = fixture.out / next(iter(scanned['outputs']))
                self.assertTrue(report.is_file(), 'the failing report is retained')
                self.assertRegex(report.read_text(), 'CVE-2026-999|private-key')
                self.assertForeignUntouched(fixture)

    def test_missing_corrupt_or_foreign_reports_fail(self):
        cases = [
            ({'component-sbom': 'no-output'}, 'component-sbom: report component.cdx.json is missing or empty', 'component-sbom'),
            ({'component-scan': 'no-output'}, 'component-scan: report component-scan.json is missing or empty', 'component-scan'),
            ({'negative-scan': 'garbage'}, 'negative-scan: report negative-scan.json is not JSON', 'negative-scan'),
            ({'sbom-scan': 'wrong-artifact'}, 'sbom-scan: the report is of cyclonedx', 'sbom-scan'),
            ({'component-scan': 'wrong-type'}, 'component-scan: the report is of repository', 'component-scan'),
            ({'image-scan': 'wrong-artifact'}, 'image-scan: the report is of container_image', 'image-scan'),
            ({'image-scan': 'wrong-image-id'}, f'image-scan: the scanner saw image sha256:{"e" * 64}', 'image-scan'),
            ({'component-sbom': 'other-described'}, 'component-sbom: the SBOM describes', 'component-sbom'),
        ]
        for scenario, message, step in cases:
            with self.subTest(scenario=scenario):
                fixture = self.fixture()
                fixture.scenario(scenario)
                self.assertFailed(fixture, fixture.run(), message, step)
                self.assertEqual(fixture.read('status.json')['steps'][-1]['name'], step)

    def test_rejected_component_identity_fails(self):
        fixture = self.fixture()
        (fixture.root / 'usr/lib/chromium/chromium').write_bytes(b'\x7fELF patched after the build')
        self.assertFailed(fixture, fixture.run('--keep-work'), 'probe-bind exited 1, expected 0', 'probe-bind', work_kept=True)
        self.assertIn('debian_origin: image: /usr/lib/chromium/chromium differs from the inventory',
                      (fixture.out / 'steps/probe-bind.stderr').read_text())
        self.assertRecordedSteps(fixture, STEPS[:2], [0, 1])
        self.assertTrue((fixture.out / 'work/probe/component/var/lib/dpkg/status').is_file(), '--keep-work keeps the component')
        shutil.rmtree(fixture.out / 'work')

        fixture = self.fixture()
        archive = fixture.contents['chromium-common']['path']
        support.make_deb(archive, 'chromium-common', '154.0.8037.57-1~deb13u1', fixture.arch, 'chromium',
                         {'/usr/lib/chromium/resources.pak': b'other resources'})
        self.assertFailed(fixture, fixture.run(), 'probe-component-root exited 1, expected 0', 'probe-component-root')
        self.assertRegex((fixture.out / 'steps/probe-component-root.stderr').read_text(), 'chromium-common: .*(bytes|SHA256)')

        fixture = self.fixture()
        fixture.scenario({'component-scan': 'wrong-arch'})
        self.assertFailed(fixture, fixture.run(), 'check-component exited 1, expected 0', 'check-component')
        self.assertIn(f'is not {fixture.arch}', (fixture.out / 'steps/check-component.stderr').read_text())

    def test_bad_negative_control_fails(self):
        cases = [
            ({'negative-scan': 'no-findings'}, 'negative-scan exited 0, expected 1', 'negative-scan', 'no HIGH'),
            ({'negative-scan': 'wrong-version-findings'}, 'check-negative exited 1, expected 0', 'check-negative',
             'Debian advisory lookup is not proven'),
            ({'negative-scan': 'binary-only'}, 'check-negative exited 1, expected 0', 'check-negative',
             'chromium source version 154.0.8037.57-1~deb13u1'),
        ]
        for scenario, message, step, detail in cases:
            with self.subTest(scenario=scenario):
                fixture = self.fixture()
                fixture.scenario(scenario)
                self.assertFailed(fixture, fixture.run(), message, step)
                if step == 'check-negative':
                    self.assertIn(detail, (fixture.out / 'steps/check-negative.stderr').read_text())

    def test_lock_or_database_changed_during_the_gate_fails(self):
        cases = [
            ({'component-scan': 'modify-lock'}, 'sources changed during the gate'),
            ({'sbom-scan': 'modify-db'}, 'the scanner database changed during the gate'),
            ({'image-scan': 'modify-source-db'}, 'the scanner database changed during the gate'),
        ]
        for scenario, message in cases:
            with self.subTest(scenario=scenario):
                fixture = self.fixture()
                fixture.scenario(scenario)
                failure = self.assertFailed(fixture, fixture.run(), message)
                self.assertEqual(failure['phase'], 'postconditions')
                self.assertRecordedSteps(fixture, STEPS, [1 if name == 'negative-scan' else 0 for name in STEPS])
                database = fixture.read('status.json')['database']
                if 'db' in next(iter(scenario.values())):
                    self.assertNotEqual((database['sourceAfter'], database['usedAfter']), (database['sourceBefore'], database['usedBefore']))


class GateBoundsAndCleanup(GateCase):
    def test_only_exact_container_absence_confirms_cleanup(self):
        module = load_gate(GATE)
        name = 'oh-debian-origin-gate-0123456789abcdef-probe-bind'
        for message in [f'Error: No such container: {name}', f'Error response from daemon: No such container: {name}',
                        f'No such object: {name}\n']:
            self.assertTrue(module.missing_container(1, message, name))
        bad = ['Cannot connect to Docker: dial unix /var/run/docker.sock: no such file or directory',
               f'Error: No such container: {name}-other', f'Error: No such container: {name}\nPermission denied',
               'Permission denied', '']
        for message in bad:
            with self.subTest(message=message):
                self.assertFalse(module.missing_container(1, message, name))
                fixture = self.fixture()
                gate = module.Gate(module.parse(fixture.argv()))
                probe = {'container': name, 'cidfile': fixture.dir / 'unused.cid', 'attempted': False, 'removed': False}
                with mock.patch.object(gate, 'docker', return_value=(1, '', message)), mock.patch.object(gate, 'save_status'):
                    gate.remove_probe(probe)
                self.assertFalse(probe['removed'])
                self.assertEqual(gate.status['cleanup'], [])
                self.assertEqual(len(gate.cleanup_errors), 1)
        for code in [0, 2, 125, None]:
            self.assertFalse(module.missing_container(code, f'Error: No such container: {name}', name))

    def test_hung_probe_times_out_and_only_its_container_is_removed(self):
        fixture = self.fixture()
        fixture.scenario({'probe-bind': 'hang'})
        started = time.monotonic()
        code, gate = fixture.run_in_process(timeouts={'probe': 3})
        self.assertLess(time.monotonic() - started, 45)
        self.assertEqual(code, 1)
        failure = fixture.read('failure.json')
        self.assertEqual((failure['failedStep'], failure['phase']), ('probe-bind', 'probe-bind'))
        self.assertIn('probe-bind timed out after 3 s', failure['error'])
        status = fixture.read('status.json')
        self.assertEqual((status['steps'][-1]['name'], status['steps'][-1]['timedOut'], status['steps'][-1]['returncode']),
                         ('probe-bind', True, None))
        hung = next(run['container'] for run in fixture.probe_runs() if run['probe'] == 'probe-bind')
        self.assertEqual(status['cleanup'], [
            {'container': f'oh-debian-origin-gate-{gate.nonce}-probe-component-root', 'action': 'absent'},
            {'container': f'oh-debian-origin-gate-{gate.nonce}-probe-bind', 'id': hung, 'action': 'removed'}])
        self.assertEqual([argv[2:] for argv in fixture.docker_calls() if argv[2] == 'rm'], [['rm', '--force', hung]])
        self.assertEqual(set(fixture.load()['containers']), set(FOREIGN))
        self.assertForeignUntouched(fixture)

    def test_hung_scanner_times_out(self):
        fixture = self.fixture()
        fixture.scenario({'image-scan': 'hang'})
        code, _ = fixture.run_in_process(timeouts={'trivy': 3})
        self.assertEqual(code, 1)
        failure = fixture.read('failure.json')
        self.assertEqual(failure['failedStep'], 'image-scan')
        self.assertIn('image-scan timed out after 3 s', failure['error'])
        self.assertTrue(fixture.read('status.json')['steps'][-1]['timedOut'])
        self.assertForeignUntouched(fixture)

    def test_deadline_bounds_every_child(self):
        fixture = self.fixture()
        code, _ = fixture.run_in_process(before=lambda gate: setattr(gate, 'deadline', time.monotonic() - 1))
        self.assertEqual(code, 1)
        failure = fixture.read('failure.json')
        self.assertEqual((failure['error'], failure['phase']), ('the gate deadline passed', 'preflight'))
        self.assertEqual(fixture.docker_calls(), [])

    def test_name_collision_leaves_the_other_container_untouched(self):
        fixture = self.fixture()
        nonce = '0123456789abcdef'
        name = f'oh-debian-origin-gate-{nonce}-probe-component-root'
        other = {'Id': 'f3' * 32, 'Name': f'/{name}', 'Image': IMAGE, 'Config': {'Image': IMAGE, 'Labels': {PROBE_LABEL: 'another-run'}},
                 'State': {'Running': True}}
        fixture.state['containers'][other['Id']] = other
        fixture.save()
        code, gate = fixture.run_in_process(nonce=nonce)
        self.assertEqual(code, 1)
        failure = fixture.read('failure.json')
        self.assertEqual(failure['failedStep'], 'probe-component-root')
        self.assertIn('probe-component-root exited 125', failure['error'])
        self.assertEqual(failure['cleanupErrors'], [f"{name}: {name} exists but is not this invocation's probe; it was left untouched"])
        self.assertEqual(fixture.load()['containers'][other['Id']], other)
        self.assertFalse([argv for argv in fixture.docker_calls() if argv[2] == 'rm'])
        self.assertForeignUntouched(fixture)

    def test_cleanup_problems_are_recorded_and_never_hide_the_result(self):
        def broken(path):
            raise PermissionError(13, 'Permission denied', str(path))
        cases = [({}, 'cleanup', None, 'cleanup failed'),
                 ({'component-scan': 'vulnerable'}, 'component-scan', 'component-scan', 'component-scan exited 1, expected 0')]
        for scenario, phase, step, message in cases:
            with self.subTest(scenario=scenario):
                fixture = self.fixture()
                fixture.scenario(scenario)
                code, _ = fixture.run_in_process(prepare=lambda module: setattr(module, 'remove_tree', broken))
                self.assertEqual(code, 1)
                failure = fixture.read('failure.json')
                self.assertEqual((failure['phase'], failure['failedStep']), (phase, step))
                self.assertIn(message, failure['error'])
                self.assertEqual(len(failure['cleanupErrors']), 1)
                self.assertIn('work directory', failure['cleanupErrors'][0])
                self.assertFalse((fixture.out / 'receipt.json').exists())
                self.assertFalse(fixture.read('status.json')['ok'])

    def test_cancellation_records_failure_and_removes_only_this_probe(self):
        fixture = self.fixture()
        fixture.scenario({'probe-bind': 'hang'})
        command = [sys.executable, '-I', '-B', str(fixture.repo / 'scripts/debian-origin-gate.py'), *fixture.argv()]
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=fixture.dir,
                                   env={'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LANG': 'C.UTF-8'})
        try:
            deadline = time.monotonic() + 60
            while not any(run['probe'] == 'probe-bind' for run in fixture.probe_runs()):
                self.assertIsNone(process.poll(), 'the gate stopped before the hung probe started')
                self.assertLess(time.monotonic(), deadline, 'the hung probe never started')
                time.sleep(0.1)
            process.send_signal(signal.SIGINT)
            time.sleep(0.2)
            process.send_signal(signal.SIGTERM)  # as a cancelled CI step does next; it must not cut cleanup short
            _, stderr = process.communicate(timeout=60)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
        self.assertEqual(process.returncode, 1, stderr)
        failure = fixture.read('failure.json')
        self.assertEqual((failure['phase'], failure['failedStep'], failure['cleanupErrors']), ('probe-bind', 'probe-bind', []))
        self.assertEqual(failure['error'], f'interrupted by signal {int(signal.SIGINT)}')
        step = fixture.read('status.json')['steps'][-1]
        self.assertEqual((step['name'], step['returncode'], step['interrupted']), ('probe-bind', None, failure['error']))
        hung = next(run['container'] for run in fixture.probe_runs() if run['probe'] == 'probe-bind')
        self.assertEqual([argv[2:] for argv in fixture.docker_calls() if argv[2] == 'rm'], [['rm', '--force', hung]])
        self.assertEqual(set(fixture.load()['containers']), set(FOREIGN))
        self.assertForeignUntouched(fixture)
        self.assertFalse((fixture.out / 'receipt.json').exists())
        self.assertFalse((fixture.out / 'work').exists())

    def test_steps_cannot_be_skipped_reordered_or_left_incomplete(self):
        fixture = self.fixture()
        module = load_gate(fixture.repo / 'scripts/debian-origin-gate.py')
        gate = module.Gate(module.parse(fixture.argv()))
        with self.assertRaisesRegex(module.GateError, 'check-component: out of order'):
            gate.step('check-component', ['true'], 'helper')
        gate.status['steps'] = [{'name': name, 'returncode': code} for name, code in module.STEPS[:-1]]
        with self.assertRaisesRegex(module.GateError, 'the step record is incomplete'):
            gate.postconditions()
        gate.status['steps'] = [{'name': name, 'returncode': 0} for name, _ in module.STEPS]
        with self.assertRaisesRegex(module.GateError, 'the step record is incomplete'):
            gate.postconditions()
        self.assertEqual([name for name, _ in module.STEPS], STEPS)
        self.assertEqual(dict(module.STEPS)['negative-scan'], 1)
        self.assertEqual(module.NEGATIVE_VERSION, support.OLDER_CHROMIUM)


if __name__ == '__main__':
    unittest.main()
