"""Debian browser inputs: exact bytes, sizes, signed-index metadata and package identity, with a fake APT."""
import copy
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

import support
from support import ohpkg

import debian_inputs


class DebianInputs(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.packages = self.dir / 'packages'
        self.lock, self.contents = support.synthetic_debian(self.packages)
        self.metadata = self.dir / 'metadata'
        self.metadata.mkdir()
        for name, record in self.lock['debian']['packages']['arm64'].items():
            (self.metadata / f'{name}.metadata').write_text(support.apt_show(record))

    def tearDown(self):
        shutil.rmtree(self.dir)

    def rewrite(self, name, **changes):
        """Replace one .deb with a differently built one and (optionally) authenticate it in the lock."""
        record = self.lock['debian']['packages']['arm64'][name]
        path = self.contents[name]['path']
        spec = {'package': name, 'version': record['Version'], 'arch': 'arm64', 'source': record.get('Source'),
                'files': self.contents[name]['files'], 'links': self.contents[name]['links']}
        authenticate = changes.pop('authenticate', True)
        spec.update(changes)
        blob = support.make_deb(path, **spec)
        if authenticate:
            record.update(SHA256=support.sha256(blob), Size=len(blob))

    def test_exact_inputs_pass(self):
        review = debian_inputs.verify_packages(self.lock, 'arm64', self.packages)
        self.assertEqual(sorted(review), ['chromium', 'chromium-common', 'libjpeg62-turbo'])
        self.assertEqual(review['libjpeg62-turbo']['SourceName'], 'libjpeg-turbo')
        self.assertEqual(review['libjpeg62-turbo']['SourceVersion'], '1:2.1.5-4')
        debian_inputs.verify_metadata(self.lock, 'arm64', self.metadata)
        self.assertEqual(debian_inputs.plan(self.lock, 'arm64'),
                         ['chromium:arm64=154.0.8037.57-1~deb13u1', 'chromium-common:arm64=154.0.8037.57-1~deb13u1',
                          'libjpeg62-turbo:arm64=1:2.1.5-4'])

    def test_altered_bytes_fail(self):
        path = self.contents['chromium']['path']
        data = bytearray(path.read_bytes())
        data[-5] ^= 1
        path.write_bytes(bytes(data))
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium: SHA256 .* differs from the authenticated record'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)

    def test_size_mismatch_fails(self):
        with open(self.contents['chromium-common']['path'], 'ab') as handle:
            handle.write(b'\0')
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium-common: .* bytes, locked'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)

    def test_unexpected_version_identity_fails_even_when_bytes_are_authenticated(self):
        self.rewrite('chromium', version='150.0.7871.181-1~deb13u1')
        self.lock['debian']['packages']['arm64']['chromium']['Version'] = '154.0.8037.57-1~deb13u1'
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium: control identity'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)

    def test_unexpected_source_identity_fails(self):
        self.rewrite('chromium-common', source='chromium-fork')
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium-common: control identity'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)

    def test_unexpected_package_name_fails(self):
        self.rewrite('libjpeg62-turbo', package='libjpeg62')
        with self.assertRaisesRegex(ohpkg.InputError, 'libjpeg62-turbo: control identity'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)

    def test_wrong_architecture_package_fails(self):
        self.rewrite('libjpeg62-turbo', arch='amd64')
        with self.assertRaisesRegex(ohpkg.InputError, 'libjpeg62-turbo: control identity'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)
        amd64 = self.dir / 'amd64'
        support.synthetic_debian(amd64, 'amd64')
        with self.assertRaisesRegex(ohpkg.InputError, 'expected exactly one arm64 .deb'):
            debian_inputs.verify_packages(self.lock, 'arm64', amd64)

    def test_extra_missing_or_duplicate_files_fail(self):
        (self.packages / 'notes.txt').write_text('x')
        with self.assertRaisesRegex(ohpkg.InputError, 'unexpected files'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)
        (self.packages / 'notes.txt').unlink()
        shutil.copy(self.contents['chromium']['path'], self.packages / 'chromium_1.0_arm64.deb')
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium: expected exactly one arm64 .deb'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)
        (self.packages / 'chromium_1.0_arm64.deb').unlink()
        self.contents['libjpeg62-turbo']['path'].unlink()
        with self.assertRaisesRegex(ohpkg.InputError, 'libjpeg62-turbo: expected exactly one'):
            debian_inputs.verify_packages(self.lock, 'arm64', self.packages)

    def test_signed_index_metadata_must_describe_the_same_file(self):
        for field, value, message in (('SHA256', '0' * 64, 'SHA256'), ('Filename', 'pool/main/c/other.deb', 'Filename'),
                                      ('Size', 1, 'Size')):
            lock = copy.deepcopy(self.lock)
            lock['debian']['packages']['arm64']['chromium'][field] = value
            with self.assertRaisesRegex(ohpkg.InputError, message):
                debian_inputs.verify_metadata(lock, 'arm64', self.metadata)
        path = self.metadata / 'chromium.metadata'
        path.write_text(path.read_text() + '\n' + path.read_text())
        with self.assertRaisesRegex(ohpkg.InputError, 'expected one chromium .* stanza, found 2'):
            debian_inputs.verify_metadata(self.lock, 'arm64', self.metadata)
        path.unlink()
        with self.assertRaisesRegex(ohpkg.InputError, 'missing signed-index metadata chromium.metadata'):
            debian_inputs.verify_metadata(self.lock, 'arm64', self.metadata)

    def test_install_args_lists_the_packages_then_the_pinned_ubuntu_dependencies(self):
        lock_path = support.write_lock(self.lock, self.dir / 'lock.json')
        result = support.run_helper('debian_inputs.py', 'install-args', '--lock', lock_path, '--arch', 'arm64',
                                    '--packages', str(self.packages))
        self.assertEqual(result.returncode, 0, result.stderr)
        lines = result.stdout.splitlines()
        self.assertEqual([Path(line).name.split('_')[0] for line in lines[:3]], ['chromium', 'chromium-common', 'libjpeg62-turbo'])
        self.assertTrue(all(Path(line).is_absolute() for line in lines[:3]))
        self.assertEqual(lines[3:], self.lock['ubuntu']['chromiumDependencies']['arm64'])
        self.contents['chromium']['path'].write_bytes(b'!<arch>\n')
        result = support.run_helper('debian_inputs.py', 'install-args', '--lock', lock_path, '--arch', 'arm64',
                                    '--packages', str(self.packages))
        self.assertEqual((result.returncode, result.stdout), (1, ''))
        self.assertIn('debian_inputs: chromium:', result.stderr)


class FakeApt:
    """Stands in for apt-cache/apt-get in the Debian input stage; can serve altered answers."""

    def __init__(self, lock, source_dir, show=None, download=None):
        self.lock, self.source_dir, self.show, self.download, self.calls = lock, Path(source_dir), show, download, []

    def __call__(self, command, cwd=None, check=False, capture_output=False, text=False):
        self.calls.append(command)
        records = self.lock['debian']['packages']['arm64']
        if command[:2] == ['apt-cache', 'show']:
            name = command[2].split(':', 1)[0]
            stdout = (self.show or support.apt_show)(records[name])
        elif command[:2] == ['apt-cache', 'showsrc']:
            stdout = f'Package: {command[2]}\nBinary: synthetic\n'
        elif command[:2] == ['apt-get', 'download']:
            for spec in command[2:]:
                name = spec.split(':', 1)[0]
                source = next(self.source_dir.glob(f'{name}_*.deb'))
                shutil.copy(source, Path(cwd) / source.name)
                if self.download:
                    self.download(Path(cwd) / source.name)
            stdout = ''
        else:
            raise AssertionError(command)
        return subprocess.CompletedProcess(command, 0, stdout, '')


class DebianFetch(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.lock, _ = support.synthetic_debian(self.dir / 'mirror')
        self.lists = self.dir / 'lists'
        self.lists.mkdir()
        (self.lists / 'deb.debian.org_debian_dists_trixie_InRelease').write_text('signed')
        self.sources = self.dir / 'sources'
        self.sources.mkdir()
        (self.sources / 'debian.sources').write_text('Types: deb deb-src\n')
        self.os_release = self.dir / 'os-release'
        self.os_release.write_text('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nID=debian\nVERSION_ID="13"\n')
        self.debian_version = self.dir / 'debian_version'
        self.debian_version.write_text('13.7\n')

    def tearDown(self):
        shutil.rmtree(self.dir)

    def fetch(self, apt, out=None):
        return debian_inputs.fetch(self.lock, 'arm64', out or self.dir / 'out', run=apt, apt_lists=self.lists,
                                   apt_sources=self.sources, os_release=self.os_release, debian_version=self.debian_version)

    def test_fetch_writes_verified_inputs_and_provenance(self):
        apt = FakeApt(self.lock, self.dir / 'mirror')
        review = self.fetch(apt)
        out = self.dir / 'out'
        self.assertEqual(len(list((out / 'packages').iterdir())), 3)
        self.assertEqual(sorted(p.name for p in (out / 'metadata' / 'apt').iterdir()),
                         ['deb.debian.org_debian_dists_trixie_InRelease', 'debian.sources'])
        self.assertTrue((out / 'metadata' / 'chromium.source-metadata').is_file())
        self.assertTrue((out / 'metadata' / 'libjpeg-turbo.source-metadata').is_file())
        self.assertEqual((out / 'debian-os' / 'debian_version').read_text(), '13.7\n')
        self.assertEqual(support.read_json(out / 'metadata' / 'package-review.json')['packages'], review)
        downloads = [c for c in apt.calls if c[:2] == ['apt-get', 'download']]
        self.assertEqual(downloads, [['apt-get', 'download', *debian_inputs.plan(self.lock, 'arm64')]])

    def test_metadata_mismatch_stops_before_download(self):
        apt = FakeApt(self.lock, self.dir / 'mirror', show=lambda r: support.apt_show({**r, 'SHA256': 'f' * 64}))
        with self.assertRaisesRegex(ohpkg.InputError, 'SHA256'):
            self.fetch(apt)
        self.assertFalse([c for c in apt.calls if c[:2] == ['apt-get', 'download']])

    def test_altered_download_fails(self):
        def corrupt(path):
            data = bytearray(path.read_bytes())
            data[-3] ^= 0xff
            path.write_bytes(bytes(data))
        with self.assertRaisesRegex(ohpkg.InputError, 'differs from the authenticated record'):
            self.fetch(FakeApt(self.lock, self.dir / 'mirror', download=corrupt))

    def test_unsigned_or_non_debian_input_stage_fails(self):
        for path in self.lists.iterdir():
            path.unlink()
        with self.assertRaisesRegex(ohpkg.InputError, 'no signed InRelease files'):
            self.fetch(FakeApt(self.lock, self.dir / 'mirror'))
        (self.lists / 'x_InRelease').write_text('signed')
        self.os_release.write_text('ID=ubuntu\n')
        with self.assertRaisesRegex(ohpkg.InputError, 'the input stage is not Debian'):
            self.fetch(FakeApt(self.lock, self.dir / 'mirror'), self.dir / 'out2')

    def test_output_must_start_empty(self):
        out = self.dir / 'out'
        out.mkdir()
        (out / 'stale.deb').write_text('x')
        with self.assertRaisesRegex(ohpkg.InputError, 'must be empty'):
            self.fetch(FakeApt(self.lock, self.dir / 'mirror'))


if __name__ == '__main__':
    unittest.main()


class SnapshotSources(unittest.TestCase):
    def test_signed_snapshot_sources_keep_binary_and_source_packages(self):
        lock = support.load_lock()
        text = debian_inputs.snapshot_sources(lock)
        snapshot = lock['ubuntu']['snapshot']
        for archive in ('debian', 'debian-security'):
            self.assertIn(f'https://snapshot.debian.org/archive/{archive}/{snapshot}/', text)
        self.assertEqual(text.count('Types: deb deb-src'), 2)
        self.assertEqual(text.count('Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg'), 2)
        self.assertEqual(text.count('Check-Valid-Until: no'), 2)
        for forbidden in ('trusted=yes', 'Allow-Insecure', 'deb.debian.org'):
            self.assertNotIn(forbidden, text)

    def test_invalid_snapshot_or_suite_is_rejected(self):
        for snapshot in ('20260929T180000Z\nTrusted: yes', '20261329T180000Z', ''):
            lock = support.load_lock()
            lock['ubuntu']['snapshot'] = snapshot
            with self.assertRaisesRegex(ohpkg.InputError, 'invalid snapshot timestamp'):
                debian_inputs.snapshot_sources(lock)
        lock = support.load_lock()
        lock['debian']['suite'] = 'trixie\nTrusted: yes'
        with self.assertRaisesRegex(ohpkg.InputError, 'unsupported Debian snapshot suite'):
            debian_inputs.snapshot_sources(lock)
