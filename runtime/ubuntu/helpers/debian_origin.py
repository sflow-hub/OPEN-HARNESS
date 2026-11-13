#!/usr/bin/env python3
"""Supplemental Debian-origin inventory and release checks for the three Debian packages in the Ubuntu runtime.

A whole-image scan classifies the image's dpkg database as Ubuntu, so it cannot establish Debian advisory coverage
for chromium, chromium-common and libjpeg62-turbo. These subcommands bind a separate Debian component inventory to
the actual image files, package versions, authenticated archives, Debian release and architecture, and fail closed
otherwise. The whole-image scan stays mandatory; nothing here rewrites the image's Ubuntu OS identity.

  record          (image build) verify installed files against the authenticated .debs; write the inventory
  component-root  (release) rebuild the Debian component root from the verified .debs and the recorded inventory
  bind            (release) prove the exported image and the component root both match the inventory
  check-scan      (release) accept a Trivy rootfs or SBOM scan of the component only with exact identities, 0 findings
  check-sbom      (release) accept a CycloneDX SBOM of the component only with exact identities for this architecture
  check-image-scan (release) the unchanged whole-image gate, bound to the image and the locked package set
  negative-control / check-negative-control
                  (release) regress binary AND source versions of one source package in a copy of the SBOM, and
                  require the scanner to report HIGH/CRITICAL findings for it (proves Debian advisory lookup works)

The inventory's `digest` only detects accidental change; it is not an authenticity seal. Its binding comes from
`bind`, which re-derives everything from the authenticated archives and the exported image.
"""
import argparse
import copy
import json
import re
import sys
from pathlib import Path, PurePosixPath

sys.path.insert(0, str(Path(__file__).resolve().parent))
import debian_inputs  # noqa: E402
import ohpkg  # noqa: E402
from ohpkg import require  # noqa: E402

INVENTORY_SCHEMA = 'open-harness-debian-origin-inventory/1'
SEVERE = {'HIGH', 'CRITICAL'}


def parse_os_release(text):
    fields = {}
    for line in text.splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, _, value = line.partition('=')
            fields[key.strip()] = value.strip().strip('"')
    return fields


def os_release(root):
    path = ohpkg.resolve_in_root(root, '/etc/os-release')
    require(path.is_file(), f'{root}: no /etc/os-release')
    return parse_os_release(path.read_text(encoding='utf-8'))


def check_debian_release(lock, os_release_text, debian_version_text, label):
    """The recorded Debian OS metadata must be the lock's suite and release (Trixie, 13), not another Debian."""
    suite, release = lock['debian']['suite'], lock['debian']['release']
    fields = parse_os_release(os_release_text)
    require(fields.get('ID') == 'debian', f'{label}: Debian os-release has ID {fields.get("ID")!r}')
    require(fields.get('VERSION_CODENAME') == suite and fields.get('VERSION_ID') == release,
            f'{label}: Debian os-release is {fields.get("VERSION_CODENAME")!r} {fields.get("VERSION_ID")!r}, '
            f'not {suite} {release}')
    require(debian_version_text.strip().split('.')[0] == release,
            f'{label}: debian_version {debian_version_text.strip()!r} is not Debian {release}')


def digest_of(inventory):
    return ohpkg.sha256_bytes(ohpkg.canonical_json({k: v for k, v in inventory.items() if k != 'digest'}).encode())


def expected_identity(record):
    return {'Package': record['Package'], 'Version': record['Version'], 'Architecture': record['Architecture'],
            'SourceName': record.get('Source', record['Package']).split(' ')[0], 'SourceVersion': record['Version']}


def status_identity(paragraph):
    name, version = ohpkg.source_identity(paragraph)
    return {'Package': paragraph['Package'], 'Version': paragraph['Version'], 'Architecture': paragraph['Architecture'],
            'SourceName': name, 'SourceVersion': version}


