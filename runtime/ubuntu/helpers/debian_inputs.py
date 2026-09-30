#!/usr/bin/env python3
"""Exact Debian-origin browser inputs: fetch them through signed APT, verify them, and plan the Ubuntu install.

Subcommands (all fail closed, exit 1, on any mismatch):
  plan --lock L --arch A           print `name:arch=version`, one per locked package
  fetch --lock L --arch A --out O  in the official pinned Debian stage, after a signed `apt-get update`:
        record `apt-cache show` for each locked version, `apt-get download` it, verify everything below, then
        keep the source metadata, InRelease files, APT sources and the Debian os-release as provenance.
        Writes O/packages (the three .debs), O/metadata and O/debian-os.
  verify --lock L --arch A --packages D --metadata M
        D holds exactly one .deb per locked package and nothing else; each has the locked size, SHA256 and
        control identity (package, version, architecture, source). M/<name>.metadata (signed-index `apt-cache
        show` output) must hold exactly one stanza for that version and architecture with the locked SHA256,
        Filename and Size. Writes M/package-review.json.
  install-args --lock L --arch A --packages D
        re-verify D, then print the three .deb paths followed by the pinned Ubuntu packages Chromium needs
"""
import argparse
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ohpkg  # noqa: E402
from ohpkg import require  # noqa: E402


def records(lock, arch):
    packages = lock['debian']['packages'].get(arch)
    require(packages, f'no Debian package records for {arch}')
    for name, record in packages.items():
        require(record['Package'] == name and record['Architecture'] == arch, f'lock record {name} is not {arch}')
    return packages


def expected_identity(name, record, arch):
    return {'Package': name, 'Version': record['Version'], 'Architecture': arch,
            'SourceName': record.get('Source', name).split(' ')[0], 'SourceVersion': record['Version']}


def plan(lock, arch):
    return [f'{name}:{arch}={record["Version"]}' for name, record in sorted(records(lock, arch).items())]


def verify_packages(lock, arch, directory):
    directory = Path(directory)
    expected = records(lock, arch)
    found = sorted(p.name for p in directory.iterdir())
    matched = {}
    for name in expected:
        candidates = [f for f in found if f.startswith(name + '_') and f.endswith(f'_{arch}.deb')]
        require(len(candidates) == 1, f'{name}: expected exactly one {arch} .deb, found {candidates}')
        matched[name] = candidates[0]
    extra = sorted(set(found) - set(matched.values()))
    require(not extra, f'unexpected files among the Debian packages: {extra}')
    review = {}
    for name, record in sorted(expected.items()):
        path = directory / matched[name]
        require(path.is_file() and not path.is_symlink(), f'{name}: {path.name} is not a regular file')
        size = path.stat().st_size
        require(size == record['Size'], f'{name}: {size} bytes, locked {record["Size"]}')
        digest = ohpkg.sha256_file(path)
        require(digest == record['SHA256'], f'{name}: SHA256 {digest} differs from the authenticated record')
        identity = ohpkg.deb_identity(ohpkg.Deb(path))
        wanted = expected_identity(name, record, arch)
        require(identity == wanted, f'{name}: control identity {identity} != {wanted}')
        review[name] = {'file': matched[name], 'sha256': digest, 'size': size, **identity}
    return review


def verify_metadata(lock, arch, metadata):
    for name, record in sorted(records(lock, arch).items()):
        path = Path(metadata) / f'{name}.metadata'
        require(path.is_file(), f'missing signed-index metadata {path.name}')
        stanzas = [s for s in ohpkg.parse_deb822(path.read_text(encoding='utf-8'))
                   if s.get('Package') == name and s.get('Version') == record['Version'] and s.get('Architecture') == arch]
        require(len(stanzas) == 1, f'{path.name}: expected one {name} {record["Version"]} {arch} stanza, found {len(stanzas)}')
        stanza = stanzas[0]
        for field in ('SHA256', 'Filename'):
            require(stanza.get(field) == record[field], f'{path.name}: {field} {stanza.get(field)!r} differs from the lock')
        require(int(stanza.get('Size', -1)) == record['Size'], f'{path.name}: Size differs from the lock')


def fetch(lock, arch, out, run=subprocess.run, apt_lists='/var/lib/apt/lists', apt_sources='/etc/apt/sources.list.d',
          os_release='/etc/os-release', debian_version='/etc/debian_version'):
    out = Path(out)
    require(not out.exists() or not any(out.iterdir()), f'{out}: must be empty')
    packages, metadata, debian_os = out / 'packages', out / 'metadata', out / 'debian-os'
    for directory in (packages, metadata / 'apt', debian_os):
        directory.mkdir(parents=True)
    specs = plan(lock, arch)
    for spec in specs:
        shown = run(['apt-cache', 'show', spec], check=True, capture_output=True, text=True).stdout
        (metadata / f'{spec.split(":", 1)[0]}.metadata').write_text(shown, encoding='utf-8')
    verify_metadata(lock, arch, metadata)
    run(['apt-get', 'download', *specs], cwd=packages, check=True)
    review = verify_packages(lock, arch, packages)
    for source in sorted({entry['SourceName'] for entry in review.values()}):
        shown = run(['apt-cache', 'showsrc', source], check=True, capture_output=True, text=True).stdout
        (metadata / f'{source}.source-metadata').write_text(shown, encoding='utf-8')
    signed = sorted(Path(apt_lists).glob('*InRelease'))
    require(signed, 'no signed InRelease files: run a signed `apt-get update` first')
    for path in signed + sorted(Path(apt_sources).glob('*.sources')) + sorted(Path(apt_sources).glob('*.list')):
        shutil.copyfile(path, metadata / 'apt' / path.name)
    release = Path(os_release).read_text(encoding='utf-8')
    require('ID=debian' in release.splitlines(), f'{os_release}: the input stage is not Debian')
    (debian_os / 'os-release').write_text(release, encoding='utf-8')
    (debian_os / 'debian_version').write_text(Path(debian_version).read_text(encoding='utf-8'), encoding='utf-8')
    ohpkg.write_json(metadata / 'package-review.json', {'architecture': arch, 'packages': review})
    return review


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    for name in ('plan', 'fetch', 'verify', 'install-args'):
        p = sub.add_parser(name)
        p.add_argument('--lock', required=True)
        p.add_argument('--arch', required=True)
        if name in ('verify', 'install-args'):
            p.add_argument('--packages', required=True)
    sub.choices['fetch'].add_argument('--out', required=True)
    sub.choices['verify'].add_argument('--metadata', required=True)
    args = parser.parse_args(argv)
    lock = ohpkg.load_lock(args.lock, args.arch)
    if args.command == 'plan':
        print('\n'.join(plan(lock, args.arch)))
    elif args.command == 'fetch':
        fetch(lock, args.arch, args.out)
    elif args.command == 'verify':
        review = verify_packages(lock, args.arch, args.packages)
        verify_metadata(lock, args.arch, args.metadata)
        ohpkg.write_json(Path(args.metadata) / 'package-review.json', {'architecture': args.arch, 'packages': review})
    else:
        review = verify_packages(lock, args.arch, args.packages)
        paths = [str(Path(args.packages).resolve() / entry['file']) for _, entry in sorted(review.items())]
        print('\n'.join(paths + lock['ubuntu']['chromiumDependencies'][args.arch]))


if __name__ == '__main__':
    try:
        main()
    except (ohpkg.InputError, subprocess.CalledProcessError, OSError, KeyError, ValueError) as error:
        print(f'debian_inputs: {error}', file=sys.stderr)
        sys.exit(1)
