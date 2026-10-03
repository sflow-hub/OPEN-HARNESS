#!/usr/bin/env python3
"""Guarded curl HTTP/3 rebuild: verify the signed Ubuntu source, apply the three-file packaging change, build offline.

Subcommands (all fail closed, exit 1, on any mismatch):
  verify-source --lock L --dir D     D holds exactly the locked source files with the locked bytes and sizes
  build --lock L --work W --out O [--builder-provenance P]
        as the non-root builder, with no network: unpack, apply the change, require the patch and the three
        changed files to equal the tested ones, build with the distribution tests, then write
        O/debs (the three runtime packages only), O/other-packages (dev, doc, dbgsym) and O/provenance
  check-runtime --lock L --version-file F [--arch A]
        compare `curl --version` output with the tested libraries, protocols and features (and the target machine)
"""
import argparse
import difflib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ohpkg  # noqa: E402
from ohpkg import require  # noqa: E402

CHANGED = ('debian/rules', 'debian/control', 'debian/changelog')


def strip_signature(text):
    """The signed .dsc body between the PGP armor lines (trust comes from the locked bytes, not this parser)."""
    if not text.startswith('-----BEGIN PGP SIGNED MESSAGE-----'):
        return text
    body = text.split('\n\n', 1)[1]
    return body.split('\n-----BEGIN PGP SIGNATURE-----', 1)[0]


def verify_source(lock, directory):
    source = lock['curl']['source']
    directory = Path(directory)
    present = sorted(p.name for p in directory.iterdir() if p.is_file())
    require(present == sorted(source['files']), f'source files {present} != locked {sorted(source["files"])}')
    for name, entry in source['files'].items():
        path = directory / name
        require(path.stat().st_size == entry['bytes'], f'{name}: {path.stat().st_size} bytes, locked {entry["bytes"]}')
        require(ohpkg.sha256_file(path) == entry['sha256'], f'{name}: SHA256 differs from the signed index record')
    dsc_name = f'{source["package"]}_{source["version"].split(":")[-1]}.dsc'
    require(dsc_name in source['files'], f'{dsc_name} is not a locked source file')
    dsc = ohpkg.parse_deb822(strip_signature((directory / dsc_name).read_text(encoding='utf-8')))[0]
    require(dsc['Source'] == source['package'] and dsc['Version'] == source['version'], f'{dsc_name}: unexpected identity')
    listed = {}
    for line in dsc['Checksums-Sha256'].splitlines():
        if line.strip():
            digest, size, name = line.split()
            listed[name] = (digest, int(size))
    require(set(listed) == set(source['files']) - {dsc_name}, f'{dsc_name}: file list differs from the lock')
    for name, (digest, size) in listed.items():
        entry = source['files'][name]
        require(entry['sha256'] == digest and entry['bytes'] == size, f'{dsc_name}: {name} differs from the lock')
    return dsc_name


def apply_change(src, rebuild):
    """Apply the tested three-file packaging change; return (patch text, {name: sha256})."""
    src = Path(src)
    before = {name: (src / name).read_text(encoding='utf-8') for name in CHANGED}
    rules = before['debian/rules']
    require(rules.count(rebuild['rulesAnchor']) == 1, f'debian/rules: anchor {rebuild["rulesAnchor"]!r} is not unique')
    require(rebuild['rulesReplacement'] not in rules, 'debian/rules: already patched')
    control = before['debian/control']
    require('libnghttp3-dev' not in control, 'debian/control: already mentions libnghttp3-dev')
    for anchor, insertion in rebuild['controlInsertions']:
        require(anchor in control, f'debian/control: anchor {anchor!r} not found')
        control = control.replace(anchor, anchor + insertion, 1)  # the tested semantics: first occurrence only
    changelog = before['debian/changelog']
    require(not changelog.startswith(f'curl ({rebuild["version"]})'), 'debian/changelog: already has the rebuild entry')
    after = {'debian/rules': rules.replace(rebuild['rulesAnchor'], rebuild['rulesReplacement']),
             'debian/control': control,
             'debian/changelog': '\n'.join(rebuild['changelogEntry']) + '\n' + changelog}
    patch = ''.join(''.join(difflib.unified_diff(before[n].splitlines(True), after[n].splitlines(True),
                                                 fromfile='a/' + n, tofile='b/' + n)) for n in CHANGED)
    hashes = {name: ohpkg.sha256_bytes(after[name].encode()) for name in CHANGED}
    require(ohpkg.sha256_bytes(patch.encode()) == rebuild['expectedPatchSha256'], 'packaging patch differs from the tested patch')
    require(hashes == rebuild['expectedFiles'], f'changed files differ from the tested files: {hashes}')
    for name in CHANGED:
        (src / name).write_text(after[name], encoding='utf-8')
    return patch, hashes