def check_installed_status(root, records, label):
    installed = ohpkg.dpkg_status(ohpkg.resolve_in_root(root, '/var/lib/dpkg/status'))
    for name, record in records.items():
        require(name in installed, f'{label}: {name} is not installed')
        require(status_identity(installed[name]) == expected_identity(record),
                f'{label}: installed {name} identity {status_identity(installed[name])} is not the authenticated one')
    return installed


def entry_at(root, path):
    """lstat-level view of an in-image path: ('file', sha256) / ('link', target) / ('other', None) / (None, None)."""
    parent = ohpkg.resolve_in_root(root, str(PurePosixPath(path).parent))
    host = parent / PurePosixPath(path).name
    if host.is_symlink():
        return 'link', host.readlink().as_posix()
    if host.is_file():
        return 'file', ohpkg.sha256_file(host)
    return ('other', None) if host.exists() else (None, None)


def lock_debian_digest(lock, arch):
    return ohpkg.sha256_bytes(ohpkg.canonical_json(lock['debian']['packages'][arch]).encode())


def record(lock, arch, root, packages, debian_os_release, debian_version):
    review = debian_inputs.verify_packages(lock, arch, packages)
    records = lock['debian']['packages'][arch]
    check_installed_status(root, records, 'image')
    ubuntu = os_release(root)
    require(ubuntu.get('ID') == 'ubuntu', f'image OS identity is {ubuntu.get("ID")!r}, expected ubuntu (never rewritten)')
    release_text = Path(debian_os_release).read_text(encoding='utf-8')
    version_text = Path(debian_version).read_text(encoding='utf-8')
    check_debian_release(lock, release_text, version_text, 'input stage')
    rules = ohpkg.dpkg_path_rules(ohpkg.resolve_in_root(root, '/etc/dpkg/dpkg.cfg.d'))
    files, links, omitted, packages_out = {}, {}, {}, {}
    for name in sorted(records):
        deb = ohpkg.Deb(Path(packages) / review[name]['file'])
        entries = deb.entries()
        for path, digest in entries['files'].items():
            kind, value = entry_at(root, path)
            if kind is None:
                require(not ohpkg.path_installed_by_policy(path, rules), f'{name}: {path} is missing from the image')
                omitted[path] = digest
                continue
            require(kind == 'file' and value == digest, f'{name}: {path} in the image differs from the authenticated package')
            files[path] = digest
        for path, target in entries['links'].items():
            require(entry_at(root, path) == ('link', target), f'{name}: link {path} differs from the authenticated package')
            links[path] = target
        require(entry_at(root, f'/usr/share/doc/{name}/copyright')[0] == 'file', f'{name}: /usr/share/doc/{name}/copyright is missing')
        packages_out[name] = {'deb': {k: review[name][k] for k in ('file', 'sha256', 'size')},
                              'identity': expected_identity(records[name]),
                              'controlSha256': ohpkg.sha256_bytes(deb.control_text.encode())}
    inventory = {
        'schema': INVENTORY_SCHEMA, 'architecture': arch, 'lockDebianSha256': lock_debian_digest(lock, arch),
        'imageOs': {'ID': ubuntu.get('ID'), 'VERSION_ID': ubuntu.get('VERSION_ID')},
        'debianOsRelease': release_text, 'debianVersion': version_text,
        'packages': packages_out, 'files': files, 'links': links, 'omittedByPolicy': omitted,
    }
    inventory['digest'] = digest_of(inventory)
    return inventory


def load_inventory(path, lock, arch):
    inventory = json.loads(Path(path).read_text(encoding='utf-8'))
    require(inventory.get('schema') == INVENTORY_SCHEMA, f'{path}: not a Debian-origin inventory')
    require(inventory.get('digest') == digest_of(inventory), f'{path}: inventory digest mismatch (altered or truncated)')
    require(inventory['architecture'] == arch, f'{path}: inventory is for {inventory["architecture"]}, not {arch}')
    require(inventory['lockDebianSha256'] == lock_debian_digest(lock, arch), f'{path}: inventory was made from other inputs')
    check_debian_release(lock, inventory['debianOsRelease'], inventory['debianVersion'], str(path))
    records = lock['debian']['packages'][arch]
    require(set(inventory['packages']) == set(records), f'{path}: inventory package set differs from the lock')
    for name, entry in inventory['packages'].items():
        require(entry['identity'] == expected_identity(records[name]), f'{path}: {name} identity differs from the lock')
        require(entry['deb']['sha256'] == records[name]['SHA256'], f'{path}: {name} archive differs from the lock')
    return inventory


