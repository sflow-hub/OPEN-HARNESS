#!/usr/bin/env python3
"""Derive the proposed input lock from root's verified packet and evidence (offline, read-only).

Every input is checked against a hash root recorded before anything is read from it:
  packet   ../ubuntu-runtime-packaging-inputs-v1/        manifest.json SHA256 595a4add... (16 files; the Debian
                                                                release comes from its component SBOM's OS entry)
  scan     ../ubuntu26-full-hermes-evidence-v1/scan/scan.json   = scanSha256 in scan/review.json
  review   ../ubuntu26-full-hermes-evidence-v1/build/browser-file-review.json (added packages of the tested image)
  python   ../ubuntu26-python312-evidence-v1/evidence.tar.gz    = receipt.json sha256, member python-index.json
  node     ../ubuntu26-browser-evidence-v1/evidence.tar.gz      = receipt.json sha256, member node-image/node-index.json
  curl     ../ubuntu26-curl-http3-evidence-v1/                  candidate/review.json, candidate/curl.stdout,
                                                                evidence.tar.gz (= receipt.json sha256) for the tested patch
  amd64    ../hermes-amd64-verification-failure-v1/             intent.json, result.json and build.log SHA256s recorded
                                                                here (root's emulated AMD64 build of the selection)
  live     ../hermes-amd64-snapshot-failure-v2/                 the same three files of root's build of the corrected lock
  probes   ../ubuntu-snapshot-probe-v1/, ../ubuntu-snapshot-probe-arm64-v1/   SHA256SUMS recorded here (root's
                                                                signed-snapshot probes of the pinned Ubuntu base images)
Index documents must hash to the digests pinned by the packet; per-architecture manifests are read from them.
The selection derived from the first six must be the lock that AMD64 build used. Only the AMD64 packages its final
package check found installed and absent from that lock are then added, as the build log shows them. The corrected
lock must be the one the live-archive build used; the Ubuntu snapshot is then pinned only if each probe resolves the
unchanged OS list, including the pins that build could not find, to exactly that architecture's locked versions.

Usage: derive_lock.py [--base DIR] --out LOCK.json --os-packages OUT.txt
"""
import argparse
import ast
import copy
import hashlib
import io
import json
import re
import sys
import tarfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[2] / 'runtime/ubuntu/helpers'))
import ohpkg  # noqa: E402

PACKET_MANIFEST_SHA256 = '595a4addce271d217c7c625975d8295ee290ccf9bebe34aa643a6ba0a43db1a3'
UBUNTU = {'index': 'sha256:da6fc2be547864451aa253836dd926da33623312df4a9a243e35dc877c378a78',
          'arm64': 'sha256:e03767b4dc7cb87fc57b1f119d40d9a997ecc5570dc6e22d57d6b7e333bbe78c',
          'amd64': 'sha256:61ebaa5cc23ca45450db85eac015435199ec569e28ec222ea13f2aed2110b8a6'}
CURL_RUNTIME = ('curl', 'libcurl4t64', 'libcurl3t64-gnutls')
REBUILD_VERSION = '8.18.0-1ubuntu2.7+openharness.http3.1'
CHANGELOG = [
    'curl (8.18.0-1ubuntu2.7+openharness.http3.1) resolute; urgency=medium',
    '',
    '  * Local candidate: enable OpenSSL QUIC and nghttp3 for the OpenSSL',
    '    flavour. Preserve the distribution patches, protocols, GnuTLS flavour',
    '    and test-nonflaky targets. Add nghttp3 build and static-link dependencies.',
    '',
    ' -- Open Harness local build <build@localhost>  Tue, 29 Sep 2026 04:15:00 +0000',
    '',
]
# The AMD64 status recorded with the original selection.
SELECTED_AMD64_VALIDATION = ('Not built or executed. Base manifests and Debian package records are authenticated; Ubuntu '
                             'package versions and finalPackages are derived from ARM64 and must be confirmed by a native '
                             'AMD64 build, which fails closed on any difference.')
