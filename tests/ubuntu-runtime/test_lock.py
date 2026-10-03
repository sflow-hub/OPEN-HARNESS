"""The input lock: internal consistency, agreement with root's packet, and exact re-derivation from the evidence."""
import copy
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import support
from support import ohpkg

sys.path.insert(0, str(support.PACKAGE / 'tools'))
import derive_lock  # noqa: E402

# The shape of the retained AMD64 build log: the OS package list step, another step, and the verify step.
SYNTHETIC_BUILD_LOG = '''\
#15 [runtime  1/20] RUN --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build \
    sh /opt/open-harness-build/helpers/check-native-platform.sh  && apt-get update  && DEBIAN_FRONTEND=noninteractive \
xargs --no-run-if-empty --delimiter='\\n'       --arg-file=/opt/open-harness-build/lock/ubuntu-os-packages.txt       \
apt-get install -y --no-install-recommends  && apt-get check  && rm -rf /var/lib/apt/lists/*
#15 11.76 The following additional packages will be installed:
#15 11.76   libdrm-intel1 libpciaccess0
#15 11.77 Suggested packages:
#15 11.77   pciutils mesa-utils
#15 12.73 0 upgraded, 205 newly installed, 0 to remove and 3 not upgraded.
#14 [curl-builder 1/3] RUN --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build
#14 13.87 2 upgraded, 192 newly installed, 0 to remove and 1 not upgraded.
#15 16.84 Get:133 http://archive.ubuntu.com/ubuntu resolute-updates/main amd64 libpciaccess0 amd64 0.18.1-1ubuntu4.1 [19.0 kB]
#15 16.84 Get:134 http://archive.ubuntu.com/ubuntu resolute/main amd64 libdrm-intel1 amd64 2.4.131-1 [66.7 kB]
#15 73.87 Unpacking libpciaccess0:amd64 (0.18.1-1ubuntu4.1) ...
#15 74.01 Unpacking libdrm-intel1:amd64 (2.4.131-1) ...
#15 85.98 Setting up libpciaccess0:amd64 (0.18.1-1ubuntu4.1) ...
#15 113.4 Setting up libdrm-intel1:amd64 (2.4.131-1) ...
#15 DONE 120.1s
#37 [verify 1/1] RUN --network=none     --mount=type=bind,from=build-inputs,source=/opt/open-harness-build,target=/opt/open-harness-build
#37 0.642 check_packages: installed packages differ from the amd64 lock: {'unexpected': {'libdrm-intel1': ['2.4.131-1', \
'amd64'], 'libpciaccess0': ['0.18.1-1ubuntu4.1', 'amd64']}}
#37 ERROR: process "/dev/.buildkit_qemu_emulator /bin/sh -c set -eu; ..." did not complete successfully: exit code: 1
'''

EVIDENCE_DIRS = ('ubuntu26-', 'ubuntu-runtime-packaging-inputs-v1', 'hermes-amd64-', 'ubuntu-snapshot-probe-')


def without_snapshot(lock):
    """The lock root's live-archive build used: this lock without its Ubuntu snapshot pin."""
    previous = copy.deepcopy(lock)
    del previous['ubuntu']['snapshot']
    del previous['derivedFrom']['liveArchiveBuild'], previous['derivedFrom']['snapshotProbeSha256Sums']
    return previous