def component_root(lock, arch, packages, inventory_path, out):
    inventory = load_inventory(inventory_path, lock, arch)
    review = debian_inputs.verify_packages(lock, arch, packages)
    out = Path(out)
    require(not out.exists() or not any(out.iterdir()), f'{out}: must be empty')
    out.mkdir(parents=True, exist_ok=True)
    controls = []
    for name in sorted(review):
        deb = ohpkg.Deb(Path(packages) / review[name]['file'])
        require(ohpkg.sha256_bytes(deb.control_text.encode()) == inventory['packages'][name]['controlSha256'],
                f'{name}: control record differs from the inventory')
        written = deb.extract_to(out)
        text = deb.control_text
        require(text.startswith(f'Package: {name}\n') and '\nStatus:' not in text, f'{name}: unexpected control layout')
        controls.append(text.replace(f'Package: {name}\n', f'Package: {name}\nStatus: install ok installed\n', 1).rstrip('\n'))
        info = out / 'var/lib/dpkg/info' / f'{name}.list'
        info.parent.mkdir(parents=True, exist_ok=True)
        info.write_text('\n'.join(written) + '\n', encoding='utf-8')
    (out / 'var/lib/dpkg/status').write_text('\n\n'.join(controls) + '\n', encoding='utf-8')
    for relative, text in (('etc/os-release', inventory['debianOsRelease']), ('etc/debian_version', inventory['debianVersion'])):
        require(not (out / relative).exists(), f'{relative} would be overwritten by a package file')
        (out / relative).parent.mkdir(parents=True, exist_ok=True)
        (out / relative).write_text(text, encoding='utf-8')
    return {'root': str(out), 'packages': sorted(review), 'files': len(inventory['files']) + len(inventory['omittedByPolicy'])}


def bind(lock, arch, inventory_path, image_root, component):
    inventory = load_inventory(inventory_path, lock, arch)
    records = lock['debian']['packages'][arch]
    check_installed_status(image_root, records, 'image')
    require(os_release(image_root).get('ID') == 'ubuntu', 'exported image no longer identifies as Ubuntu')
    for path, digest in inventory['files'].items():
        require(entry_at(image_root, path) == ('file', digest), f'image: {path} differs from the inventory')
        require(entry_at(component, path) == ('file', digest), f'component root: {path} differs from the inventory')
    for path, digest in inventory['omittedByPolicy'].items():
        require(entry_at(image_root, path) == (None, None), f'image: {path} was recorded as omitted but exists')
        require(entry_at(component, path) == ('file', digest), f'component root: {path} differs from the package')
    for path, target in inventory['links'].items():
        for label, root in (('image', image_root), ('component root', component)):
            require(entry_at(root, path) == ('link', target), f'{label}: link {path} differs from the inventory')
    component_status = check_installed_status(component, records, 'component root')
    require(set(component_status) == set(records), f'component root lists other packages: {sorted(component_status)}')
    for relative, key in (('/etc/os-release', 'debianOsRelease'), ('/etc/debian_version', 'debianVersion')):
        path = ohpkg.resolve_in_root(component, relative)
        require(path.is_file() and path.read_text(encoding='utf-8') == inventory[key],
                f'component root {relative} is not the recorded Debian one')
    allowed = (set(inventory['files']) | set(inventory['omittedByPolicy']) | set(inventory['links'])
               | {'/var/lib/dpkg/status', '/etc/os-release', '/etc/debian_version'}
               | {f'/var/lib/dpkg/info/{name}.list' for name in records})
    root = Path(component)
    present = {'/' + p.relative_to(root).as_posix() for p in root.rglob('*') if p.is_symlink() or not p.is_dir()}
    require(present <= allowed, f'component root has unexpected entries: {sorted(present - allowed)[:5]}')
    return {'architecture': arch, 'packages': sorted(records), 'inventoryDigest': inventory['digest'],
            'files': len(inventory['files']), 'omittedByPolicy': len(inventory['omittedByPolicy']), 'links': len(inventory['links'])}