# Root's emulated (QEMU, ARM64 builder) linux/amd64 build of the default target with the selection's lock. Every
# stage before verify completed; check_packages then found installed AMD64 packages absent from the lock.
AMD64_BUILD = 'hermes-amd64-verification-failure-v1'
AMD64_BUILD_FILES = {'intent.json': '6824633f70ee66e69ae688936ce1d9d331a52615253083d1ed155e389d1a3592',
                     'result.json': 'ba1bb6e549cd9f1f1c02ac6c42a15828d363b8561842573580821abe163c62fc',
                     'build.log': '7e10d3796be0a6f0760770cbcfc685ab0bafecbc8ab039c4fec40a4f12317b8f'}
AMD64_BUILT_LOCK_SHA256 = '78cacbeffe12a2c57018fee4fb805c1c4bdb9873736181a29a0652d0829e000b'
# Root's emulated AMD64 build of the corrected lock stopped in the OS package step: the live archive no longer had
# three exact pins. Root's probes of each pinned Ubuntu base image then installed the locked ca-certificates from the
# live archive (the base image has no CA store for the snapshot's HTTPS), switched to one fixed, signed snapshot,
# reinstalled the OpenSSL packages that bootstrap changed at their locked versions and simulated the unchanged OS list.
LIVE_ARCHIVE_BUILD = 'hermes-amd64-snapshot-failure-v2'
LIVE_ARCHIVE_BUILD_FILES = {'intent.json': 'e5e747316e93f08b620afe10aaf9857c831aa7a9de4cfdb3fe20ec51a072b6d7',
                            'result.json': 'b20f547076291f91962606c23187b17dcdb62d9a7d8a11d239b0fce307f7edb5',
                            'build.log': '465ceb4d283e74732365abf7b616a2acdeb8010e5d87853b0155b85f0d2a0ecc'}
LIVE_ARCHIVE_LOCK_SHA256 = '50424767a819602aeda1c6676db89ee5f1811dc6ca87d7f3716ffb396a4269f0'
SNAPSHOT_PROBES = {'amd64': ('ubuntu-snapshot-probe-v1', 'build6.log',
                             '6c1b160d4ec11fd79707641a3a99b3c8c4df197710799d9d786930cec9f849e6'),
                   'arm64': ('ubuntu-snapshot-probe-arm64-v1', 'build.log',
                             'fc2e396151f232b5e1ba1ac861e2031fdd4c0bfdaf1af8a2bbcdb2f1db456e3a')}
BOOTSTRAP_CHANGED = ('libssl3t64', 'openssl', 'openssl-provider-legacy')
OS_LIST_STEP = '--arg-file=/opt/open-harness-build/lock/ubuntu-os-packages.txt'
CHECK_FAILURE = 'check_packages: installed packages differ from the amd64 lock: '


def sha(data):
    return hashlib.sha256(data).hexdigest()


def checked(path, digest):
    data = Path(path).read_bytes()
    ohpkg.require(sha(data) == digest, f'{path}: SHA256 {sha(data)} != recorded {digest}')
    return data


def member(archive_bytes, name):
    with tarfile.open(fileobj=io.BytesIO(archive_bytes)) as tar:
        return tar.extractfile(name).read()


def manifests(index_bytes, pinned, label):
    ohpkg.require('sha256:' + sha(index_bytes) == pinned, f'{label} index does not hash to {pinned}')
    found = {}
    for entry in json.loads(index_bytes)['manifests']:
        platform = entry.get('platform', {})
        if platform.get('os') == 'linux' and platform.get('architecture') in ohpkg.SUPPORTED_ARCHES:
            ohpkg.require(platform['architecture'] not in found, f'{label}: duplicate {platform["architecture"]} manifest')
            found[platform['architecture']] = entry['digest']
    ohpkg.require(set(found) == set(ohpkg.SUPPORTED_ARCHES), f'{label}: missing arm64/amd64 manifests')
    return found