def synthetic_probe(lock, arch):
    """A probe Dockerfile and build log shaped like root's, resolving the unchanged OS list to arch's locked set."""
    pins = dict(p.split('=', 1) for p in support.OS_PACKAGES.read_text().splitlines())
    final, other = lock['finalPackages'][arch], lock['finalPackages']['arm64' if arch == 'amd64' else 'amd64']
    setup = f'printf \'APT::Snapshot "{support.UBUNTU_SNAPSHOT}";\\n\' > /etc/apt/apt.conf.d/99-open-harness-snapshot'
    simulate = "xargs --no-run-if-empty --delimiter='\\n' --arg-file=/tmp/ubuntu-os-packages.txt apt-get -s install --no-install-recommends"
    dockerfile = f"FROM docker.io/library/ubuntu@{lock['images']['ubuntu']['manifests'][arch]}\nRUN set -eu; {setup}\nRUN {simulate}\n"
    lines = [f'#7 [3/4] RUN set -eu; {setup}']
    lines += [f'#7 43.36 {name}{":" + arch if name == "libssl3t64" else ""} {final[name][0]}' for name in derive_lock.BOOTSTRAP_CHANGED]
    lines += [f'#8 [4/4] RUN {simulate}'] + [f'#8 0.750 {name} is already the newest version ({pins[name]}).'
                                              for name in ('openssl', 'ca-certificates')]
    new = [name for name in pins if name not in ('openssl', 'ca-certificates')] + sorted(set(final) - set(other))
    lines.append(f'#8 1.479 0 upgraded, {len(new)} newly installed, 0 to remove and 1 not upgraded.')
    lines += [f'#8 2.000 Inst {name} ({pins.get(name, final[name][0])} Ubuntu:26.04/resolute [{final[name][1]}])' for name in new]
    return dockerfile, '\n'.join(lines) + '\n'


