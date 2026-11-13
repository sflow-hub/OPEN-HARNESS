"""Supplemental Debian-origin coverage: inventory bound to image files, identities and architecture; real scans."""
import copy
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

import support
from support import ohpkg

import debian_origin

UBUNTU_EXCLUDES = """# Drop all man pages
path-exclude=/usr/share/man/*

# Drop all translations
path-exclude=/usr/share/locale/*/LC_MESSAGES/*.mo

# Drop all documentation ...
path-exclude=/usr/share/doc/*

# ... except copyright files ...
path-include=/usr/share/doc/*/copyright

# ... and Debian changelogs for native & non-native packages
path-include=/usr/share/doc/*/changelog.*
"""
DEBIAN_OS_RELEASE = ('PRETTY_NAME="Debian GNU/Linux 13 (trixie)"\nNAME="Debian GNU/Linux"\nVERSION_ID="13"\n'
                     'VERSION="13 (trixie)"\nVERSION_CODENAME=trixie\nID=debian\n')
BOOKWORM_OS_RELEASE = DEBIAN_OS_RELEASE.replace('13', '12').replace('trixie', 'bookworm')
COMPONENT_SCAN = support.BROWSER / 'debian-scan' / 'scan.json'
PACKET_SBOM = support.PACKET / 'debian-component-sbom-arm64.json'
IMAGE_SCAN = support.FULL / 'scan' / 'scan.json'
NEGATIVE_V1 = support.FULL / 'sbom-experiment' / 'negative-control-scan.json'
NEGATIVE_V2 = support.FULL / 'sbom-experiment' / 'negative-control-v2-scan.json'
MIXED_ORIGIN = support.FULL / 'sbom-experiment' / 'scan.json'


def install_into(root, contents, lock):
    """Simulate dpkg installing the synthetic Debian packages into an Ubuntu root under its path policy."""
    rules = ohpkg.dpkg_path_rules(root / 'etc/dpkg/dpkg.cfg.d')
    for name, content in contents.items():
        for path, data in content['files'].items():
            if ohpkg.path_installed_by_policy(path, rules):
                target = root / path.lstrip('/')
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        for path, link in content['links'].items():
            target = root / path.lstrip('/')
            target.parent.mkdir(parents=True, exist_ok=True)
            target.symlink_to(link)
    paragraphs = ['Package: base-files\nStatus: install ok installed\nArchitecture: arm64\nVersion: 14ubuntu1\n']
    for name, record in lock['debian']['packages']['arm64'].items():
        source = f'Source: {record["Source"]}\n' if 'Source' in record else ''
        paragraphs.append(f'Package: {name}\nStatus: install ok installed\n{source}Architecture: arm64\n'
                          f'Version: {record["Version"]}\nDescription: synthetic\n')
    (root / 'var/lib/dpkg').mkdir(parents=True, exist_ok=True)
    (root / 'var/lib/dpkg/status').write_text('\n'.join(paragraphs))