def selection(base):
    """The original input selection: the lock root's AMD64 build used, before its AMD64 correction."""
    packet = base / 'ubuntu-runtime-packaging-inputs-v1'
    listing = json.loads(checked(packet / 'manifest.json', PACKET_MANIFEST_SHA256))
    files = {name: checked(packet / name, digest) for name, digest in listing.items()}
    readme = files['README.md'].decode()
    for digest in UBUNTU.values():
        ohpkg.require(digest.removeprefix('sha256:') in readme, f'Ubuntu digest {digest} not in the packet README')
    candidate = files['ubuntu-os-candidate.Dockerfile'].decode()
    ohpkg.require(candidate.startswith('FROM docker.io/library/ubuntu@' + UBUNTU['arm64'] + '\n'), 'unexpected OS candidate base')
    pins = re.search(r'--no-install-recommends (.*?) && apt-get check', candidate, re.S).group(1).split()
    ohpkg.require(all(re.fullmatch(r'[a-z0-9][a-z0-9.+-]*=[^=\s]+', p) for p in pins), 'unpinned OS package')
    runtime = files['runtime.Dockerfile'].decode()
    python_ref = re.search(r'^FROM (python:3\.12\.14-slim-trixie)@(sha256:[0-9a-f]{64})$', runtime, re.M)
    node_ref = re.search(r'^FROM (node:24\.21\.0-trixie-slim)@(sha256:[0-9a-f]{64}) AS node-runtime$', runtime, re.M)

    full = base / 'ubuntu26-full-hermes-evidence-v1'
    scan_digest = json.loads((full / 'scan/review.json').read_text())['scanSha256']
    scan = json.loads(checked(full / 'scan/scan.json', scan_digest))
    ohpkg.require(scan['ArtifactName'] == 'sha256:19767a183a718f2758b43bf510d1dafcbf34a92837a4f35e912c68b0e70673a5',
                  'scan is not of the tested candidate')
    ubuntu_results = [r for r in scan['Results'] if r.get('Type') == 'ubuntu']
    ohpkg.require(len(ubuntu_results) == 1, 'expected one ubuntu result')
    final_arm64 = {}
    for p in ubuntu_results[0]['Packages']:
        final_arm64[p['Name']] = [ohpkg.full_version(p.get('Epoch'), p['Version'], p.get('Release')), p['Arch']]
    review = json.loads((full / 'build/browser-file-review.json').read_text())
    ohpkg.require(review['image'] == scan['ArtifactName'], 'browser review is for another image')
    added = {name.split(':')[0]: version for name, version in review['addedPackages'].items()}

    debian = {'arm64': {}, 'amd64': {}}
    for name in ('debian-arm64-chromium.json', 'debian-arm64-jpeg.json'):
        debian['arm64'].update(json.loads(files[name])['packages'])
    debian['amd64'].update(json.loads(files['debian-amd64-browser.json'])['packages'])
    for arch, records in debian.items():
        ohpkg.require(set(records) == {'chromium', 'chromium-common', 'libjpeg62-turbo'}, f'{arch}: Debian package set')
        for record in records.values():
            ohpkg.require(record['Architecture'] == arch, f'{arch}: {record["Package"]} has another architecture')
            record['Size'] = int(record['Size'])
            record.pop('Depends', None)
    chromium_deps = sorted(f'{n}={v}' for n, v in added.items() if n not in debian['arm64'])
    systems = [c for c in json.loads(files['debian-component-sbom-arm64.json'])['components']
               if c.get('type') == 'operating-system']
    ohpkg.require(len(systems) == 1 and systems[0]['name'] == 'debian', 'packet SBOM has no single Debian OS component')
    debian_release = systems[0]['version'].split('.')[0]
    ohpkg.require(debian_release == '13', f'packet SBOM is Debian {systems[0]["version"]}, not Trixie (13)')
    for name, version in added.items():
        ohpkg.require(final_arm64.get(name, [None])[0] == version, f'{name} missing from the tested inventory')

    python_index = member(checked(base / 'ubuntu26-python312-evidence-v1/evidence.tar.gz',
                                  json.loads((base / 'ubuntu26-python312-evidence-v1/receipt.json').read_text())['sha256']),
                          'python-index.json')
    node_index = member(checked(base / 'ubuntu26-browser-evidence-v1/evidence.tar.gz',
                                json.loads((base / 'ubuntu26-browser-evidence-v1/receipt.json').read_text())['sha256']),
                        'node-image/node-index.json')

    curl = base / 'ubuntu26-curl-http3-evidence-v1'
    delta = json.loads((curl / 'candidate/review.json').read_text())['packageDelta']
    ohpkg.require(delta['added'] == {'libnghttp3-9:arm64': '1.12.0-1'} and not delta['removed'], 'unexpected curl delta')
    ohpkg.require({k.split(':')[0] for k in delta['changed']} == set(CURL_RUNTIME), 'unexpected rebuilt curl packages')
    version_text = (curl / 'candidate/curl.stdout').read_text()
    protocols = re.search(r'^Protocols: (.*)$', version_text, re.M).group(1).split()
    features = re.search(r'^Features: (.*)$', version_text, re.M).group(1).split()
    libraries = version_text.splitlines()[0].split(') ', 1)[1].split()
    evidence = checked(curl / 'evidence.tar.gz', json.loads((curl / 'receipt.json').read_text())['sha256'])
    with tarfile.open(fileobj=io.BytesIO(evidence)) as tar:
        patch = tar.extractfile('build-tests/work/evidence/http3-packaging.patch').read()
        modified = json.loads(tar.extractfile('build-tests/work/evidence/modified-source-files.json').read())
    curl_source = json.loads(files['curl-source-hashes.json'])
    for name, entry in curl_source['files'].items():
        ohpkg.require(len(entry['sha256']) == 64 and entry['bytes'] > 0, f'curl source {name}')

    final = {'arm64': dict(sorted(final_arm64.items()))}
    final['amd64'] = {name: [version, 'amd64' if arch == 'arm64' else arch] for name, [version, arch] in final['arm64'].items()}
    os_text = '\n'.join(pins) + '\n'
    lock = {
        'schema': ohpkg.LOCK_SCHEMA,
        'supportedArchitectures': list(ohpkg.SUPPORTED_ARCHES),
        'validation': {
            'arm64': 'Inputs of root native ARM64 candidate sha256:19767a18...; this proposal itself has not been built.',
            'amd64': SELECTED_AMD64_VALIDATION,
        },
        'derivedFrom': {'packetManifestSha256': PACKET_MANIFEST_SHA256, 'testedImageScanSha256': scan_digest,
                        'testedImage': scan['ArtifactName']},
        'images': {
            'ubuntu': {'reference': 'docker.io/library/ubuntu', 'index': UBUNTU['index'],
                       'manifests': {a: UBUNTU[a] for a in ohpkg.SUPPORTED_ARCHES}},
            'python': {'reference': 'docker.io/library/' + python_ref.group(1), 'index': python_ref.group(2),
                       'manifests': manifests(python_index, python_ref.group(2), 'python')},
            'node': {'reference': 'docker.io/library/' + node_ref.group(1), 'index': node_ref.group(2),
                     'manifests': manifests(node_index, node_ref.group(2), 'node')},
        },
        'ubuntu': {
            'osPackagesFile': 'ubuntu-os-packages.txt',
            'osPackagesSha256': sha(os_text.encode()),
            'osPackageCount': len(pins),
            'chromiumDependencies': {'arm64': chromium_deps, 'amd64': chromium_deps},
            'curlRuntimeDependencies': ['libnghttp3-9=1.12.0-1'],
        },
        'debian': {'suite': 'trixie', 'release': debian_release, 'packages': debian},
        'curl': {
            'source': {'package': 'curl', 'version': curl_source['version'], 'files': curl_source['files']},
            'buildDependencies': ['libnghttp3-dev=1.12.0-1', 'pkg-config'],
            'rebuild': {
                'version': REBUILD_VERSION,
                'changelogEntry': CHANGELOG,
                'rulesAnchor': '$(call configure-curl,openssl)',
                'rulesReplacement': '$(call configure-curl,openssl,--with-nghttp3 --with-openssl-quic)',
                'controlInsertions': [
                    ['               libnghttp2-dev,\n', '               libnghttp3-dev (>= 1.12.0),\n'],
                    ['         libnghttp2-dev,\n', '         libnghttp3-dev (>= 1.12.0),\n'],
                ],
                'expectedPatchSha256': sha(patch),
                'expectedFiles': {name: modified[name] for name in ('debian/changelog', 'debian/control', 'debian/rules')},
                'command': ['dpkg-buildpackage', '-us', '-uc', '-b', '-j4'],
                'builderUid': 10001,
                'minimumPidsLimit': 2048,
                'runtimePackages': list(CURL_RUNTIME),
            },
            'expectedRuntime': {'protocols': protocols, 'features': features, 'libraries': libraries},
        },
        'finalPackages': final,
    }
    return lock, os_text