class LockConsistency(unittest.TestCase):
    def setUp(self):
        self.lock = support.load_lock()

    def test_os_package_list_is_the_locked_exact_pin_list(self):
        text = support.OS_PACKAGES.read_text(encoding='utf-8')
        self.assertEqual(support.sha256(text.encode()), self.lock['ubuntu']['osPackagesSha256'])
        pins = text.splitlines()
        self.assertEqual(len(pins), self.lock['ubuntu']['osPackageCount'])
        self.assertEqual(len(pins), 203)
        self.assertEqual(len({p.split('=')[0] for p in pins}), len(pins))
        for pin in pins:
            self.assertRegex(pin, r'^[a-z0-9][a-z0-9.+-]*=[0-9][^=\s]*$')

    def test_final_package_sets(self):
        final = self.lock['finalPackages']
        self.assertEqual({a: len(v) for a, v in final.items()}, {'arm64': 329, 'amd64': 331})
        for name, (version, arch) in final['arm64'].items():
            self.assertIn(arch, ('arm64', 'all'))
            self.assertEqual(final['amd64'][name], [version, 'amd64' if arch == 'arm64' else 'all'])
        self.assertEqual({name: entry for name, entry in final['amd64'].items() if name not in final['arm64']},
                         support.AMD64_ONLY)
        os_pins = dict(p.split('=', 1) for p in support.OS_PACKAGES.read_text().splitlines())
        chromium = dict(p.split('=', 1) for p in self.lock['ubuntu']['chromiumDependencies']['arm64'])
        for name, version in list(os_pins.items()) + list(chromium.items()):
            if name not in ('curl', 'libcurl4t64', 'libcurl3t64-gnutls'):
                self.assertEqual(final['arm64'][name][0], version, name)
        rebuilt = self.lock['curl']['rebuild']['version']
        for name in self.lock['curl']['rebuild']['runtimePackages']:
            self.assertEqual(final['arm64'][name], [rebuilt, 'arm64'])
        for name, record in self.lock['debian']['packages']['arm64'].items():
            self.assertEqual(final['arm64'][name], [record['Version'], 'arm64'])
        self.assertEqual(final['arm64']['libnghttp3-9'][0], '1.12.0-1')

    def test_chromium_dependencies_are_exact_pins_outside_the_os_list(self):
        deps = self.lock['ubuntu']['chromiumDependencies']
        self.assertEqual(deps['arm64'], deps['amd64'])
        self.assertEqual(len(deps['arm64']), 35)
        os_names = {p.split('=')[0] for p in support.OS_PACKAGES.read_text().splitlines()}
        for pin in deps['arm64']:
            name, version = pin.split('=', 1)
            self.assertNotIn(name, os_names)
            self.assertTrue(version)

    def test_validation_states_are_explicit(self):
        self.assertIn('has not been built', self.lock['validation']['arm64'])
        amd64 = self.lock['validation']['amd64']
        for phrase in ('This lock has not been built for AMD64.', 'libdrm-intel1 2.4.131-1 and libpciaccess0 0.18.1-1ubuntu4.1',
                       'emulated AMD64 build of the previous lock sha256:78cacbef...', 'later checks did not run',
                       'not on retained signed index records', 'fails closed on any difference'):
            self.assertIn(phrase, amd64)

    def test_lock_is_the_live_archive_lock_plus_only_the_snapshot(self):
        self.assertRegex(self.lock['ubuntu']['snapshot'], r'^\d{8}T\d{6}Z$')
        self.assertEqual(self.lock['ubuntu']['snapshot'], support.UBUNTU_SNAPSHOT)
        self.assertEqual(self.lock['derivedFrom']['liveArchiveBuild'], {
            'buildLogSha256': '465ceb4d283e74732365abf7b616a2acdeb8010e5d87853b0155b85f0d2a0ecc',
            'builtLockSha256': support.LIVE_ARCHIVE_LOCK,
            'intentSha256': 'e5e747316e93f08b620afe10aaf9857c831aa7a9de4cfdb3fe20ec51a072b6d7',
            'resultSha256': 'b20f547076291f91962606c23187b17dcdb62d9a7d8a11d239b0fce307f7edb5',
            'unavailablePins': ['libheif-plugin-aomdec=1.21.2-3ubuntu0.5', 'libheif1=1.21.2-3ubuntu0.5',
                                'openssl=3.5.5-1ubuntu3.5']})
        self.assertLessEqual(set(self.lock['derivedFrom']['liveArchiveBuild']['unavailablePins']),
                             set(support.OS_PACKAGES.read_text().splitlines()))
        self.assertEqual(self.lock['derivedFrom']['snapshotProbeSha256Sums'], {
            'amd64': '6c1b160d4ec11fd79707641a3a99b3c8c4df197710799d9d786930cec9f849e6',
            'arm64': 'fc2e396151f232b5e1ba1ac861e2031fdd4c0bfdaf1af8a2bbcdb2f1db456e3a'})
        self.assertEqual(support.sha256(ohpkg.canonical_json(without_snapshot(self.lock)).encode()), support.LIVE_ARCHIVE_LOCK)

    def test_lock_is_the_built_lock_plus_only_the_amd64_correction(self):
        previous = without_snapshot(self.lock)
        self.assertEqual(previous['derivedFrom'].pop('amd64Build'), {
            'builtLockSha256': support.AMD64_BUILT_LOCK, 'executionMode': 'emulated',
            'buildLogSha256': '7e10d3796be0a6f0760770cbcfc685ab0bafecbc8ab039c4fec40a4f12317b8f',
            'intentSha256': '6824633f70ee66e69ae688936ce1d9d331a52615253083d1ed155e389d1a3592',
            'resultSha256': 'ba1bb6e549cd9f1f1c02ac6c42a15828d363b8561842573580821abe163c62fc'})
        for name in support.AMD64_ONLY:
            del previous['finalPackages']['amd64'][name]
        previous['validation']['amd64'] = derive_lock.SELECTED_AMD64_VALIDATION
        self.assertEqual(support.sha256(ohpkg.canonical_json(previous).encode()), support.AMD64_BUILT_LOCK)

    def test_debian_records_are_complete_and_architecture_specific(self):
        self.assertEqual((self.lock['debian']['suite'], self.lock['debian']['release']), ('trixie', '13'))
        for arch in ('arm64', 'amd64'):
            records = self.lock['debian']['packages'][arch]
            self.assertEqual(set(records), {'chromium', 'chromium-common', 'libjpeg62-turbo'})
            for name, record in records.items():
                self.assertEqual(record['Architecture'], arch)
                self.assertRegex(record['SHA256'], r'^[0-9a-f]{64}$')
                self.assertTrue(record['Filename'].endswith(f'_{arch}.deb'))
                self.assertIsInstance(record['Size'], int)
        self.assertNotEqual(self.lock['debian']['packages']['arm64']['chromium']['SHA256'],
                            self.lock['debian']['packages']['amd64']['chromium']['SHA256'])

    def test_curl_rebuild_is_the_tested_change(self):
        rebuild = self.lock['curl']['rebuild']
        self.assertEqual(rebuild['expectedPatchSha256'], support.TESTED_PATCH_SHA256)
        self.assertEqual(rebuild['command'], ['dpkg-buildpackage', '-us', '-uc', '-b', '-j4'])
        self.assertEqual((rebuild['builderUid'], rebuild['minimumPidsLimit']), (10001, 2048))
        self.assertEqual(rebuild['runtimePackages'], ['curl', 'libcurl4t64', 'libcurl3t64-gnutls'])
        self.assertIn('HTTP3', self.lock['curl']['expectedRuntime']['features'])


