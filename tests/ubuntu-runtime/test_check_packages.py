"""Final package-set gate: the installed dpkg database must equal the locked set exactly."""
import copy
import shutil
import tempfile
import unittest
from pathlib import Path

import support
from support import ohpkg

import check_packages


def status_text(packages, extra=''):
    paragraphs = []
    for name, (version, arch) in sorted(packages.items()):
        paragraphs.append(f'Package: {name}\nStatus: install ok installed\nArchitecture: {arch}\nVersion: {version}\n'
                          f'Description: test\n continuation line\n')
    return '\n'.join(paragraphs) + extra


class FinalPackageSet(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.lock = support.load_lock()
        self.expected = {k: list(v) for k, v in self.lock['finalPackages']['arm64'].items()}

    def tearDown(self):
        shutil.rmtree(self.dir)

    def status(self, packages, extra=''):
        path = self.dir / 'status'
        path.write_text(status_text(packages, extra))
        return path

    def test_exact_set_passes_and_reports(self):
        path = self.status(self.expected, '\nPackage: removed-tool\nStatus: deinstall ok config-files\nVersion: 1\n')
        report = self.dir / 'report.json'
        result = support.run_helper('check_packages.py', '--lock', str(support.LOCK), '--arch', 'arm64', '--status', str(path),
                                    '--os-packages', str(support.OS_PACKAGES), '--report', str(report))
        self.assertEqual(result.returncode, 0, result.stderr)
        data = support.read_json(report)
        self.assertEqual((data['installed'], data['locked'], data['missing'], data['unexpected'], data['different']),
                         (329, 329, [], {}, {}))
        self.assertEqual(data['lockSha256'], support.sha256(support.LOCK.read_bytes()))
        self.assertIn('has not been built', data['validation'])

    def test_missing_extra_reversioned_or_foreign_packages_fail(self):
        cases = []
        missing = dict(self.expected)
        missing.pop('chromium')
        cases.append((missing, 'missing'))
        extra = dict(self.expected, **{'libjpeg62': ['1:9e-1ubuntu1', 'arm64']})
        cases.append((extra, 'unexpected'))
        ubuntu_curl = dict(self.expected, curl=['8.18.0-1ubuntu2.7', 'arm64'])
        cases.append((ubuntu_curl, 'different'))
        foreign = dict(self.expected, **{'libnghttp3-9': ['1.12.0-1', 'amd64']})
        cases.append((foreign, 'different'))
        for packages, kind in cases:
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(ohpkg.InputError, kind):
                    result = check_packages.check(self.lock, 'arm64', self.status(packages))
                    problems = {k: result[k] for k in ('missing', 'unexpected', 'different') if result[k]}
                    ohpkg.require(not problems, f'differs: {problems}')

    def test_observed_amd64_database_passes_and_reports(self):
        path = self.status({k: list(v) for k, v in self.lock['finalPackages']['amd64'].items()})
        report = self.dir / 'amd64.json'
        result = support.run_helper('check_packages.py', '--lock', str(support.LOCK), '--arch', 'amd64', '--status', str(path),
                                    '--os-packages', str(support.OS_PACKAGES), '--report', str(report))
        self.assertEqual(result.returncode, 0, result.stderr)
        data = support.read_json(report)
        self.assertEqual((data['installed'], data['locked'], data['missing'], data['unexpected'], data['different']),
                         (331, 331, [], {}, {}))
        self.assertIn('This lock has not been built for AMD64', data['validation'])

    def test_previous_amd64_set_reproduces_the_recorded_failure_exactly(self):
        path = self.status({k: list(v) for k, v in self.lock['finalPackages']['amd64'].items()})
        previous = copy.deepcopy(self.lock)
        for name in support.AMD64_ONLY:
            del previous['finalPackages']['amd64'][name]
        cli = support.run_helper('check_packages.py', '--lock', support.write_lock(previous, self.dir / 'previous.json'),
                                 '--arch', 'amd64', '--status', str(path))
        self.assertEqual(cli.returncode, 1)
        self.assertEqual(cli.stderr, "check_packages: installed packages differ from the amd64 lock: {'unexpected': "
                                     "{'libdrm-intel1': ['2.4.131-1', 'amd64'], 'libpciaccess0': ['0.18.1-1ubuntu4.1', 'amd64']}}\n")

    def test_amd64_set_still_fails_closed(self):
        observed = {k: list(v) for k, v in self.lock['finalPackages']['amd64'].items()}
        without = dict(observed)
        without.pop('libpciaccess0')
        cases = [(without, 'missing'),
                 (dict(observed, **{'libdrm-intel1': ['2.4.131-2', 'amd64']}), 'different'),
                 (dict(observed, **{'libdrm-intel1': ['2.4.131-1', 'arm64']}), 'different'),
                 (dict(observed, **{'stray-package': ['1.0-1', 'amd64']}), 'unexpected')]
        for packages, kind in cases:
            with self.subTest(kind=kind, packages=len(packages)):
                cli = support.run_helper('check_packages.py', '--lock', str(support.LOCK), '--arch', 'amd64',
                                         '--status', str(self.status(packages)), '--os-packages', str(support.OS_PACKAGES))
                self.assertEqual(cli.returncode, 1)
                self.assertIn(f"installed packages differ from the amd64 lock: {{'{kind}'", cli.stderr)

    def test_arm64_database_fails_the_amd64_lock(self):
        result = check_packages.check(self.lock, 'amd64', self.status(self.expected))
        self.assertEqual(len(result['different']), 288)
        self.assertEqual(result['missing'], sorted(support.AMD64_ONLY))
        path = self.status(self.expected)
        cli = support.run_helper('check_packages.py', '--lock', str(support.LOCK), '--arch', 'amd64', '--status', str(path))
        self.assertEqual(cli.returncode, 1)
        self.assertIn('installed packages differ from the amd64 lock', cli.stderr)

    def test_altered_os_package_list_fails(self):
        altered = self.dir / 'os.txt'
        altered.write_text(support.OS_PACKAGES.read_text().replace('tzdata=2026c-0ubuntu0.26.04.1', 'tzdata=2026b-0ubuntu1'))
        with self.assertRaisesRegex(ohpkg.InputError, 'is not the locked OS list'):
            check_packages.check(self.lock, 'arm64', self.status(self.expected), altered)

    def test_dpkg_states(self):
        held = self.status(self.expected).read_text().replace('Package: curl\nStatus: install ok installed',
                                                              'Package: curl\nStatus: hold ok installed', 1)
        path = self.dir / 'held'
        path.write_text(held)
        self.assertEqual(check_packages.check(self.lock, 'arm64', path)['different'], {})
        removed = ('\nPackage: gone\nStatus: deinstall ok config-files\nVersion: 1\n'
                   '\nPackage: purged\nStatus: purge ok not-installed\nVersion: 1\n')
        self.assertEqual(check_packages.check(self.lock, 'arm64', self.status(self.expected, removed))['unexpected'], {})
        for state in ('install ok unpacked', 'install ok half-configured', 'install reinstreq half-installed',
                      'install ok triggers-pending', 'hold reinstreq installed'):
            with self.subTest(state=state):
                extra = f'\nPackage: stray\nStatus: {state}\nArchitecture: arm64\nVersion: 1\n'
                with self.assertRaisesRegex(ohpkg.InputError, 'not fully installed'):
                    check_packages.check(self.lock, 'arm64', self.status(self.expected, extra))

    def test_duplicate_installed_package_fails(self):
        path = self.status(self.expected, '\nPackage: curl\nStatus: install ok installed\nArchitecture: arm64\nVersion: 1\n')
        with self.assertRaisesRegex(ohpkg.InputError, 'installed twice'):
            check_packages.check(self.lock, 'arm64', path)


if __name__ == '__main__':
    unittest.main()
