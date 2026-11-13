"""Shared offline test support: paths, evidence discovery and a pure-Python .deb writer.

Nothing here uses Docker, the network or a package manager. Tests that need root's evidence or the production
checkout skip themselves (with the reason) when those files are absent.

Environment overrides: OH_EVIDENCE_BASE (the runtime-recovery-20260928 folder) and OH_REPO_ROOT (the checkout).
"""
import copy
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKAGE = HERE
REPO = Path(os.environ.get('OH_REPO_ROOT', HERE.parent.parent))
PROPOSAL = REPO / 'runtime' / 'ubuntu'
HELPERS = PROPOSAL / 'helpers'
LOCK = PROPOSAL / 'lock' / 'runtime-inputs.lock.json'
OS_PACKAGES = PROPOSAL / 'lock' / 'ubuntu-os-packages.txt'
DOCKERFILE = REPO / 'runtime' / 'hermes' / 'Dockerfile'
EVIDENCE = Path(os.environ.get('OH_EVIDENCE_BASE', REPO / 'Claude outputs/runtime-recovery-20260928'))
PRODUCTION_DOCKERFILE = EVIDENCE / 'ubuntu-runtime-packaging-v1/proposal/runtime/ubuntu/Dockerfile'
PACKET = EVIDENCE / 'ubuntu-runtime-packaging-inputs-v1'
FULL = EVIDENCE / 'ubuntu26-full-hermes-evidence-v1'
BROWSER = EVIDENCE / 'ubuntu26-browser-evidence-v1'
CURL = EVIDENCE / 'ubuntu26-curl-http3-evidence-v1'
PYTHON = EVIDENCE / 'ubuntu26-python312-evidence-v1'
AMD64_BUILD = EVIDENCE / 'hermes-amd64-verification-failure-v1'
LIVE_ARCHIVE_BUILD = EVIDENCE / 'hermes-amd64-snapshot-failure-v2'
SNAPSHOT_PROBES = {'amd64': EVIDENCE / 'ubuntu-snapshot-probe-v1', 'arm64': EVIDENCE / 'ubuntu-snapshot-probe-arm64-v1'}
TESTED_IMAGE = 'sha256:19767a183a718f2758b43bf510d1dafcbf34a92837a4f35e912c68b0e70673a5'
TESTED_PATCH_SHA256 = '1af999f04215ba940ad66ed22f9fdc0a9fe3e7e1b2c5932931a0d9c8d348621e'
OLDER_CHROMIUM = '150.0.7871.181-1~deb13u1'
# The lock root's emulated AMD64 build used, and the only packages that build installed beyond its AMD64 set.
AMD64_BUILT_LOCK = '78cacbeffe12a2c57018fee4fb805c1c4bdb9873736181a29a0652d0829e000b'
AMD64_ONLY = {'libdrm-intel1': ['2.4.131-1', 'amd64'], 'libpciaccess0': ['0.18.1-1ubuntu4.1', 'amd64']}
# The corrected lock that root's live-archive build used, and the signed Ubuntu snapshot that serves its exact pins.
LIVE_ARCHIVE_LOCK = '50424767a819602aeda1c6676db89ee5f1811dc6ca87d7f3716ffb396a4269f0'
UBUNTU_SNAPSHOT = '20260929T180000Z'

sys.path.insert(0, str(HELPERS))
import ohpkg  # noqa: E402


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def load_lock():
    return ohpkg.load_lock(LOCK)


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def needs(*paths):
    missing = [str(p) for p in paths if not Path(p).exists()]
    return unittest.skipIf(missing, f'evidence not present: {missing}')


def run_helper(name, *args, env=None, cwd=None):
    """Run a helper exactly as a Dockerfile step would, returning the CompletedProcess."""
    command = [sys.executable, '-B', str(HELPERS / name), *args] if name.endswith('.py') else ['sh', str(HELPERS / name), *args]
    return subprocess.run(command, capture_output=True, text=True, env=env, cwd=cwd)


def curl_evidence_member(name):
    """One member of root's receipt-verified curl evidence archive."""
    archive = CURL / 'evidence.tar.gz'
    digest = read_json(CURL / 'receipt.json')['sha256']
    data = archive.read_bytes()
    assert sha256(data) == digest, 'curl evidence archive does not match its receipt'
    with tarfile.open(fileobj=io.BytesIO(data)) as tar:
        return tar.extractfile(name).read()


# ---- synthetic .deb archives -------------------------------------------------------------------------------

def _tar_xz(entries):
    """entries: list of (path, kind, payload, mode); kind is 'dir', 'file' or 'link' (payload = target)."""
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode='w', format=tarfile.GNU_FORMAT) as tar:
        for path, kind, payload, mode in entries:
            info = tarfile.TarInfo(path)
            info.mtime = 0
            if kind == 'dir':
                info.type, info.mode = tarfile.DIRTYPE, mode or 0o755
                tar.addfile(info)
            elif kind == 'link':
                info.type, info.linkname, info.mode = tarfile.SYMTYPE, payload, 0o777
                tar.addfile(info)
            else:
                info.size, info.mode = len(payload), mode or 0o644
                tar.addfile(info, io.BytesIO(payload))
    import lzma
    return lzma.compress(raw.getvalue())