def scan_version(package, prefix=''):
    version = package.get(prefix + 'Version') or ''
    release = package.get(prefix + 'Release')
    return ohpkg.full_version(package.get(prefix + 'Epoch'), version, release)


def purl_qualifier(purl, key):
    match = re.search(rf'[?&]{key}=([^&]+)', purl or '')
    return match.group(1) if match else None


def same_release(version, release):
    return re.fullmatch(rf'{re.escape(release)}(\.\d+)*', str(version or '')) is not None


def all_findings(report):
    vulnerabilities = [v for r in report.get('Results') or [] for v in (r.get('Vulnerabilities') or [])]
    secrets = [s for r in report.get('Results') or [] for s in (r.get('Secrets') or [])]
    return vulnerabilities, secrets


def debian_packages(report, label, release):
    system = (report.get('Metadata') or {}).get('OS') or {}
    require(system.get('Family') == 'debian', f'{label}: scanned OS is not Debian')
    require(same_release(system.get('Name'), release), f'{label}: scanned Debian {system.get("Name")!r}, not {release}')
    results = [r for r in report.get('Results') or [] if r.get('Type') == 'debian']
    require(len(results) == 1, f'{label}: expected exactly one Debian package result, found {len(results)}')
    packages = results[0].get('Packages') or []
    names = [p['Name'] for p in packages]
    require(len(names) == len(set(names)), f'{label}: duplicate package entries')
    return {p['Name']: p for p in packages}


def check_identities(packages, lock, arch, label, overrides=None):
    records, release = lock['debian']['packages'][arch], lock['debian']['release']
    require(set(packages) == set(records), f'{label}: scanned packages {sorted(packages)} != {sorted(records)}')
    for name, record in records.items():
        package = packages[name]
        wanted = expected_identity(record)
        version = (overrides or {}).get(wanted['SourceName'], record['Version'])
        require(scan_version(package) == version, f'{label}: {name} version {scan_version(package)} != {version}')
        require(package.get('SrcName') == wanted['SourceName'], f'{label}: {name} source {package.get("SrcName")}')
        require(scan_version(package, 'Src') == version, f'{label}: {name} source version {scan_version(package, "Src")} != {version}')
        purl = (package.get('Identifier') or {}).get('PURL', '')
        require(purl.startswith(f'pkg:deb/debian/{name}@'), f'{label}: {name} is not identified as a Debian package: {purl}')
        require(purl_qualifier(purl, 'arch') == arch and package.get('Arch') in (None, arch), f'{label}: {name} is not {arch}: {purl}')
        distro = purl_qualifier(purl, 'distro') or ''
        require(distro.startswith('debian-') and same_release(distro[len('debian-'):], release),
                f'{label}: {name} is not identified as Debian {release}: {purl}')


def check_scan(lock, arch, report, label='scan'):
    check_identities(debian_packages(report, label, lock['debian']['release']), lock, arch, label)
    vulnerabilities, secrets = all_findings(report)
    ids = sorted({v.get('VulnerabilityID') for v in vulnerabilities})
    require(not vulnerabilities, f'{label}: {len(vulnerabilities)} vulnerabilities, e.g. {ids[:3]}')
    require(not secrets, f'{label}: {len(secrets)} secrets')
    return {'architecture': arch, 'packages': sorted(lock['debian']['packages'][arch]), 'vulnerabilities': 0, 'secrets': 0}