def buildkit_steps(log):
    """{step: {(stage or None, instruction)}} and {step: [output line]} from a BuildKit plain-progress log."""
    heads, output = {}, {}
    for line in log.splitlines():
        header = re.fullmatch(r'#(\d+) \[(?:([\w-]+) +)?\d+/\d+\] (.*)', line)
        if header:
            heads.setdefault(header[1], set()).add((header[2], header[3]))
            continue
        text = re.fullmatch(r'#(\d+) \d+(?:\.\d+)? (.*)', line)
        if text:
            output.setdefault(text[1], []).append(text[2])
    return heads, output


def single_step(heads, needle, label):
    steps = [n for n, h in heads.items() if any(needle in instruction for _, instruction in h)]
    ohpkg.require(len(steps) == 1, f'no single {label} step')
    return steps[0]


def amd64_additions(log, lock):
    """{name: [version, 'amd64']} that the build log's final package check found installed and absent from the lock.

    The check must report nothing missing or different. Each package must be one of apt's additional packages in the
    OS package list step, fetched there from the Ubuntu archive, unpacked and set up with the same version and
    architecture; that step must newly install exactly the listed packages and those additional ones.
    """
    heads, output = buildkit_steps(log)
    os_steps = [n for n, h in heads.items() if any(OS_LIST_STEP in instruction for _, instruction in h)]
    verify = [n for n, h in heads.items() if {stage for stage, _ in h} == {'verify'}]
    ohpkg.require(len(os_steps) == 1 and {s for s, _ in heads[os_steps[0]]} == {'runtime'},
                  'no single runtime step installs the OS package list')
    ohpkg.require(len(verify) == 1, 'no single verify step')
    failures = [t[len(CHECK_FAILURE):] for t in output.get(verify[0], []) if t.startswith(CHECK_FAILURE)]
    ohpkg.require(len(failures) == 1, f'the verify step has {len(failures)} AMD64 package check failures, not one')
    try:
        problems = ast.literal_eval(failures[0])
    except (ValueError, TypeError, SyntaxError, MemoryError, RecursionError) as error:
        raise ohpkg.InputError(f'unreadable package check result: {error}') from None
    ohpkg.require(isinstance(problems, dict) and set(problems) == {'unexpected'} and problems['unexpected'],
                  f'the package check did not report only unexpected packages: {problems!r}')
    added, lines = problems['unexpected'], output[os_steps[0]]
    start = [i for i, t in enumerate(lines) if t == 'The following additional packages will be installed:']
    ohpkg.require(len(start) == 1, 'the OS package step has no single additional-packages list')
    additional = []
    for text in lines[start[0] + 1:]:
        if not text.startswith('  '):
            break
        additional += text.split()
    ohpkg.require(sorted(additional) == sorted(added),
                  f'apt added {sorted(additional)} to the OS package list; the package check found {sorted(added)}')
    count = lock['ubuntu']['osPackageCount']
    installed = f'0 upgraded, {count + len(added)} newly installed, 0 to remove and '
    ohpkg.require(sum(t.startswith(installed) for t in lines) == 1 and sum(' newly installed, ' in t for t in lines) == 1,
                  f'the OS package step did not newly install exactly the {count} listed and the additional packages')
    for name, entry in sorted(added.items()):
        ohpkg.require(isinstance(entry, list) and len(entry) == 2 and entry[1] == 'amd64' and isinstance(entry[0], str)
                      and re.fullmatch(r'[0-9][A-Za-z0-9.+~:-]*', entry[0]), f'{name}: {entry!r} is not an AMD64 package')
        ohpkg.require(name not in lock['finalPackages']['amd64'], f'{name} is already in the AMD64 lock')
        package, version = re.escape(name), re.escape(entry[0])
        for what, pattern in (
                ('fetched', rf'Get:\d+ http://(?:archive|security)\.ubuntu\.com/ubuntu resolute(?:-updates|-security)?/'
                            rf'[a-z]+ amd64 {package} amd64 {version} \[[^\]]+\]'),
                ('unpacked', rf'Unpacking {package}:amd64 \({version}\) \.\.\.'),
                ('set up', rf'Setting up {package}:amd64 \({version}\) \.\.\.')):
            ohpkg.require(sum(bool(re.fullmatch(pattern, t)) for t in lines) == 1,
                          f'{name} {entry[0]} was not {what} exactly once in the OS package step')
    return {name: [added[name][0], 'amd64'] for name in sorted(added)}