class InventoryBinding(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.packages = self.dir / 'packages'
        self.lock, self.contents = support.synthetic_debian(self.packages)
        self.root = self.dir / 'image'
        (self.root / 'etc/dpkg/dpkg.cfg.d').mkdir(parents=True)
        (self.root / 'etc/dpkg/dpkg.cfg.d/excludes').write_text(UBUNTU_EXCLUDES)
        (self.root / 'usr/lib').mkdir(parents=True)
        (self.root / 'usr/lib/os-release').write_text('NAME="Ubuntu"\nVERSION_ID="26.04"\nID=ubuntu\n')
        (self.root / 'etc/os-release').symlink_to('../usr/lib/os-release')
        (self.root / 'lib').symlink_to('usr/lib')
        install_into(self.root, self.contents, self.lock)
        self.os_release = self.dir / 'debian-os-release'
        self.os_release.write_text(DEBIAN_OS_RELEASE)
        self.debian_version = self.dir / 'debian_version'
        self.debian_version.write_text('13.7\n')
        self.inventory_path = self.dir / 'inventory.json'

    def tearDown(self):
        shutil.rmtree(self.dir)

    def record(self):
        inventory = debian_origin.record(self.lock, 'arm64', self.root, self.packages, self.os_release, self.debian_version)
        ohpkg.write_json(self.inventory_path, inventory)
        return inventory

    def component(self, name='component'):
        out = self.dir / name
        debian_origin.component_root(self.lock, 'arm64', self.packages, self.inventory_path, out)
        return out

    def bind(self, component):
        return debian_origin.bind(self.lock, 'arm64', self.inventory_path, self.root, component)

    def test_record_component_and_bind(self):
        inventory = self.record()
        self.assertEqual(sorted(inventory['omittedByPolicy']),
                         ['/usr/share/doc/chromium/README.Debian', '/usr/share/man/man1/chromium.1.gz'])
        self.assertIn('/usr/share/doc/chromium/changelog.Debian.gz', inventory['files'])
        self.assertEqual(inventory['imageOs'], {'ID': 'ubuntu', 'VERSION_ID': '26.04'})
        self.assertEqual(len(inventory['links']), 2)
        component = self.component()
        self.assertEqual(debian_origin.os_release(component)['ID'], 'debian')
        self.assertEqual(debian_origin.os_release(self.root)['ID'], 'ubuntu')
        self.assertTrue((component / 'usr/share/man/man1/chromium.1.gz').is_file())
        status = ohpkg.dpkg_status(component / 'var/lib/dpkg/status')
        self.assertEqual(sorted(status), ['chromium', 'chromium-common', 'libjpeg62-turbo'])
        result = self.bind(component)
        self.assertEqual((result['files'], result['omittedByPolicy'], result['links']), (9, 2, 2))

    def test_altered_installed_file_fails(self):
        self.record()
        component = self.component()
        (self.root / 'usr/lib/chromium/chromium').write_bytes(b'\x7fELF patched')
        with self.assertRaisesRegex(ohpkg.InputError, 'image: /usr/lib/chromium/chromium differs from the inventory'):
            self.bind(component)
        with self.assertRaisesRegex(ohpkg.InputError, 'differs from the authenticated package'):
            self.record()

    def test_missing_installed_file_fails_unless_policy_excluded(self):
        (self.root / 'usr/lib/chromium/resources.pak').unlink()
        with self.assertRaisesRegex(ohpkg.InputError, 'resources.pak is missing from the image'):
            self.record()

    def test_policy_omitted_file_that_appears_later_fails(self):
        self.record()
        component = self.component()
        (self.root / 'usr/share/man/man1').mkdir(parents=True)
        (self.root / 'usr/share/man/man1/chromium.1.gz').write_bytes(b'man')
        with self.assertRaisesRegex(ohpkg.InputError, 'recorded as omitted but exists'):
            self.bind(component)

    def test_missing_copyright_notice_fails(self):
        (self.root / 'usr/share/doc/chromium-common/copyright').unlink()
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium-common: /usr/share/doc/chromium-common/copyright is missing'):
            self.record()

    def test_changed_installed_identity_fails(self):
        status = self.root / 'var/lib/dpkg/status'
        status.write_text(status.read_text().replace('Version: 154.0.8037.57-1~deb13u1', 'Version: 154.0.8037.57-1~deb13u2', 1))
        with self.assertRaisesRegex(ohpkg.InputError, 'image: installed chromium.* identity'):
            self.record()

    def test_rewritten_os_identity_fails(self):
        (self.root / 'usr/lib/os-release').write_text(DEBIAN_OS_RELEASE)
        with self.assertRaisesRegex(ohpkg.InputError, 'expected ubuntu'):
            self.record()

    def test_retargeted_link_fails(self):
        self.record()
        component = self.component()
        link = self.root / 'usr/lib/aarch64-linux-gnu/libjpeg.so.62'
        link.unlink()
        link.symlink_to('/usr/lib/aarch64-linux-gnu/libjpeg.so.62.3.0')
        with self.assertRaisesRegex(ohpkg.InputError, 'link /usr/lib/aarch64-linux-gnu/libjpeg.so.62 differs'):
            self.bind(component)

    def test_tampered_or_mismatched_inventory_fails(self):
        inventory = self.record()
        component = self.component()
        tampered = copy.deepcopy(inventory)
        tampered['files']['/usr/lib/chromium/chromium'] = '0' * 64
        ohpkg.write_json(self.inventory_path, tampered)
        with self.assertRaisesRegex(ohpkg.InputError, 'inventory digest mismatch'):
            self.bind(component)
        tampered['digest'] = debian_origin.digest_of(tampered)
        ohpkg.write_json(self.inventory_path, tampered)
        with self.assertRaisesRegex(ohpkg.InputError, 'differs from the inventory'):
            self.bind(component)
        ohpkg.write_json(self.inventory_path, inventory)
        with self.assertRaisesRegex(ohpkg.InputError, 'inventory is for arm64, not amd64'):
            debian_origin.bind(self.lock, 'amd64', self.inventory_path, self.root, component)
        other = copy.deepcopy(self.lock)
        other['debian']['packages']['arm64']['chromium']['Filename'] += '.other'
        with self.assertRaisesRegex(ohpkg.InputError, 'inventory was made from other inputs'):
            debian_origin.bind(other, 'arm64', self.inventory_path, self.root, component)
        self.inventory_path.write_text(json.dumps({'schema': 'something-else'}))
        with self.assertRaisesRegex(ohpkg.InputError, 'not a Debian-origin inventory'):
            self.bind(component)

    def test_other_debian_release_is_refused(self):
        self.os_release.write_text(BOOKWORM_OS_RELEASE)
        with self.assertRaisesRegex(ohpkg.InputError, "input stage: Debian os-release is 'bookworm' '12', not trixie 13"):
            self.record()
        self.os_release.write_text(DEBIAN_OS_RELEASE)
        self.debian_version.write_text('12.9\n')
        with self.assertRaisesRegex(ohpkg.InputError, 'debian_version .12.9. is not Debian 13'):
            self.record()
        self.debian_version.write_text('13.7\n')
        inventory = self.record()
        component = self.component()
        relabelled = dict(inventory, debianOsRelease=BOOKWORM_OS_RELEASE, debianVersion='12.9\n')
        relabelled['digest'] = debian_origin.digest_of(relabelled)
        ohpkg.write_json(self.inventory_path, relabelled)
        with self.assertRaisesRegex(ohpkg.InputError, 'not trixie 13'):
            self.bind(component)
        with self.assertRaisesRegex(ohpkg.InputError, 'not trixie 13'):
            self.component('component-2')

    def test_component_root_must_contain_only_the_inventory(self):
        self.record()
        component = self.component()
        extra = component / 'usr/lib/node_modules/x/package.json'
        extra.parent.mkdir(parents=True)
        extra.write_text('{}')
        with self.assertRaisesRegex(ohpkg.InputError, 'component root has unexpected entries'):
            self.bind(component)
        extra.unlink()
        status = component / 'var/lib/dpkg/status'
        original = status.read_text()
        status.write_text(original + '\nPackage: extra\nStatus: install ok installed\nArchitecture: arm64\nVersion: 1\n')
        with self.assertRaisesRegex(ohpkg.InputError, 'component root lists other packages'):
            self.bind(component)
        status.write_text(original)
        (component / 'etc/os-release').write_text('ID=ubuntu\n')
        with self.assertRaisesRegex(ohpkg.InputError, '/etc/os-release is not the recorded Debian one'):
            self.bind(component)
        (component / 'etc/os-release').write_text(DEBIAN_OS_RELEASE)
        (component / 'etc/debian_version').write_text('12.9\n')
        with self.assertRaisesRegex(ohpkg.InputError, '/etc/debian_version is not the recorded Debian one'):
            self.bind(component)

    def test_swapped_package_archive_fails(self):
        self.record()
        path = self.contents['chromium-common']['path']
        support.make_deb(path, 'chromium-common', '154.0.8037.57-1~deb13u1', 'arm64', 'chromium',
                         {'/usr/lib/chromium/resources.pak': b'other resources'})
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium-common: .*(bytes|SHA256)'):
            self.component()

    def test_cli_record_component_bind(self):
        lock_path = support.write_lock(self.lock, self.dir / 'lock.json')
        common = ['--lock', lock_path, '--arch', 'arm64']
        result = support.run_helper('debian_origin.py', 'record', *common, '--root', str(self.root), '--packages',
                                    str(self.packages), '--debian-os-release', str(self.os_release),
                                    '--debian-version', str(self.debian_version), '--out', str(self.inventory_path))
        self.assertEqual(result.returncode, 0, result.stderr)
        result = support.run_helper('debian_origin.py', 'component-root', *common, '--packages', str(self.packages),
                                    '--inventory', str(self.inventory_path), '--out', str(self.dir / 'cli-component'))
        self.assertEqual(result.returncode, 0, result.stderr)
        result = support.run_helper('debian_origin.py', 'bind', *common, '--inventory', str(self.inventory_path),
                                    '--image-root', str(self.root), '--component-root', str(self.dir / 'cli-component'))
        self.assertEqual(result.returncode, 0, result.stderr)
        (self.root / 'usr/lib/chromium/chromium').write_bytes(b'x')
        result = support.run_helper('debian_origin.py', 'bind', *common, '--inventory', str(self.inventory_path),
                                    '--image-root', str(self.root), '--component-root', str(self.dir / 'cli-component'))
        self.assertEqual(result.returncode, 1)
        self.assertIn('debian_origin: image: /usr/lib/chromium/chromium differs', result.stderr)


def mutate(report, function):
    report = copy.deepcopy(report)
    function(report)
    return report


def debian_result(report):
    return next(r for r in report['Results'] if r.get('Type') == 'debian')


@support.needs(COMPONENT_SCAN)
class ComponentScan(unittest.TestCase):
    def setUp(self):
        self.lock = support.load_lock()
        self.scan = support.read_json(COMPONENT_SCAN)

    def test_real_component_scan_passes_for_arm64_only(self):
        self.assertEqual(debian_origin.check_scan(self.lock, 'arm64', self.scan)['vulnerabilities'], 0)
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium is not amd64'):
            debian_origin.check_scan(self.lock, 'amd64', self.scan)

    def test_tampered_scans_fail(self):
        def package(name):
            return lambda r: next(p for p in debian_result(r)['Packages'] if p['Name'] == name)
        cases = [
            (lambda r: debian_result(r).setdefault('Vulnerabilities', []).append({'VulnerabilityID': 'CVE-1', 'Severity': 'HIGH'}),
             'vulnerabilities'),
            (lambda r: debian_result(r).setdefault('Secrets', []).append({'RuleID': 'x'}), 'secrets'),
            (lambda r: package('chromium')(r).update(Version='150.0.7871.181'), 'chromium version'),
            (lambda r: package('chromium-common')(r).update(SrcVersion='150.0.7871.181'), 'chromium-common source version'),
            (lambda r: package('libjpeg62-turbo')(r).update(SrcName='libjpeg9'), 'libjpeg62-turbo source'),
            (lambda r: package('chromium')(r)['Identifier'].update(PURL=package('chromium')(r)['Identifier']['PURL'].replace('/debian/', '/ubuntu/')),
             'not identified as a Debian package'),
            (lambda r: r['Metadata']['OS'].update(Family='ubuntu'), 'scanned OS is not Debian'),
            (lambda r: debian_result(r)['Packages'].pop(), 'scanned packages'),
            (lambda r: debian_result(r)['Packages'].append(dict(debian_result(r)['Packages'][0], Name='extra')), 'scanned packages'),
            (lambda r: r['Results'].append(copy.deepcopy(debian_result(r))), 'exactly one Debian package result'),
            (lambda r: r['Metadata']['OS'].update(Name='12.9'), "scanned Debian '12.9', not 13"),
            (lambda r: [p['Identifier'].update(PURL=p['Identifier']['PURL'].replace('distro=debian-13.7', 'distro=debian-12.9'))
                        for p in debian_result(r)['Packages']], 'is not identified as Debian 13'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ohpkg.InputError, message):
                    debian_origin.check_scan(self.lock, 'arm64', mutate(self.scan, change))

    @support.needs(MIXED_ORIGIN)
    def test_embedded_sbom_experiment_is_not_accepted_as_debian_coverage(self):
        report = support.read_json(MIXED_ORIGIN)
        with self.assertRaisesRegex(ohpkg.InputError, 'scanned OS is not Debian'):
            debian_origin.check_scan(self.lock, 'arm64', report)


@support.needs(PACKET_SBOM)
class ComponentSbom(unittest.TestCase):
    def setUp(self):
        self.lock = support.load_lock()
        self.sbom = support.read_json(PACKET_SBOM)

    def test_packet_sbom_is_arm64_only(self):
        debian_origin.check_sbom(self.lock, 'arm64', self.sbom)
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium is not amd64'):
            debian_origin.check_sbom(self.lock, 'amd64', self.sbom)

    def test_tampered_sboms_fail(self):
        def component(name):
            return lambda s: next(c for c in s['components'] if c['name'] == name)
        cases = [
            (lambda s: component('chromium')(s)['properties'].__setitem__(1, {'name': 'aquasecurity:trivy:PkgType', 'value': 'ubuntu'}),
             'is not a Debian package'),
            (lambda s: s['components'].remove(next(c for c in s['components'] if c['type'] == 'operating-system')),
             'one Debian operating-system component'),
            (lambda s: s['vulnerabilities'].append({'id': 'CVE-1'}), 'embedded vulnerability'),
            (lambda s: component('libjpeg62-turbo')(s).update(version='2.1.5-4'), 'libjpeg62-turbo version'),
            (lambda s: s.update(bomFormat='SPDX'), 'not a CycloneDX'),
            (lambda s: next(c for c in s['components'] if c['type'] == 'operating-system').update(version='12.9'),
             "SBOM is Debian '12.9', not 13"),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ohpkg.InputError, message):
                    debian_origin.check_sbom(self.lock, 'arm64', mutate(self.sbom, change))


@support.needs(IMAGE_SCAN)
class WholeImageScan(unittest.TestCase):
    def setUp(self):
        self.lock = support.load_lock()
        self.scan = support.read_json(IMAGE_SCAN)

    def test_tested_image_scan_passes_but_is_not_debian_coverage(self):
        result = debian_origin.check_image_scan(self.lock, 'arm64', self.scan, support.TESTED_IMAGE)
        self.assertEqual(result['packages'], 329)
        self.assertEqual(result['debianOriginSeenAsUbuntu'], ['chromium', 'chromium-common', 'libjpeg62-turbo'])
        self.assertIn('Not Debian-origin coverage', result['note'])
        with self.assertRaisesRegex(ohpkg.InputError, 'scanned OS is not Debian'):
            debian_origin.check_scan(self.lock, 'arm64', self.scan)

    def test_other_image_architecture_or_findings_fail(self):
        with self.assertRaisesRegex(ohpkg.InputError, 'not .sha256:0000'):
            debian_origin.check_image_scan(self.lock, 'arm64', self.scan, 'sha256:' + '0' * 64)
        with self.assertRaisesRegex(ohpkg.InputError, 'differ from the amd64 lock'):
            debian_origin.check_image_scan(self.lock, 'amd64', self.scan)
        ubuntu = lambda r: next(x for x in r['Results'] if x.get('Type') == 'ubuntu')  # noqa: E731
        node = lambda r: next(x for x in r['Results'] if x.get('Type') == 'node-pkg')  # noqa: E731
        cases = [
            (lambda r: node(r).setdefault('Vulnerabilities', []).append({'VulnerabilityID': 'CVE-1'}), 'vulnerabilities'),
            (lambda r: ubuntu(r).setdefault('Secrets', []).append({'RuleID': 'x'}), 'secrets'),
            (lambda r: next(p for p in ubuntu(r)['Packages'] if p['Name'] == 'curl').update(Release='1ubuntu2.7'),
             'differ from the arm64 lock'),
            (lambda r: r['Metadata']['OS'].update(Family='debian'), 'does not scan as Ubuntu'),
            (lambda r: ubuntu(r)['Packages'].insert(0, dict(ubuntu(r)['Packages'][0], Arch='armhf')), 'duplicate package rows'),
        ]
        for change, message in cases:
            with self.subTest(message=message):
                with self.assertRaisesRegex(ohpkg.InputError, message):
                    debian_origin.check_image_scan(self.lock, 'arm64', mutate(self.scan, change))


@support.needs(PACKET_SBOM, NEGATIVE_V1, NEGATIVE_V2)
class NegativeControl(unittest.TestCase):
    def setUp(self):
        self.lock = support.load_lock()
        self.sbom = support.read_json(PACKET_SBOM)
        self.v1, self.v2 = support.read_json(NEGATIVE_V1), support.read_json(NEGATIVE_V2)

    def test_generated_control_declares_the_identities_root_scanned_in_v2(self):
        document, changed = debian_origin.negative_control(self.sbom, 'chromium', support.OLDER_CHROMIUM)
        self.assertEqual(changed, ['chromium', 'chromium-common'])
        generated = debian_origin.sbom_packages(document, 'control', '13')
        scanned = debian_origin.debian_packages(self.v2, 'v2', '13')
        for name, package in generated.items():
            self.assertEqual(debian_origin.scan_version(package), debian_origin.scan_version(scanned[name]))
            self.assertEqual(debian_origin.scan_version(package, 'Src'), debian_origin.scan_version(scanned[name], 'Src'))
            self.assertEqual(package['Identifier']['PURL'], scanned[name]['Identifier']['PURL'])
        refs = {c['bom-ref'] for c in document['components']} | {document['metadata']['component']['bom-ref']}
        for dependency in document['dependencies']:
            self.assertIn(dependency['ref'], refs)
            for ref in dependency['dependsOn']:
                self.assertIn(ref, refs)
        self.assertEqual(self.sbom, support.read_json(PACKET_SBOM), 'the input SBOM is not modified')

    def test_v2_control_proves_advisory_lookup_and_v1_is_rejected(self):
        result = debian_origin.check_negative_control(self.lock, 'arm64', self.v2, 'chromium', support.OLDER_CHROMIUM)
        self.assertEqual(result['severeFindings'], 468)
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium source version 154.0.8037.57-1~deb13u1'):
            debian_origin.check_negative_control(self.lock, 'arm64', self.v1, 'chromium', support.OLDER_CHROMIUM)

    def test_control_without_findings_or_with_the_locked_version_fails(self):
        empty = mutate(self.v2, lambda r: debian_result(r).__setitem__('Vulnerabilities', []))
        with self.assertRaisesRegex(ohpkg.InputError, 'Debian advisory lookup is not proven'):
            debian_origin.check_negative_control(self.lock, 'arm64', empty, 'chromium', support.OLDER_CHROMIUM)
        with self.assertRaisesRegex(ohpkg.InputError, 'must be an authenticated older version'):
            debian_origin.check_negative_control(self.lock, 'arm64', self.v2, 'chromium', '154.0.8037.57-1~deb13u1')
        with self.assertRaisesRegex(ohpkg.InputError, 'chromium is not amd64'):
            debian_origin.check_negative_control(self.lock, 'amd64', self.v2, 'chromium', support.OLDER_CHROMIUM)

    def test_cli_generates_the_control(self):
        with tempfile.TemporaryDirectory() as out:
            result = support.run_helper('debian_origin.py', 'negative-control', '--sbom', str(PACKET_SBOM), '--source', 'chromium',
                                        '--version', support.OLDER_CHROMIUM, '--out', f'{out}/control.json')
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout)['regressed'], ['chromium', 'chromium-common'])
            result = support.run_helper('debian_origin.py', 'check-negative-control', '--lock', str(support.LOCK), '--arch', 'arm64',
                                        '--scan', str(NEGATIVE_V1), '--source', 'chromium', '--version', support.OLDER_CHROMIUM)
            self.assertEqual(result.returncode, 1)


if __name__ == '__main__':
    unittest.main()
