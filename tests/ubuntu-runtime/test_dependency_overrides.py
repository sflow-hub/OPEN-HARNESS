"""Dependency packaging rejects tampered inputs and never half-patches upstream manifests."""
import base64
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

import support


def module(name):
    path = support.REPO / 'runtime/hermes' / name
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


class DependencyOverrides(unittest.TestCase):
    def test_all_files_are_authenticated_before_any_pin_is_written(self):
        patch = module('apply-security-overrides.py').patch_targets
        with tempfile.TemporaryDirectory() as directory:
            a, b = Path(directory) / 'manifest', Path(directory) / 'lazy'
            original = b'"httpx2==2.7.0" "PyJWT[crypto]==2.13.0"'
            a.write_bytes(original)
            b.write_bytes(b'changed upstream')
            targets = [(a, hashlib.sha256(original).hexdigest(), [(b'2.13.0', b'2.15.1', 1)]),
                       (b, '0' * 64, [(b'2.7.0', b'2.12.0', 1)])]
            with self.assertRaisesRegex(SystemExit, 'refusing to patch'):
                patch(targets)
            self.assertEqual(a.read_bytes(), original)
            targets[1] = (b, hashlib.sha256(b.read_bytes()).hexdigest(), [(b'changed upstream', b'reviewed upstream', 1)])
            patch(targets)
            self.assertIn(b'PyJWT[crypto]==2.15.1', a.read_bytes())
            self.assertIn(b'httpx2==2.7.0', a.read_bytes())
            self.assertEqual(b.read_bytes(), b'reviewed upstream')

    def test_pin_count_mismatch_refuses_authenticated_but_unexpected_manifest(self):
        patch = module('apply-security-overrides.py').patch_targets
        with tempfile.TemporaryDirectory() as directory:
            p = Path(directory) / 'manifest'
            p.write_bytes(b'"PyJWT[crypto]==2.13.0"')
            with self.assertRaisesRegex(SystemExit, 'pin count'):
                patch([(p, hashlib.sha256(p.read_bytes()).hexdigest(), [(b'2.13.0', b'2.15.1', 2)])])
            self.assertIn(b'2.13.0', p.read_bytes())

    def test_wrong_npm_archive_integrity_is_rejected_before_extraction(self):
        verify = module('apply-npm-security-overrides.py').verified_archive
        expected = 'sha512-' + base64.b64encode(hashlib.sha512(b'authenticated archive').digest()).decode()
        with self.assertRaisesRegex(SystemExit, 'integrity'):
            verify(b'altered archive', expected)

    def test_tampered_cache_backport_fails_before_modifying_npm(self):
        installer = module('apply-npm-security-overrides.py')
        with tempfile.TemporaryDirectory() as directory:
            here, root = Path(directory) / 'source', Path(directory) / 'npm'
            (here / 'vendor/http-cache-semantics').mkdir(parents=True)
            root.mkdir()
            original = b'{"version":"11.20.0"}'
            (root / 'package.json').write_bytes(original)
            (here / 'npm-security-overrides.json').write_text('{}')
            (here / 'vendor/http-cache-semantics/index.js').write_text('unpatched or changed source')
            with mock.patch.object(installer, '__file__', str(here / 'apply-npm-security-overrides.py')):
                with self.assertRaisesRegex(SystemExit, 'backport differs'):
                    installer.apply(root)
            self.assertEqual((root / 'package.json').read_bytes(), original)
            self.assertEqual(list(root.iterdir()), [root / 'package.json'])