def _ar(members):
    out = io.BytesIO()
    out.write(b'!<arch>\n')
    for name, data in members:
        header = f'{name:<16}{0:<12}{0:<6}{0:<6}{"100644":<8}{len(data):<10}`\n'.encode('ascii')
        out.write(header + data + (b'\n' if len(data) % 2 else b''))
    return out.getvalue()


def control_text(package, version, arch, source=None, extra=None):
    lines = [f'Package: {package}']
    if source:
        lines.append(f'Source: {source}')
    lines += [f'Version: {version}', f'Architecture: {arch}', 'Maintainer: Test <test@example.invalid>',
              'Description: synthetic test package']
    lines += extra or []
    return '\n'.join(lines) + '\n'


def make_deb(path, package, version, arch, source=None, files=None, links=None, control=None):
    """Write a real-format .deb (ar + control.tar.xz + data.tar.xz) and return its bytes."""
    files = files or {f'/usr/share/doc/{package}/copyright': f'{package} copyright\n'.encode()}
    links = links or {}
    dirs = set()
    for name in list(files) + list(links):
        parent = Path(name).parent
        while str(parent) != '/':
            dirs.add(str(parent))
            parent = parent.parent
    entries = [('./', 'dir', None, 0o755)] + [('.' + d + '/', 'dir', None, 0o755) for d in sorted(dirs)]
    entries += [('.' + name, 'file', data if isinstance(data, bytes) else data.encode(), 0o644)
                for name, data in sorted(files.items())]
    entries += [('.' + name, 'link', target, None) for name, target in sorted(links.items())]
    control_bytes = (control or control_text(package, version, arch, source)).encode()
    blob = _ar([('debian-binary', b'2.0\n'),
                ('control.tar.xz', _tar_xz([('./', 'dir', None, 0o755), ('./control', 'file', control_bytes, 0o644)])),
                ('data.tar.xz', _tar_xz(entries))])
    Path(path).write_bytes(blob)
    return blob


def debian_record(name, version, arch, blob, source=None):
    record = {'Package': name, 'Version': version, 'Architecture': arch, 'SHA256': sha256(blob), 'Size': len(blob),
              'Filename': f'pool/main/{name[0]}/{source or name}/{name}_{version.split(":")[-1]}_{arch}.deb'}
    if source:
        record['Source'] = source
    return record


def synthetic_debian(directory, arch='arm64', lock=None, libdir=None):
    """Three synthetic packages shaped like the Debian inputs (names, versions, sources, a link, docs, a man page).

    Returns (lock copy whose Debian records describe them, {name: {'files': ..., 'links': ...}}).
    """
    lock = copy.deepcopy(lock or load_lock())
    libdir = libdir or {'arm64': 'aarch64-linux-gnu', 'amd64': 'x86_64-linux-gnu'}[arch]
    version, jpeg = '154.0.8037.57-1~deb13u1', '1:2.1.5-4'
    spec = {
        'chromium': (version, None, {
            '/usr/lib/chromium/chromium': b'\x7fELF synthetic chromium\n',
            '/usr/bin/chromium': b'#!/bin/sh\nexec /usr/lib/chromium/chromium "$@"\n',
            '/usr/share/icons/hicolor/48x48/apps/chromium.png': b'png',
            '/usr/share/doc/chromium/copyright': b'chromium copyright\n',
            '/usr/share/doc/chromium/changelog.Debian.gz': b'changelog',
            '/usr/share/doc/chromium/README.Debian': b'readme',
            '/usr/share/man/man1/chromium.1.gz': b'man'},
            {'/usr/share/pixmaps/chromium.png': '../icons/hicolor/48x48/apps/chromium.png'}),
        'chromium-common': (version, 'chromium', {
            '/usr/lib/chromium/resources.pak': b'resources',
            '/usr/share/doc/chromium-common/copyright': b'common copyright\n'}, {}),
        'libjpeg62-turbo': (jpeg, 'libjpeg-turbo', {
            f'/usr/lib/{libdir}/libjpeg.so.62.3.0': b'\x7fELF synthetic jpeg\n',
            '/usr/share/doc/libjpeg62-turbo/copyright': b'jpeg copyright\n'},
            {f'/usr/lib/{libdir}/libjpeg.so.62': 'libjpeg.so.62.3.0'}),
    }
    records, contents = {}, {}
    Path(directory).mkdir(parents=True, exist_ok=True)
    for name, (ver, source, files, links) in spec.items():
        path = Path(directory) / f'{name}_{ver.replace(":", "%3a")}_{arch}.deb'
        blob = make_deb(path, name, ver, arch, source, files, links)
        records[name] = debian_record(name, ver, arch, blob, source)
        contents[name] = {'files': files, 'links': links, 'path': path}
    lock['debian']['packages'][arch] = records
    return lock, contents


def write_lock(lock, path):
    ohpkg.write_json(path, lock)
    return str(path)


def apt_show(record):
    """`apt-cache show`-shaped metadata for a lock record."""
    fields = ['Package', 'Source', 'Version', 'Architecture', 'Filename', 'Size', 'SHA256']
    return '\n'.join(f'{f}: {record[f]}' for f in fields if f in record) + '\n'