def tree_hashes(root):
    root = Path(root)
    return {p.relative_to(root).as_posix(): ohpkg.sha256_file(p) for p in sorted(root.rglob('*'))
            if p.is_file() and not p.is_symlink()}


PIDS_MAX = ('/sys/fs/cgroup/pids.max', '/sys/fs/cgroup/pids/pids.max')  # cgroup v2, then v1
MEMORY_MAX = ('/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes')


def first_value(paths):
    for path in (paths,) if isinstance(paths, (str, Path)) else paths:
        if Path(path).is_file():
            return Path(path).read_text().strip()
    return 'unknown'


def check_builder(rebuild, uid=None, net_dir='/sys/class/net', pids_max=PIDS_MAX, env=None, memory_max=MEMORY_MAX):
    """Non-root, only the loopback up, enough processes for the distribution tests, and no DEB_* overrides.

    Down interfaces (for example per-namespace tunnel stubs such as tunl0 or sit0) are ignored. A pids limit that
    cannot be read is recorded as 'unknown' (the distribution tests then fail on their own if it is too low, as in
    root's 512-process attempt); memory is recorded, not enforced.
    """
    uid = os.getuid() if uid is None else uid
    require(uid == rebuild['builderUid'], f'build must run as uid {rebuild["builderUid"]}, not {uid}')
    net = Path(net_dir)
    up = sorted(p.name for p in net.iterdir() if int((p / 'flags').read_text().strip(), 16) & 1) if net.is_dir() else []
    require(up == ['lo'], f'interfaces up during the offline build: {up}; expected only the loopback the tests use')
    limit = first_value(pids_max)
    require(limit in ('max', 'unknown') or int(limit) >= rebuild['minimumPidsLimit'],
            f'pids limit {limit} < {rebuild["minimumPidsLimit"]}; the distribution tests need more processes')
    env = os.environ if env is None else env
    for name in sorted(env):
        require(not name.startswith('DEB_'), f'{name}={env[name]!r} would change the tested build or its tests')
    return {'uid': uid, 'interfacesUp': up, 'pidsMax': limit, 'memoryMax': first_value(memory_max)}


def expected_debs(lock, arch):
    version = lock['curl']['rebuild']['version']
    return {name: f'{name}_{version}_{arch}.deb' for name in lock['curl']['rebuild']['runtimePackages']}


def verify_runtime_debs(lock, arch, directory):
    version = lock['curl']['rebuild']['version']
    expected = expected_debs(lock, arch)
    present = sorted(p.name for p in Path(directory).iterdir())
    require(present == sorted(expected.values()), f'runtime packages {present} != {sorted(expected.values())}')
    for name, filename in expected.items():
        identity = ohpkg.deb_identity(ohpkg.Deb(Path(directory) / filename))
        wanted = {'Package': name, 'Version': version, 'Architecture': arch, 'SourceName': 'curl', 'SourceVersion': version}
        require(identity == wanted, f'{filename}: identity {identity} != {wanted}')
    return [str(Path(directory) / expected[name]) for name in expected]


