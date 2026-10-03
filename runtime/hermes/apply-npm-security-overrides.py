"""Integrity-checked patch releases plus a hash-bound cache security backport for npm 11.20.0."""
import base64
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
import urllib.request

ORIGINAL_CACHE_SHA256 = '01b7d66c854b2fe53ac05c98feb6e0d64722ab8898a778e2d2426a8b468d178f'


def verified_archive(blob, integrity):
    actual = 'sha512-' + base64.b64encode(hashlib.sha512(blob).digest()).decode()
    if actual != integrity:
        raise SystemExit('npm dependency archive differs from the reviewed integrity; refusing to install.')
    return tarfile.open(fileobj=io.BytesIO(blob), mode='r:gz')


def apply(root):
    here = Path(__file__).resolve().parent
    records = json.loads((here / 'npm-security-overrides.json').read_text())
    if json.loads((root / 'package.json').read_text())['version'] != '11.20.0':
        raise SystemExit('npm version differs from reviewed 11.20.0; refusing overrides.')
    modules = root / 'node_modules'
    cache = modules / 'http-cache-semantics'
    if json.loads((cache / 'package.json').read_text())['version'] != '4.2.0' or hashlib.sha256((cache / 'index.js').read_bytes()).hexdigest() != ORIGINAL_CACHE_SHA256:
        raise SystemExit('npm cache source differs from reviewed 4.2.0; refusing backport.')
    # The verified npm archive has balanced-match 4.0.4, satisfying brace-expansion's ^4.0.2.
    if json.loads((modules / 'balanced-match/package.json').read_text())['version'] != '4.0.4':
        raise SystemExit('npm balanced-match dependency differs from reviewed compatible 4.0.4.')
    with tempfile.TemporaryDirectory() as temporary:
        staged = Path(temporary)
        for name, record in records.items():
            if json.loads((modules / name / 'package.json').read_text())['version'] != record['originalVersion']:
                raise SystemExit(f'npm dependency {name} differs from reviewed original version.')
            with urllib.request.urlopen(record['tarball'], timeout=120) as response:
                blob = response.read(20 * 1024 * 1024 + 1)
            if len(blob) > 20 * 1024 * 1024:
                raise SystemExit('npm dependency archive exceeds size bound.')
            destination = staged / name
            destination.mkdir()
            with verified_archive(blob, record['integrity']) as archive:
                archive.extractall(destination, filter='data')
            package = json.loads((destination / 'package/package.json').read_text())
            if (package['name'], package['version']) != (name, record['version']):
                raise SystemExit(f'npm dependency {name} archive identity mismatch.')
        # Validate and stage all inputs before changing the npm installation.
        for name in records:
            shutil.rmtree(modules / name)
            shutil.copytree(staged / name / 'package', modules / name)
        shutil.copyfile(here / 'vendor/http-cache-semantics/index.js', cache / 'index.js')
    receipt = {'npmVersion': '11.20.0', 'dependencies': records, 'cacheBackport': {
        'version': '4.2.0', 'cve': 'CVE-2026-93748', 'originalSha256': ORIGINAL_CACHE_SHA256,
        'patchedSha256': hashlib.sha256((cache / 'index.js').read_bytes()).hexdigest()}}
    target = Path(sys.argv[2])
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(receipt, indent=2, sort_keys=True) + '\n')
    print(json.dumps(receipt, sort_keys=True))


if __name__ == '__main__':
    apply(Path(sys.argv[1]))