def correct_amd64(base, lock):
    """The selection plus the AMD64 packages that root's emulated AMD64 build of exactly this lock also installed."""
    built = sha(ohpkg.canonical_json(lock).encode())
    ohpkg.require(built == AMD64_BUILT_LOCK_SHA256, f'the selection is lock {built}, not the lock the AMD64 build used')
    files = {name: checked(base / AMD64_BUILD / name, digest) for name, digest in AMD64_BUILD_FILES.items()}
    intent, result = json.loads(files['intent.json']), json.loads(files['result.json'])
    ohpkg.require((intent['target'], intent['hostPlatform'], intent['executionMode'], intent['runtimeInputsLockSha256'])
                  == ('linux/amd64', 'linux/arm64', 'emulated', built), 'the AMD64 build is not an emulated build of this lock')
    ohpkg.require(result['buildExitCode'] == 1, 'the AMD64 build result is not the failed build')
    added = amd64_additions(files['build.log'].decode('utf-8'), lock)
    corrected = copy.deepcopy(lock)
    corrected['finalPackages']['amd64'] = dict(sorted({**lock['finalPackages']['amd64'], **added}.items()))
    listed = ' and '.join(f'{name} {version}' for name, (version, _) in added.items())
    corrected['validation']['amd64'] = (
        f'This lock has not been built for AMD64. Base manifests and Debian package records are authenticated. Ubuntu '
        f'package versions and finalPackages are derived from ARM64, plus {listed} (amd64), which an emulated AMD64 '
        f'build of the previous lock sha256:{built[:8]}... installed as unpinned dependencies of the OS package list. '
        'Its package check reported no other difference; the build stopped there, so later checks did not run. The '
        'additions rest on that build log, not on retained signed index records. An AMD64 build of this lock must '
        'confirm the set, and fails closed on any difference.')
    corrected['derivedFrom']['amd64Build'] = {
        'builtLockSha256': built, 'executionMode': intent['executionMode'], 'buildLogSha256': AMD64_BUILD_FILES['build.log'],
        'intentSha256': AMD64_BUILD_FILES['intent.json'], 'resultSha256': AMD64_BUILD_FILES['result.json']}
    return corrected