@support.needs(support.PACKET / 'manifest.json', support.PACKET / 'README.md')
class LockAgainstPacket(unittest.TestCase):
    def setUp(self):
        self.lock = support.load_lock()
        manifest = support.PACKET / 'manifest.json'
        self.assertEqual(support.sha256(manifest.read_bytes()),
                         '595a4addce271d217c7c625975d8295ee290ccf9bebe34aa643a6ba0a43db1a3')
        for name, digest in support.read_json(manifest).items():
            self.assertEqual(support.sha256((support.PACKET / name).read_bytes()), digest, name)

    def test_packet_has_sixteen_files(self):
        self.assertEqual(len(support.read_json(support.PACKET / 'manifest.json')), 16)

    def test_ubuntu_digests_match_the_packet(self):
        readme = (support.PACKET / 'README.md').read_text()
        ubuntu = self.lock['images']['ubuntu']
        for digest in [ubuntu['index'], *ubuntu['manifests'].values()]:
            self.assertIn(digest.removeprefix('sha256:'), readme)
        runtime = (support.PACKET / 'runtime.Dockerfile').read_text()
        for image in ('python', 'node'):
            self.assertIn(self.lock['images'][image]['index'], runtime)

    def test_os_list_is_the_tested_candidate_list_in_order(self):
        candidate = (support.PACKET / 'ubuntu-os-candidate.Dockerfile').read_text()
        pins = re.search(r'--no-install-recommends (.*?) && apt-get check', candidate, re.S).group(1).split()
        self.assertEqual(pins, support.OS_PACKAGES.read_text().splitlines())

    def test_debian_records_equal_the_authenticated_packet_records(self):
        packet = {'arm64': {}, 'amd64': {}}
        for name in ('debian-arm64-chromium.json', 'debian-arm64-jpeg.json'):
            packet['arm64'].update(support.read_json(support.PACKET / name)['packages'])
        packet['amd64'].update(support.read_json(support.PACKET / 'debian-amd64-browser.json')['packages'])
        for arch, records in packet.items():
            for name, record in records.items():
                expected = {k: (int(v) if k == 'Size' else v) for k, v in record.items() if k != 'Depends'}
                self.assertEqual(self.lock['debian']['packages'][arch][name], expected)

    def test_curl_source_equals_the_signed_source_hashes(self):
        packet = support.read_json(support.PACKET / 'curl-source-hashes.json')
        self.assertEqual(self.lock['curl']['source']['files'], packet['files'])
        self.assertEqual(self.lock['curl']['source']['version'], packet['version'])


