"""curl HTTP/3 rebuild: signed source inputs, the tested three-file change, builder guards and package identity."""
import copy
import io
import shutil
import subprocess
import tarfile
import tempfile
import unittest
from pathlib import Path

import support
from support import ohpkg

import curl_http3

ORIGINALS = {
    'curl_8.18.0-1ubuntu2.7.debian.tar.xz': 'candidate/context/provenance/original-curl_8.18.0-1ubuntu2.7.debian.tar.xz',
    'curl_8.18.0-1ubuntu2.7.dsc': 'candidate/context/provenance/original-curl_8.18.0-1ubuntu2.7.dsc',
    'curl_8.18.0.orig.tar.gz': 'candidate/context/provenance/original-curl_8.18.0.orig.tar.gz',
    'curl_8.18.0.orig.tar.gz.asc': 'candidate/context/provenance/original-curl_8.18.0.orig.tar.gz.asc',
}
HAVE_CURL = support.needs(support.CURL / 'evidence.tar.gz', support.CURL / 'receipt.json')


def real_sources(directory):
    for name, member in ORIGINALS.items():
        (Path(directory) / name).write_bytes(support.curl_evidence_member(member))


def unpack_debian(debian_tar_xz, src):
    with tarfile.open(debian_tar_xz) as tar:
        for member in tar:
            if member.isfile():
                target = Path(src) / member.name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())