def sbom_packages(sbom, label, release):
    require(sbom.get('bomFormat') == 'CycloneDX', f'{label}: not a CycloneDX document')
    components = sbom.get('components') or []
    systems = [c for c in components if c.get('type') == 'operating-system']
    require(len(systems) == 1 and systems[0].get('name') == 'debian', f'{label}: expected one Debian operating-system component')
    require(same_release(systems[0].get('version'), release), f'{label}: SBOM is Debian {systems[0].get("version")!r}, not {release}')
    packages = {}
    for component in components:
        if component.get('type') == 'operating-system':
            continue
        props = {p['name'].rsplit(':', 1)[-1]: p['value'] for p in component.get('properties') or []}
        require(component['name'] not in packages, f'{label}: duplicate component {component["name"]}')
        packages[component['name']] = {
            'Name': component['name'], 'Version': component.get('version'), 'Identifier': {'PURL': component.get('purl')},
            'SrcName': props.get('SrcName'), 'SrcEpoch': props.get('SrcEpoch'), 'SrcVersion': props.get('SrcVersion'),
            'SrcRelease': props.get('SrcRelease'), 'PkgType': props.get('PkgType')}
    for name, package in packages.items():
        require(package['PkgType'] == 'debian', f'{label}: {name} is not a Debian package')
    return packages


def check_sbom(lock, arch, sbom, label='sbom'):
    check_identities(sbom_packages(sbom, label, lock['debian']['release']), lock, arch, label)
    require(not sbom.get('vulnerabilities'), f'{label}: embedded vulnerability records are not expected')
    return {'architecture': arch, 'packages': sorted(lock['debian']['packages'][arch])}


def check_image_scan(lock, arch, report, image=None, label='image scan'):
    """The unchanged whole-image gate: Ubuntu OS, zero findings and secrets, and exactly the locked dpkg set."""
    require((report.get('Metadata') or {}).get('OS', {}).get('Family') == 'ubuntu', f'{label}: image does not scan as Ubuntu')
    if image is not None:
        require(report.get('ArtifactName') == image, f'{label}: scanned {report.get("ArtifactName")!r}, not {image!r}')
    vulnerabilities, secrets = all_findings(report)
    require(not vulnerabilities, f'{label}: {len(vulnerabilities)} vulnerabilities')
    require(not secrets, f'{label}: {len(secrets)} secrets')
    results = [r for r in report.get('Results') or [] if r.get('Type') == 'ubuntu']
    require(len(results) == 1, f'{label}: expected exactly one Ubuntu package result, found {len(results)}')
    rows = results[0].get('Packages') or []
    names = [p['Name'] for p in rows]
    require(len(names) == len(set(names)), f'{label}: duplicate package rows {sorted({n for n in names if names.count(n) > 1})}')
    scanned = {p['Name']: [scan_version(p), p.get('Arch')] for p in rows}
    expected = lock['finalPackages'][arch]
    require(scanned == expected, f'{label}: scanned packages differ from the {arch} lock: '
            f'{sorted(set(scanned) ^ set(expected)) or sorted(n for n in expected if scanned.get(n) != expected[n])[:5]}')
    seen = sorted(set(scanned) & set(lock['debian']['packages'][arch]))
    return {'os': 'ubuntu', 'packages': len(scanned), 'debianOriginSeenAsUbuntu': seen,
            'note': 'Not Debian-origin coverage: the separate Debian component scan must also pass check-scan.'}


def negative_control(sbom, source, version):
    """Copy of the SBOM with every binary of `source` regressed to `version` in BOTH binary and source fields."""
    require('-' in version and ':' not in version, 'use a full Debian version without epoch, e.g. 150.0.7871.181-1~deb13u1')
    upstream, release = version.rsplit('-', 1)
    result, renamed, changed = copy.deepcopy(sbom), {}, []
    for component in result.get('components') or []:
        props = {p['name'].rsplit(':', 1)[-1]: p for p in component.get('properties') or []}
        if props.get('SrcName', {}).get('value') != source:
            continue
        old_ref, name = component.get('bom-ref'), component['name']
        component['version'] = version
        component['purl'] = re.sub(r'@[^?]+', '@' + version, component['purl'], count=1)
        component['bom-ref'] = component['purl']
        props['PkgID']['value'] = f'{name}@{version}'
        props['SrcVersion']['value'], props['SrcRelease']['value'] = upstream, release
        renamed[old_ref] = component['bom-ref']
        changed.append(name)
    require(changed, f'no component has source {source}')
    for dependency in result.get('dependencies') or []:
        dependency['ref'] = renamed.get(dependency['ref'], dependency['ref'])
        dependency['dependsOn'] = [renamed.get(ref, ref) for ref in dependency.get('dependsOn') or []]
    return result, sorted(changed)