class Amd64Additions(unittest.TestCase):
    """Reading the AMD64 build log: the reported packages only when apt, dpkg and the package check all agree."""

    def setUp(self):
        self.previous = copy.deepcopy(support.load_lock())
        for name in support.AMD64_ONLY:
            del self.previous['finalPackages']['amd64'][name]

    def test_agreeing_log_yields_exactly_the_reported_packages(self):
        self.assertEqual(derive_lock.amd64_additions(SYNTHETIC_BUILD_LOG, self.previous), support.AMD64_ONLY)

    def test_disagreeing_or_incomplete_logs_are_refused(self):
        drm = "'libdrm-intel1': ['2.4.131-1', 'amd64']"
        cases = [
            ("{'unexpected'", "{'missing': ['curl'], 'unexpected'", 'did not report only unexpected packages'),
            ("{'unexpected'", "{'different': {'curl': {'locked': ['1', 'amd64'], 'installed': ['2', 'amd64']}}, 'unexpected'",
             'did not report only unexpected packages'),
            ("{'unexpected'", "{'unexpected': os.system('true'), 'x'", 'unreadable package check result'),
            (drm, "'libdrm-intel1': ['2.4.131-1', 'all']", 'is not an AMD64 package'),
            ('  libdrm-intel1 libpciaccess0', '  libdrm-intel1 libpciaccess0 pciutils', 'apt added'),
            ('205 newly installed', '204 newly installed', 'did not newly install exactly the 203 listed'),
            ('libdrm-intel1 amd64 2.4.131-1 [', 'libdrm-intel1 amd64 2.4.131-2 [', 'libdrm-intel1 2.4.131-1 was not fetched'),
            ('http://archive.ubuntu.com/ubuntu resolute/main', 'http://deb.debian.org/debian trixie/main', 'was not fetched'),
            ('Unpacking libpciaccess0:amd64', 'Unpacking libpciaccess0:arm64', 'libpciaccess0 0.18.1-1ubuntu4.1 was not unpacked'),
            ('#15 113.4 Setting up libdrm-intel1:amd64 (2.4.131-1) ...\n', '', 'libdrm-intel1 2.4.131-1 was not set up'),
            ('#37 0.642 check_packages', '#15 0.642 check_packages', 'the verify step has 0 AMD64 package check failures'),
            ('#37 ERROR', "#37 0.700 check_packages: installed packages differ from the amd64 lock: {'unexpected': {}}\n#37 ERROR",
             'the verify step has 2 AMD64 package check failures'),
            ('[verify 1/1]', '[verify-copy 1/1]', 'no single verify step'),
            ('#14 [curl-builder 1/3] RUN', '#14 [runtime  2/20] RUN --arg-file=/opt/open-harness-build/lock/ubuntu-os-packages.txt',
             'no single runtime step installs the OS package list'),
        ]
        for old, new, message in cases:
            with self.subTest(message=message, new=new):
                self.assertIn(old, SYNTHETIC_BUILD_LOG)
                with self.assertRaisesRegex(ohpkg.InputError, re.escape(message)):
                    derive_lock.amd64_additions(SYNTHETIC_BUILD_LOG.replace(old, new), self.previous)
        with self.assertRaisesRegex(ohpkg.InputError, 'libdrm-intel1 is already in the AMD64 lock'):
            derive_lock.amd64_additions(SYNTHETIC_BUILD_LOG, support.load_lock())