class SourceInputs(unittest.TestCase):
    """Synthetic signed-source set: every altered input must be refused."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.lock = copy.deepcopy(support.load_lock())
        files = {'curl_8.18.0.orig.tar.gz': b'upstream source', 'curl_8.18.0.orig.tar.gz.asc': b'signature',
                 'curl_8.18.0-1ubuntu2.7.debian.tar.xz': b'debian packaging'}
        for name, data in files.items():
            (self.dir / name).write_bytes(data)
        checksums = ''.join(f'\n {support.sha256(d)} {len(d)} {n}' for n, d in files.items())
        dsc = ('-----BEGIN PGP SIGNED MESSAGE-----\nHash: SHA512\n\nFormat: 3.0 (quilt)\nSource: curl\n'
               f'Version: 8.18.0-1ubuntu2.7\nChecksums-Sha256:{checksums}\n\n-----BEGIN PGP SIGNATURE-----\nx\n'
               '-----END PGP SIGNATURE-----\n').encode()
        (self.dir / 'curl_8.18.0-1ubuntu2.7.dsc').write_bytes(dsc)
        files['curl_8.18.0-1ubuntu2.7.dsc'] = dsc
        self.lock['curl']['source']['files'] = {n: {'bytes': len(d), 'sha256': support.sha256(d)} for n, d in files.items()}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_exact_signed_source_passes(self):
        self.assertEqual(curl_http3.verify_source(self.lock, self.dir), 'curl_8.18.0-1ubuntu2.7.dsc')

    def test_altered_bytes_or_size_fail(self):
        (self.dir / 'curl_8.18.0.orig.tar.gz').write_bytes(b'upstream sourcf')
        with self.assertRaisesRegex(ohpkg.InputError, 'orig.tar.gz: SHA256 differs'):
            curl_http3.verify_source(self.lock, self.dir)
        (self.dir / 'curl_8.18.0.orig.tar.gz').write_bytes(b'upstream sourc')
        with self.assertRaisesRegex(ohpkg.InputError, 'orig.tar.gz: 14 bytes, locked 15'):
            curl_http3.verify_source(self.lock, self.dir)

    def test_extra_or_missing_files_fail(self):
        (self.dir / 'extra.patch').write_text('x')
        with self.assertRaisesRegex(ohpkg.InputError, 'source files .* != locked'):
            curl_http3.verify_source(self.lock, self.dir)
        (self.dir / 'extra.patch').unlink()
        (self.dir / 'curl_8.18.0.orig.tar.gz.asc').unlink()
        with self.assertRaisesRegex(ohpkg.InputError, 'source files .* != locked'):
            curl_http3.verify_source(self.lock, self.dir)

    def test_dsc_must_describe_exactly_the_locked_files(self):
        path = self.dir / 'curl_8.18.0-1ubuntu2.7.dsc'
        altered = path.read_bytes().replace(b'Version: 8.18.0-1ubuntu2.7', b'Version: 8.18.0-1ubuntu2.8')
        path.write_bytes(altered)
        self.lock['curl']['source']['files'][path.name] = {'bytes': len(altered), 'sha256': support.sha256(altered)}
        with self.assertRaisesRegex(ohpkg.InputError, 'unexpected identity'):
            curl_http3.verify_source(self.lock, self.dir)
        entry = self.lock['curl']['source']['files']['curl_8.18.0.orig.tar.gz.asc']
        path.write_bytes(altered.replace(b'1ubuntu2.8', b'1ubuntu2.7').replace(entry['sha256'].encode(), b'0' * 64))
        data = path.read_bytes()
        self.lock['curl']['source']['files'][path.name] = {'bytes': len(data), 'sha256': support.sha256(data)}
        with self.assertRaisesRegex(ohpkg.InputError, 'orig.tar.gz.asc differs from the lock'):
            curl_http3.verify_source(self.lock, self.dir)


@HAVE_CURL
class TestedChange(unittest.TestCase):
    """The three-file change applied to Ubuntu's real curl packaging reproduces root's tested patch exactly."""

    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.lock = support.load_lock()
        real_sources(self.dir)
        self.src = self.dir / 'curl-8.18.0'
        unpack_debian(self.dir / 'curl_8.18.0-1ubuntu2.7.debian.tar.xz', self.src)

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_real_signed_source_matches_the_lock(self):
        self.assertEqual(curl_http3.verify_source(self.lock, self.dir), 'curl_8.18.0-1ubuntu2.7.dsc')

    def test_change_reproduces_the_tested_patch_and_files(self):
        before = (self.src / 'debian/rules').read_text().splitlines()
        patch, hashes = curl_http3.apply_change(self.src, self.lock['curl']['rebuild'])
        self.assertEqual(support.sha256(patch.encode()), support.TESTED_PATCH_SHA256)
        self.assertEqual(patch.encode(), support.curl_evidence_member('build-tests/work/evidence/http3-packaging.patch'))
        self.assertEqual(hashes, self.lock['curl']['rebuild']['expectedFiles'])
        after = (self.src / 'debian/rules').read_text().splitlines()
        changed = [(a, b) for a, b in zip(before, after) if a != b]
        self.assertEqual(changed, [('\t$(call configure-curl,openssl)',
                                    '\t$(call configure-curl,openssl,--with-nghttp3 --with-openssl-quic)')])
        for kept in ('\t$(call configure-curl,gnutls)', '\t$(call test-curl,openssl)', '\t$(call test-curl,gnutls)',
                     '$(MAKE) $(MAKE_EXTRA_FLAGS) test-nonflaky'):
            self.assertIn(kept, after)

    def test_tested_patch_adds_nghttp3_twice_to_build_depends_and_not_to_the_dev_package(self):
        curl_http3.apply_change(self.src, self.lock['curl']['rebuild'])
        paragraphs = ohpkg.parse_deb822((self.src / 'debian/control').read_text())
        build_depends = paragraphs[0]['Build-Depends']
        self.assertEqual(build_depends.count('libnghttp3-dev (>= 1.12.0)'), 2)
        openssl_dev = next(p for p in paragraphs if p.get('Package') == 'libcurl4-openssl-dev')
        self.assertNotIn('libnghttp3-dev', openssl_dev['Depends'])

    def test_already_patched_or_moved_anchors_are_refused_without_writing(self):
        rebuild = self.lock['curl']['rebuild']
        rules = self.src / 'debian/rules'
        original = rules.read_text()
        cases = [
            ('debian/rules', original.replace(rebuild['rulesAnchor'], 'changed'), 'is not unique'),
            ('debian/rules', original + '\n\t' + rebuild['rulesAnchor'] + '\n', 'is not unique'),
            ('debian/rules', original.replace(rebuild['rulesAnchor'], rebuild['rulesAnchor'] + '\n#' + rebuild['rulesReplacement']),
             'already patched'),
            ('debian/control', (self.src / 'debian/control').read_text() + '\n# libnghttp3-dev\n', 'already mentions'),
            ('debian/control', (self.src / 'debian/control').read_text().replace('libnghttp2-dev,\n', 'libnghttp2-dev ,\n'),
             'anchor .* not found'),
            ('debian/changelog', '\n'.join(rebuild['changelogEntry']) + '\n' + (self.src / 'debian/changelog').read_text(),
             'already has the rebuild entry'),
            ('debian/rules', original.replace('override_dh_auto_configure:', 'override_dh_auto_configure: '), 'differs from the tested patch'),
            ('debian/changelog', (self.src / 'debian/changelog').read_text() + '\nextra\n', 'changed files differ'),
        ]
        for name, content, message in cases:
            with self.subTest(message=message):
                backup = {n: (self.src / n).read_text() for n in curl_http3.CHANGED}
                (self.src / name).write_text(content)
                before = {n: (self.src / n).read_text() for n in curl_http3.CHANGED}
                with self.assertRaisesRegex(ohpkg.InputError, message):
                    curl_http3.apply_change(self.src, rebuild)
                self.assertEqual({n: (self.src / n).read_text() for n in curl_http3.CHANGED}, before, 'nothing written')
                for n, text in backup.items():
                    (self.src / n).write_text(text)


class FakeBuild:
    """Stands in for dpkg-source/dpkg-buildpackage; writes synthetic packages with chosen identities."""

    def __init__(self, debian_tar, identities=None):
        self.debian_tar, self.identities, self.calls = debian_tar, identities or {}, []

    def __call__(self, command, cwd=None, check=False, capture_output=False, text=False, env=None):
        self.calls.append((command, str(cwd)))
        stdout = ''
        if command == ['dpkg', '--print-architecture']:
            stdout = 'arm64\n'
        elif command[:2] == ['dpkg-source', '-x']:
            unpack_debian(self.debian_tar, Path(cwd) / 'curl-8.18.0')
            (Path(cwd) / 'curl-8.18.0' / 'README').write_text('upstream')
        elif command[:2] == ['dpkg-source', '-b']:
            for suffix in ('.dsc', '.debian.tar.xz'):
                (Path(cwd) / f'curl_8.18.0-1ubuntu2.7+openharness.http3.1{suffix}').write_text('rebuilt source')
        elif command[0] == 'dpkg-buildpackage':
            version = '8.18.0-1ubuntu2.7+openharness.http3.1'
            work = Path(cwd).parent
            for name in ('curl', 'libcurl4t64', 'libcurl3t64-gnutls', 'libcurl4-openssl-dev', 'libcurl4-gnutls-dev'):
                package, ver, arch, source = self.identities.get(name, (name, version, 'arm64', 'curl'))
                support.make_deb(work / f'{name}_{version}_arm64.deb', package, ver, arch, source)
            support.make_deb(work / f'libcurl4-doc_{version}_all.deb', 'libcurl4-doc', version, 'all', 'curl')
            support.make_deb(work / f'curl-dbgsym_{version}_arm64.ddeb', 'curl-dbgsym', version, 'arm64', 'curl')
            for suffix in ('_arm64.buildinfo', '_arm64.changes'):
                (work / f'curl_{version}{suffix}').write_text('build record')
        return subprocess.CompletedProcess(command, 0, stdout, '')


@HAVE_CURL
class OfflineBuildFlow(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.lock = support.load_lock()
        self.work, self.out = self.dir / 'work', self.dir / 'out'
        self.work.mkdir()
        real_sources(self.work)
        self.builder_provenance = self.dir / 'build-provenance'
        self.builder_provenance.mkdir()
        (self.builder_provenance / 'packages.tsv').write_text('dpkg-dev\t1.23.7ubuntu1\tarm64\n')
        self.debian_tar = self.dir / 'debian.tar.xz'
        shutil.copy(self.work / 'curl_8.18.0-1ubuntu2.7.debian.tar.xz', self.debian_tar)
        self.guard = lambda rebuild: {'uid': 10001, 'interfacesUp': ['lo'], 'pidsMax': 'max'}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def test_outputs_only_the_three_runtime_packages_and_full_provenance(self):
        fake = FakeBuild(self.debian_tar)
        result = curl_http3.build(self.lock, self.work, self.out, self.builder_provenance, run=fake, builder=self.guard)
        self.assertEqual(result['builtPackages'], 7)
        debs = sorted(p.name.split('_')[0] for p in (self.out / 'debs').iterdir())
        self.assertEqual(debs, ['curl', 'libcurl3t64-gnutls', 'libcurl4t64'])
        others = sorted(p.name.split('_')[0] for p in (self.out / 'other-packages').iterdir())
        self.assertEqual(others, ['curl-dbgsym', 'libcurl4-doc', 'libcurl4-gnutls-dev', 'libcurl4-openssl-dev'])
        provenance = self.out / 'provenance'
        self.assertEqual(sorted(p.name for p in (provenance / 'original-source').iterdir()), sorted(ORIGINALS))
        self.assertEqual(support.sha256((provenance / 'http3-packaging.patch').read_bytes()), support.TESTED_PATCH_SHA256)
        self.assertEqual(sorted(p.name for p in (provenance / 'build').iterdir()),
                         sorted(f'curl_8.18.0-1ubuntu2.7+openharness.http3.1{s}'
                                for s in ('.dsc', '.debian.tar.xz', '_arm64.buildinfo', '_arm64.changes')))
        self.assertTrue((provenance / 'builder' / 'packages.tsv').is_file())
        self.assertEqual(len(support.read_json(provenance / 'built-packages.json')), 7)
        invocation = support.read_json(provenance / 'invocation.json')
        self.assertEqual(invocation['command'], ['dpkg-buildpackage', '-us', '-uc', '-b', '-j4'])
        commands = [c for c, _ in fake.calls]
        self.assertEqual(commands[-1], ['dpkg-buildpackage', '-us', '-uc', '-b', '-j4'])
        self.assertIn(['dpkg-checkbuilddeps'], commands)
        self.assertFalse(any('-nc' in c or 'nocheck' in ' '.join(c) for c in commands))

    def test_unexpected_runtime_package_identity_fails(self):
        version = '8.18.0-1ubuntu2.7+openharness.http3.1'
        for identities, message in (({'libcurl4t64': ('libcurl4t64', version, 'arm64', 'curl-fork')}, 'identity'),
                                    ({'curl': ('curl', '8.18.0-1ubuntu2.7', 'arm64', 'curl')}, 'identity'),
                                    ({'libcurl3t64-gnutls': ('libcurl3t64-gnutls', version, 'amd64', 'curl')}, 'identity')):
            with self.subTest(identities=identities):
                shutil.rmtree(self.work)
                self.work.mkdir()
                real_sources(self.work)
                shutil.rmtree(self.out, ignore_errors=True)
                with self.assertRaisesRegex(ohpkg.InputError, message):
                    curl_http3.build(self.lock, self.work, self.out, run=FakeBuild(self.debian_tar, identities), builder=self.guard)

    def test_altered_source_stops_before_unpacking(self):
        path = self.work / 'curl_8.18.0.orig.tar.gz'
        data = bytearray(path.read_bytes())
        data[100] ^= 1
        path.write_bytes(bytes(data))
        fake = FakeBuild(self.debian_tar)
        with self.assertRaisesRegex(ohpkg.InputError, 'SHA256 differs'):
            curl_http3.build(self.lock, self.work, self.out, run=fake, builder=self.guard)
        self.assertEqual(fake.calls, [])

    def test_non_empty_output_is_refused(self):
        self.out.mkdir()
        (self.out / 'stale.deb').write_text('x')
        with self.assertRaisesRegex(ohpkg.InputError, 'must be empty'):
            curl_http3.build(self.lock, self.work, self.out, run=FakeBuild(self.debian_tar), builder=self.guard)


class BuilderGuard(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.rebuild = support.load_lock()['curl']['rebuild']

    def tearDown(self):
        shutil.rmtree(self.dir)

    def net(self, **interfaces):
        directory = self.dir / f'net{len(list(self.dir.iterdir()))}'
        for name, flags in interfaces.items():
            (directory / name).mkdir(parents=True)
            (directory / name / 'flags').write_text(flags + '\n')
        directory.mkdir(exist_ok=True)
        return directory

    def pids(self, value):
        path = self.dir / f'pids{len(list(self.dir.iterdir()))}'
        path.write_text(value + '\n')
        return path

    def check(self, uid=10001, net=None, pids=None, env=None):
        return curl_http3.check_builder(self.rebuild, uid, net or self.net(lo='0x9'), pids or self.pids('max'), env or {})

    def test_tested_limits_pass(self):
        self.assertEqual(self.check()['interfacesUp'], ['lo'])
        self.check(pids=self.pids('2048'))
        self.check(net=self.net(lo='0x9', tunl0='0x80', sit0='0x80'))

    def test_root_or_other_uid_fails(self):
        for uid in (0, 1000):
            with self.assertRaisesRegex(ohpkg.InputError, 'must run as uid 10001'):
                self.check(uid=uid)

    def test_network_fails_closed(self):
        with self.assertRaisesRegex(ohpkg.InputError, r"interfaces up during the offline build: \['eth0', 'lo'\]"):
            self.check(net=self.net(lo='0x9', eth0='0x1003'))
        with self.assertRaisesRegex(ohpkg.InputError, r'interfaces up during the offline build: \[\]'):
            self.check(net=self.net(lo='0x8'))

    def test_process_limit_below_the_tested_value_fails(self):
        with self.assertRaisesRegex(ohpkg.InputError, 'pids limit 512 < 2048'):
            self.check(pids=self.pids('512'))

    def test_unreadable_limits_are_recorded_not_guessed(self):
        result = curl_http3.check_builder(self.rebuild, 10001, self.net(lo='0x9'), (str(self.dir / 'none'),), {},
                                          (str(self.dir / 'none'),))
        self.assertEqual((result['pidsMax'], result['memoryMax']), ('unknown', 'unknown'))
        v1 = self.dir / 'v1'
        v1.mkdir()
        (v1 / 'pids.max').write_text('512\n')
        with self.assertRaisesRegex(ohpkg.InputError, 'pids limit 512 < 2048'):
            curl_http3.check_builder(self.rebuild, 10001, self.net(lo='0x9'), (str(self.dir / 'none'), str(v1 / 'pids.max')), {})

    def test_build_option_overrides_fail(self):
        for env in ({'DEB_BUILD_OPTIONS': 'nocheck'}, {'DEB_BUILD_PROFILES': 'nocheck'}, {'DEB_BUILD_OPTIONS': 'parallel=1'},
                    {'DEB_CFLAGS_APPEND': '-O0'}, {'DEB_BUILD_MAINT_OPTIONS': 'hardening=-all'}):
            with self.assertRaisesRegex(ohpkg.InputError, 'would change the tested build'):
                self.check(env=env)


class RuntimeIdentity(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.lock = support.load_lock()
        self.version = self.lock['curl']['rebuild']['version']

    def tearDown(self):
        shutil.rmtree(self.dir)

    def write(self, arch='arm64', overrides=None):
        for name in self.lock['curl']['rebuild']['runtimePackages']:
            package, version, deb_arch, source = (overrides or {}).get(name, (name, self.version, arch, 'curl'))
            support.make_deb(self.dir / f'{name}_{self.version}_{arch}.deb', package, version, deb_arch, source)

    def test_runtime_packages(self):
        self.write()
        self.assertEqual(len(curl_http3.verify_runtime_debs(self.lock, 'arm64', self.dir)), 3)
        with self.assertRaisesRegex(ohpkg.InputError, 'runtime packages'):
            curl_http3.verify_runtime_debs(self.lock, 'amd64', self.dir)
        support.make_deb(self.dir / f'libcurl4-openssl-dev_{self.version}_arm64.deb', 'libcurl4-openssl-dev',
                         self.version, 'arm64', 'curl')
        with self.assertRaisesRegex(ohpkg.InputError, 'runtime packages'):
            curl_http3.verify_runtime_debs(self.lock, 'arm64', self.dir)

    def test_ubuntu_or_foreign_packages_are_refused(self):
        self.write(overrides={'curl': ('curl', '8.18.0-1ubuntu2.7', 'arm64', 'curl')})
        with self.assertRaisesRegex(ohpkg.InputError, 'identity'):
            curl_http3.verify_runtime_debs(self.lock, 'arm64', self.dir)


class RuntimeVersionOutput(unittest.TestCase):
    TESTED = support.CURL / 'candidate' / 'curl.stdout'

    def setUp(self):
        self.lock = support.load_lock()
        if self.TESTED.exists():
            self.text = self.TESTED.read_text()
        else:
            runtime = self.lock['curl']['expectedRuntime']
            self.text = (f'curl 8.18.0 (aarch64-unknown-linux-gnu) {" ".join(runtime["libraries"])}\n'
                         f'Release-Date: 2026-01-07, security patched: {self.lock["curl"]["rebuild"]["version"]}\n'
                         f'Protocols: {" ".join(runtime["protocols"])}\nFeatures: {" ".join(runtime["features"])}\n')

    def test_tested_output_passes_for_its_architecture_only(self):
        curl_http3.check_runtime(self.lock, self.text, 'arm64')
        with self.assertRaisesRegex(ohpkg.InputError, 'built for aarch64-unknown-linux-gnu, not amd64'):
            curl_http3.check_runtime(self.lock, self.text, 'amd64')
        curl_http3.check_runtime(self.lock, self.text.replace('aarch64-unknown-linux-gnu', 'x86_64-pc-linux-gnu'), 'amd64')

    def test_changed_capabilities_fail(self):
        for old, new, message in ((' HTTP3', '', 'features differ'), (' ws wss', ' ws', 'protocols differ'),
                                  ('nghttp3/1.12.0 ', '', 'library versions differ'),
                                  ('+openharness.http3.1', '', 'does not report the rebuilt version')):
            with self.assertRaisesRegex(ohpkg.InputError, message):
                curl_http3.check_runtime(self.lock, self.text.replace(old, new, 1))


if __name__ == '__main__':
    unittest.main()