def unavailable_pins(log, pins):
    """[(name, version)] of the OS-list pins that the OS package step could not find in the live archive."""
    heads, output = buildkit_steps(log)
    found = [re.fullmatch(r"E: Version '([^']+)' for '([^']+)' was not found", text)
             for text in output.get(single_step(heads, OS_LIST_STEP, 'OS package list'), [])]
    missing = sorted((match[2], match[1]) for match in found if match)
    ohpkg.require(missing, 'the OS package step reports no missing pinned version')
    for name, version in missing:
        ohpkg.require(pins.get(name) == version, f'{name} {version} is not an OS-list pin')
    return missing


def snapshot_resolution(log, dockerfile, lock, pins, arch):
    """The snapshot of root's probe for arch, if the unchanged OS list resolves in it to exactly the locked set.

    The probe must start from the locked base image. After its CA bootstrap and the switch to the snapshot, the
    OpenSSL packages that bootstrap changed must be back at their locked versions. The simulated OS-list install must
    then only add packages: every pin simulated or already installed at its version, with its locked architecture,
    and no unpinned package other than this architecture's own locked ones, at their locked versions. (The rebuilt
    curl packages later replace their distribution pins, so pins are compared with the OS list, not the final set.)
    """
    ids = set(re.findall(r'APT::Snapshot "(\d{8}T\d{6}Z)"', dockerfile))
    ohpkg.require(len(ids) == 1, f'{arch} probe: not exactly one snapshot: {sorted(ids)}')
    snapshot = ids.pop()
    image = lock['images']['ubuntu']['manifests'][arch]
    ohpkg.require(dockerfile.startswith(f'FROM docker.io/library/ubuntu@{image}\n'), f'{arch} probe: not the locked base image')
    heads, output = buildkit_steps(log)
    setup = output.get(single_step(heads, f'APT::Snapshot "{snapshot}"', f'{arch} probe snapshot'), [])
    lines = output.get(single_step(heads, '--arg-file=/tmp/ubuntu-os-packages.txt apt-get -s install', f'{arch} probe OS-list'), [])
    final = lock['finalPackages'][arch]
    restored = {}
    for text in setup:
        match = re.fullmatch(rf'([a-z0-9][a-z0-9.+-]*)(?::{arch})? (\S+)', text)
        if match and match[1] in BOOTSTRAP_CHANGED:
            restored[match[1]] = match[2]
    ohpkg.require(restored == {name: final[name][0] for name in BOOTSTRAP_CHANGED},
                  f'{arch} probe: the bootstrap-changed OpenSSL packages are not at their locked versions: {restored}')
    inst, already = {}, {}
    for text in lines:
        match = re.fullmatch(r'Inst ([a-z0-9][a-z0-9.+-]*) \((\S+) [^\[]*\[([a-z0-9]+)\]\)(?: \[\])?', text)
        if match:
            ohpkg.require(match[1] not in inst, f'{arch} probe: {match[1]} is simulated twice')
            inst[match[1]] = [match[2], match[3]]
        match = re.fullmatch(r'([a-z0-9][a-z0-9.+-]*) is already the newest version \((\S+)\)\.', text)
        if match:
            already[match[1]] = match[2]
    ohpkg.require(sum(t.startswith(f'0 upgraded, {len(inst)} newly installed, 0 to remove and ') for t in lines) == 1,
                  f'{arch} probe: the simulation does more than newly install its {len(inst)} packages')
    for name, entry in inst.items():
        want = [pins[name], final.get(name, [None, None])[1]] if name in pins else final.get(name)
        ohpkg.require(entry == want, f'{arch} probe: the snapshot resolves {name} to {entry}, not {want}')
    for name, version in already.items():
        ohpkg.require(pins.get(name) == version, f'{arch} probe: {name} {version} was installed, but is not its pin')
    unresolved = set(pins) - set(inst) - set(already)
    ohpkg.require(not unresolved, f'{arch} probe: pins neither simulated nor installed: {sorted(unresolved)}')
    own = set(final) - set(lock['finalPackages']['arm64' if arch == 'amd64' else 'amd64'])
    ohpkg.require(set(inst) - set(pins) == own,
                  f'{arch} probe: unpinned simulated packages {sorted(set(inst) - set(pins))}, expected {sorted(own)}')
    return snapshot