class SnapshotEvidenceReading(unittest.TestCase):
    """Reading the live-archive failure and the snapshot probes: the snapshot only when both resolve the locked sets."""

    def setUp(self):
        self.lock = support.load_lock()
        self.pins = dict(p.split('=', 1) for p in support.OS_PACKAGES.read_text().splitlines())

    def test_unavailable_versions_must_be_os_list_pins(self):
        log = ('#15 [runtime  1/20] RUN sh check-native-platform.sh && apt-get update && DEBIAN_FRONTEND=noninteractive xargs '
               '--arg-file=/opt/open-harness-build/lock/ubuntu-os-packages.txt apt-get install -y --no-install-recommends\n'
               "#15 12.05 E: Version '3.5.5-1ubuntu3.5' for 'openssl' was not found\n"
               "#15 12.05 E: Version '1.21.2-3ubuntu0.5' for 'libheif1' was not found\n")
        self.assertEqual(derive_lock.unavailable_pins(log, self.pins),
                         [('libheif1', '1.21.2-3ubuntu0.5'), ('openssl', '3.5.5-1ubuntu3.5')])
        with self.assertRaisesRegex(ohpkg.InputError, 'openssl 3.5.5-1ubuntu3.6 is not an OS-list pin'):
            derive_lock.unavailable_pins(log.replace("'3.5.5-1ubuntu3.5'", "'3.5.5-1ubuntu3.6'"), self.pins)
        with self.assertRaisesRegex(ohpkg.InputError, 'reports no missing pinned version'):
            derive_lock.unavailable_pins(log.splitlines()[0], self.pins)

    def test_agreeing_probes_yield_the_snapshot(self):
        for arch in ('amd64', 'arm64'):
            with self.subTest(arch=arch):
                dockerfile, log = synthetic_probe(self.lock, arch)
                self.assertEqual(derive_lock.snapshot_resolution(log, dockerfile, self.lock, self.pins, arch),
                                 support.UBUNTU_SNAPSHOT)

    def test_disagreeing_probes_are_refused(self):
        dockerfile, log = synthetic_probe(self.lock, 'amd64')
        tzdata = f"#8 2.000 Inst tzdata ({self.pins['tzdata']} Ubuntu:26.04/resolute [all])\n"
        libc6 = f"#8 2.000 Inst libc6 ({self.lock['finalPackages']['amd64']['libc6'][0]} Ubuntu:26.04/resolute [amd64])\n"
        arm64 = self.lock['images']['ubuntu']['manifests']['arm64']
        cases = [
            (dockerfile.replace(self.lock['images']['ubuntu']['manifests']['amd64'], arm64), log, 'not the locked base image'),
            (dockerfile + 'RUN printf \'APT::Snapshot "20260930T000000Z";\'\n', log, 'not exactly one snapshot'),
            (dockerfile, log.replace('libssl3t64:amd64 3.5.5-1ubuntu3.5', 'libssl3t64:amd64 3.5.5-1ubuntu3.6'),
             'OpenSSL packages are not at their locked versions'),
            (dockerfile, log.replace('0 upgraded, 203 newly', '1 upgraded, 203 newly'), 'does more than newly install'),
            (dockerfile, log.replace('Inst libheif1 (1.21.2-3ubuntu0.5 ', 'Inst libheif1 (1.21.2-3ubuntu0.6 '),
             'resolves libheif1'),
            (dockerfile, log.replace('Inst libdrm-intel1 (2.4.131-1 ', 'Inst libdrm-intel1 (2.4.131-2 '), 'resolves libdrm-intel1'),
            (dockerfile, log.replace('(3.5.5-1ubuntu3.5).', '(3.5.5-1ubuntu3.6).'), 'was installed, but is not its pin'),
            (dockerfile, log.replace(tzdata, '').replace('203 newly', '202 newly'), "pins neither simulated nor installed: ['tzdata']"),
            (dockerfile, (log + libc6).replace('203 newly', '204 newly'), 'unpinned simulated packages'),
        ]
        for changed_dockerfile, changed_log, message in cases:
            with self.subTest(message=message):
                self.assertTrue(changed_dockerfile != dockerfile or changed_log != log)
                with self.assertRaisesRegex(ohpkg.InputError, re.escape(message)):
                    derive_lock.snapshot_resolution(changed_log, changed_dockerfile, self.lock, self.pins, 'amd64')


@support.needs(support.PACKET, support.FULL / 'scan/scan.json', support.PYTHON / 'evidence.tar.gz',
               support.BROWSER / 'evidence.tar.gz', support.CURL / 'evidence.tar.gz', support.AMD64_BUILD / 'build.log',
               support.LIVE_ARCHIVE_BUILD / 'build.log', *(probe / 'SHA256SUMS' for probe in support.SNAPSHOT_PROBES.values()))