def check_negative_control(lock, arch, report, source, version, label='negative control'):
    records = lock['debian']['packages'][arch]
    locked = {expected_identity(r)['SourceVersion'] for r in records.values() if expected_identity(r)['SourceName'] == source}
    require(locked and version not in locked,
            f'{label}: {version} must be an authenticated older version, not the locked {source} {sorted(locked)}')
    packages = debian_packages(report, label, lock['debian']['release'])
    check_identities(packages, lock, arch, label, overrides={source: version})
    affected = {name for name, p in packages.items() if p.get('SrcName') == source}
    vulnerabilities, _ = all_findings(report)
    severe = [v for v in vulnerabilities if v.get('PkgName') in affected and v.get('Severity') in SEVERE
              and v.get('InstalledVersion') == version]
    require(severe, f'{label}: no HIGH/CRITICAL findings for {source} {version}; Debian advisory lookup is not proven')
    return {'source': source, 'version': version, 'severeFindings': len(severe),
            'ids': len({v.get('VulnerabilityID') for v in severe})}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = parser.add_subparsers(dest='command', required=True)
    specs = {
        'record': ['--root', '--packages', '--debian-os-release', '--debian-version', '--out'],
        'component-root': ['--packages', '--inventory', '--out'],
        'bind': ['--inventory', '--image-root', '--component-root'],
        'check-scan': ['--scan'], 'check-sbom': ['--sbom'], 'check-image-scan': ['--scan'],
        'negative-control': ['--sbom', '--source', '--version', '--out'],
        'check-negative-control': ['--scan', '--source', '--version'],
    }
    for name, options in specs.items():
        p = sub.add_parser(name)
        if name != 'negative-control':
            p.add_argument('--lock', required=True)
            p.add_argument('--arch', required=True)
        for option in options:
            p.add_argument(option, required=True)
    sub.choices['check-image-scan'].add_argument('--image', help='expected ArtifactName (image ID or digest)')
    args = parser.parse_args(argv)
    read = lambda path: json.loads(Path(path).read_text(encoding='utf-8'))  # noqa: E731
    lock = ohpkg.load_lock(args.lock, args.arch) if hasattr(args, 'lock') else None
    if args.command == 'record':
        inventory = record(lock, args.arch, args.root, args.packages, args.debian_os_release, args.debian_version)
        ohpkg.write_json(args.out, inventory)
        result = {'inventory': args.out, 'digest': inventory['digest'], 'files': len(inventory['files']),
                  'omittedByPolicy': sorted(inventory['omittedByPolicy'])}
    elif args.command == 'component-root':
        result = component_root(lock, args.arch, args.packages, args.inventory, args.out)
    elif args.command == 'bind':
        result = bind(lock, args.arch, args.inventory, args.image_root, args.component_root)
    elif args.command == 'check-scan':
        result = check_scan(lock, args.arch, read(args.scan))
    elif args.command == 'check-sbom':
        result = check_sbom(lock, args.arch, read(args.sbom))
    elif args.command == 'check-image-scan':
        result = check_image_scan(lock, args.arch, read(args.scan), args.image)
    elif args.command == 'negative-control':
        document, changed = negative_control(read(args.sbom), args.source, args.version)
        ohpkg.write_json(args.out, document)
        result = {'out': args.out, 'regressed': changed, 'version': args.version}
    else:
        result = check_negative_control(lock, args.arch, read(args.scan), args.source, args.version)
    print(json.dumps(result, sort_keys=True))


if __name__ == '__main__':
    try:
        main()
    except (ohpkg.InputError, OSError, KeyError, ValueError) as error:
        print(f'debian_origin: {error}', file=sys.stderr)
        sys.exit(1)