def pin_ubuntu_snapshot(base, lock, os_text):
    """The corrected lock plus the one signed Ubuntu snapshot in which both probes resolve their locked sets."""
    built = sha(ohpkg.canonical_json(lock).encode())
    ohpkg.require(built == LIVE_ARCHIVE_LOCK_SHA256, f'the corrected lock is {built}, not the lock the live-archive build used')
    files = {name: checked(base / LIVE_ARCHIVE_BUILD / name, digest) for name, digest in LIVE_ARCHIVE_BUILD_FILES.items()}
    intent, result = json.loads(files['intent.json']), json.loads(files['result.json'])
    ohpkg.require((intent['target'], intent['runtimeInputsLockSha256'], result['buildExitCode']) == ('linux/amd64', built, 1),
                  'the live-archive build is not a failed AMD64 build of this lock')
    pins = dict(line.split('=', 1) for line in os_text.splitlines())
    missing = unavailable_pins(files['build.log'].decode('utf-8'), pins)
    snapshots, sums = set(), {}
    for arch, (directory, log_name, digest) in SNAPSHOT_PROBES.items():
        listing = checked(base / directory / 'SHA256SUMS', digest).decode('utf-8')
        digests = {name: value for value, name in (line.split('  ', 1) for line in listing.splitlines())}
        ohpkg.require({'Dockerfile', 'ubuntu-os-packages.txt', log_name} <= set(digests), f'{arch} probe: incomplete SHA256SUMS')
        probe = {name: checked(base / directory / name, digests[name]) for name in ('Dockerfile', 'ubuntu-os-packages.txt', log_name)}
        ohpkg.require(probe['ubuntu-os-packages.txt'].decode('utf-8') == os_text, f'{arch} probe: another OS package list')
        snapshots.add(snapshot_resolution(probe[log_name].decode('utf-8'), probe['Dockerfile'].decode('utf-8'), lock, pins, arch))
        sums[arch] = digest
    ohpkg.require(len(snapshots) == 1, f'the probes used different snapshots: {sorted(snapshots)}')
    pinned = copy.deepcopy(lock)
    pinned['ubuntu']['snapshot'] = snapshots.pop()
    pinned['derivedFrom']['liveArchiveBuild'] = {
        'buildLogSha256': LIVE_ARCHIVE_BUILD_FILES['build.log'], 'builtLockSha256': built,
        'intentSha256': LIVE_ARCHIVE_BUILD_FILES['intent.json'], 'resultSha256': LIVE_ARCHIVE_BUILD_FILES['result.json'],
        'unavailablePins': [f'{name}={version}' for name, version in missing]}
    pinned['derivedFrom']['snapshotProbeSha256Sums'] = sums
    return pinned


def derive(base):
    lock, os_text = selection(base)
    return pin_ubuntu_snapshot(base, correct_amd64(base, lock), os_text), os_text


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--base', default=str(HERE.parent.parent))
    parser.add_argument('--out', required=True)
    parser.add_argument('--os-packages', required=True)
    args = parser.parse_args(argv)
    lock, os_text = derive(Path(args.base))
    ohpkg.write_json(args.out, lock)
    Path(args.os_packages).write_text(os_text, encoding='utf-8')
    print(json.dumps({'lock': args.out, 'osPackages': lock['ubuntu']['osPackageCount'],
                      'finalPackages': {a: len(v) for a, v in lock['finalPackages'].items()}}))


if __name__ == '__main__':
    try:
        main()
    except ohpkg.InputError as error:
        print(f'derive_lock: {error}', file=sys.stderr)
        sys.exit(1)