class LockDerivation(unittest.TestCase):
    def derive(self, base):
        with tempfile.TemporaryDirectory() as out:
            result = subprocess.run([sys.executable, '-B', str(support.PACKAGE / 'tools/derive_lock.py'),
                                     '--base', str(base), '--out', f'{out}/lock.json', '--os-packages', f'{out}/os.txt'],
                                    capture_output=True, text=True)
            written = {name: Path(out, name).read_bytes() for name in ('lock.json', 'os.txt') if Path(out, name).exists()}
        return result, written

    def copied_base(self, base, copied):
        for entry in support.EVIDENCE.iterdir():
            if entry.name.startswith(EVIDENCE_DIRS):
                if entry.name == copied:
                    Path(base, entry.name).mkdir()
                    for path in entry.iterdir():
                        Path(base, entry.name, path.name).write_bytes(path.read_bytes())
                else:
                    Path(base, entry.name).symlink_to(entry)
        return Path(base, copied)

    def test_derive_lock_reproduces_the_committed_lock_byte_for_byte(self):
        result, written = self.derive(support.EVIDENCE)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(written['lock.json'], support.LOCK.read_bytes())
        self.assertEqual(written['os.txt'], support.OS_PACKAGES.read_bytes())
        self.assertEqual(json.loads(result.stdout)['finalPackages'], {'arm64': 329, 'amd64': 331})

    def test_derivation_refuses_altered_build_or_probe_evidence(self):
        amd64, arm64, live = support.SNAPSHOT_PROBES['amd64'].name, support.SNAPSHOT_PROBES['arm64'].name, support.LIVE_ARCHIVE_BUILD.name
        for directory, name, old, new in (
                (support.AMD64_BUILD.name, 'build.log', "'libpciaccess0': ['0.18.1-1ubuntu4.1'", "'libpciaccess0': ['0.18.1-1ubuntu4.2'"),
                (support.AMD64_BUILD.name, 'intent.json', '"executionMode": "emulated"', '"executionMode": "native"'),
                (support.AMD64_BUILD.name, 'result.json', '"buildExitCode": 1', '"buildExitCode": 0'),
                (live, 'build.log', "E: Version '3.5.5-1ubuntu3.5' for 'openssl'", "E: Version '3.5.5-1ubuntu3.4' for 'openssl'"),
                (amd64, 'build6.log', 'Inst libdrm-intel1 (2.4.131-1 ', 'Inst libdrm-intel1 (2.4.131-2 '),
                (arm64, 'SHA256SUMS', '  Dockerfile', '  Dockerfile ')):
            with self.subTest(directory=directory, name=name), tempfile.TemporaryDirectory() as base:
                altered = self.copied_base(base, directory) / name
                text = altered.read_text(encoding='utf-8')
                self.assertIn(old, text)
                altered.write_text(text.replace(old, new), encoding='utf-8')
                result, written = self.derive(base)
                self.assertEqual((result.returncode, written), (1, {}))
                self.assertIn(f'{name}: SHA256', result.stderr)

    def test_derivation_refuses_an_altered_packet(self):
        with tempfile.TemporaryDirectory() as base:
            for entry in support.EVIDENCE.iterdir():
                if entry.name.startswith(EVIDENCE_DIRS):
                    Path(base, entry.name).symlink_to(entry)
            packet = Path(base, 'ubuntu-runtime-packaging-inputs-v1')
            packet.unlink()
            packet.mkdir()
            for path in support.PACKET.iterdir():
                packet.joinpath(path.name).write_bytes(path.read_bytes())
            candidate = packet / 'ubuntu-os-candidate.Dockerfile'
            candidate.write_text(candidate.read_text().replace('libexpat1=2.7.4-1ubuntu0.2', 'libexpat1=2.7.4-1ubuntu0.3'))
            result = subprocess.run([sys.executable, '-B', str(support.PACKAGE / 'tools/derive_lock.py'),
                                     '--base', base, '--out', f'{base}/l.json', '--os-packages', f'{base}/o.txt'],
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertIn('ubuntu-os-candidate.Dockerfile: SHA256', result.stderr)


if __name__ == '__main__':
    unittest.main()