def build(lock, work, out, builder_provenance=None, run=subprocess.run, builder=None):
    rebuild, source = lock['curl']['rebuild'], lock['curl']['source']
    environment = (builder or check_builder)(rebuild)
    work, out = Path(work), Path(out)
    require(not out.exists() or not any(out.iterdir()), f'{out}: must be empty')
    dsc_name = verify_source(lock, work)
    arch = run(['dpkg', '--print-architecture'], check=True, capture_output=True, text=True).stdout.strip()
    require(arch in ohpkg.SUPPORTED_ARCHES, f'unsupported build architecture {arch}')
    env = {k: v for k, v in os.environ.items() if not k.startswith('DEB_')}
    run(['dpkg-source', '-x', dsc_name], cwd=work, check=True, env=env)
    src = work / f'curl-{source["version"].split(":")[-1].rsplit("-", 1)[0]}'
    require(src.is_dir(), f'{src.name} was not unpacked')
    before = tree_hashes(src)
    patch, _ = apply_change(src, rebuild)
    after = tree_hashes(src)
    touched = sorted(k for k in set(before) | set(after) if before.get(k) != after.get(k))
    require(touched == sorted(CHANGED), f'the packaging change touched {touched}, not only {sorted(CHANGED)}')
    provenance = out / 'provenance'
    (provenance / 'original-source').mkdir(parents=True)
    for name in source['files']:
        shutil.copy2(work / name, provenance / 'original-source' / name)
    (provenance / 'http3-packaging.patch').write_text(patch, encoding='utf-8')
    ohpkg.write_json(provenance / 'modified-source-files.json', after)
    ohpkg.write_json(provenance / 'invocation.json', {**environment, 'command': rebuild['command'], 'architecture': arch,
                                                      'version': rebuild['version'], 'cpuCount': os.cpu_count()})
    if builder_provenance:
        shutil.copytree(builder_provenance, provenance / 'builder')
    run(['dpkg-checkbuilddeps'], cwd=src, check=True, env=env)
    run(['dpkg-source', '-b', src.name], cwd=work, check=True, env=env)
    # BuildKit caps console output; retain the complete distribution-test output.
    result = run(rebuild['command'], cwd=src, check=False, env=env, capture_output=True, text=True)
    (provenance / 'dpkg-buildpackage.stdout.log').write_text(result.stdout, encoding='utf-8')
    (provenance / 'dpkg-buildpackage.stderr.log').write_text(result.stderr, encoding='utf-8')
    if result.returncode:
        print(result.stdout[-16000:], file=sys.stderr)
        print(result.stderr[-16000:], file=sys.stderr)
    result.check_returncode()
    wanted = set(expected_debs(lock, arch).values())
    debs, other, results = out / 'debs', out / 'other-packages', provenance / 'build'
    for directory in (debs, other, results):
        directory.mkdir(parents=True)
    produced = {}
    for path in sorted(work.iterdir()):
        if not path.is_file() or path.name in source['files']:
            continue
        if path.suffix in ('.deb', '.ddeb', '.udeb'):
            produced[path.name] = ohpkg.sha256_file(path)
            path.replace((debs if path.name in wanted else other) / path.name)
        else:  # rebuilt .dsc/.debian.tar.xz, .buildinfo, .changes
            shutil.copy2(path, results / path.name)
    verify_runtime_debs(lock, arch, debs)
    ohpkg.write_json(provenance / 'built-packages.json', produced)
    return {'architecture': arch, 'runtimePackages': sorted(wanted), 'builtPackages': len(produced)}


TRIPLETS = {'arm64': 'aarch64-', 'amd64': 'x86_64-'}


def check_runtime(lock, text, arch=None):
    expected = lock['curl']['expectedRuntime']
    version = lock['curl']['rebuild']['version']
    lines = text.splitlines()
    require(lines and lines[0].startswith('curl 8.18.0 (') and ') ' in lines[0], 'unexpected curl --version first line')
    if arch is not None:
        triplet = lines[0].split('(', 1)[1].split(')', 1)[0]
        require(triplet.startswith(TRIPLETS[arch]), f'curl was built for {triplet}, not {arch}')
    fields = {line.split(':', 1)[0]: line.split(':', 1)[1].split() for line in lines[1:] if ':' in line}
    require(lines[0].split(') ', 1)[1].split() == expected['libraries'], 'curl library versions differ from the tested build')
    require(f'security patched: {version}' in text, f'curl does not report the rebuilt version {version}')
    require(fields.get('Protocols') == expected['protocols'], 'curl protocols differ from the tested build')
    require(fields.get('Features') == expected['features'], 'curl features differ from the tested build')
    require('HTTP3' in fields['Features'], 'curl lacks HTTP3')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('verify-source', 'build', 'check-runtime'):
        sub.add_parser(name).add_argument('--lock', required=True)
    sub.choices['verify-source'].add_argument('--dir', required=True)
    sub.choices['build'].add_argument('--work', required=True)
    sub.choices['build'].add_argument('--out', required=True)
    sub.choices['build'].add_argument('--builder-provenance')
    sub.choices['check-runtime'].add_argument('--version-file', required=True)
    sub.choices['check-runtime'].add_argument('--arch')
    args = parser.parse_args(argv)
    lock = ohpkg.load_lock(args.lock, getattr(args, 'arch', None))
    if args.command == 'verify-source':
        print(verify_source(lock, args.dir))
    elif args.command == 'build':
        print(json.dumps(build(lock, args.work, args.out, args.builder_provenance), sort_keys=True))
    else:
        check_runtime(lock, Path(args.version_file).read_text(encoding='utf-8'), args.arch)


if __name__ == '__main__':
    try:
        main()
    except (ohpkg.InputError, subprocess.CalledProcessError, OSError, KeyError, ValueError) as error:
        print(f'curl_http3: {error}', file=sys.stderr)
        sys.exit(1)
