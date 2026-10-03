"""Fake Trivy CLI for the offline release-gate tests. It downloads nothing and scans only synthetic inputs.

It answers the calls scripts/debian-origin-gate.py makes: `version`, `rootfs` (JSON or CycloneDX of a component
root, read from its dpkg status and Debian os-release), `sbom` (JSON findings for a CycloneDX document) and
`image --image-src docker` (an Ubuntu report listing the lock's final package set for a fake image). Report fields
follow root's retained Trivy 0.74 reports (ArtifactName is the target as given; ArtifactType; Metadata.ImageID and
ImageConfig for images; the SBOM's metadata.component.name is the scanned path). Like Trivy, a Debian package is
matched to advisories by its source name and source version: the regressed Chromium source version gets HIGH
findings, so the negative control works. `--exit-code 1` turns any finding or secret into exit status 1.

Scenarios in fake-state.json, keyed by gate step, make a step find a vulnerability or secret (with or without the
exit code), skip or corrupt its report, hang, report another architecture, artifact, artifact type, image or
version, or change the database, the source database or the lock mid-run. The fake refuses to run with any
inherited TRIVY_* variable or a scan without `--config /dev/null`, and it appends every call (arguments,
environment names, working directory) to trivy-log.jsonl.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE, LOG = HERE / 'fake-state.json', HERE / 'trivy-log.jsonl'
NEGATIVE = '150.0.7871.181-1~deb13u1'


def fail(message, code=2):
    sys.stderr.write(message + '\n')
    sys.exit(code)


def option(args, name, default=None):
    return args[args.index(name) + 1] if name in args else default


def deb822(text):
    paragraphs, current = [], {}
    for line in text.splitlines():
        if not line.strip():
            if current:
                paragraphs.append(current)
            current = {}
        elif not line[0].isspace():
            key, _, value = line.partition(':')
            current[key] = value.strip()
    if current:
        paragraphs.append(current)
    return paragraphs


def split(version):
    epoch, _, rest = version.rpartition(':')
    upstream, dash, release = rest.rpartition('-')
    return (epoch, upstream, release) if dash else (epoch, rest, '')


def join(epoch, upstream, release):
    text = f'{upstream}-{release}' if release else upstream
    return f'{epoch}:{text}' if epoch not in (None, '', '0', 0) else text


def purl(name, version, arch, distro):
    epoch, upstream, release = split(version)
    return (f'pkg:deb/debian/{name}@{join(None, upstream, release)}?arch={arch}&distro=debian-{distro}'
            + (f'&epoch={epoch}' if epoch else ''))


def component_packages(root):
    root = Path(root)
    release = dict(line.split('=', 1) for line in (root / 'etc/os-release').read_text().splitlines() if '=' in line)
    distro = (root / 'etc/debian_version').read_text().strip()
    packages = []
    for paragraph in deb822((root / 'var/lib/dpkg/status').read_text()):
        source, _, rest = paragraph.get('Source', paragraph['Package']).partition(' ')
        source_version = rest.strip()[1:-1] if rest.strip().startswith('(') else paragraph['Version']
        packages.append({'name': paragraph['Package'], 'version': paragraph['Version'], 'source': source,
                         'sourceVersion': source_version, 'arch': paragraph['Architecture']})
    return ('debian' if release.get('ID') == 'debian' else 'none'), distro, packages


def row(package, distro):
    epoch, upstream, release = split(package['version'])
    source_epoch, source_upstream, source_release = split(package['sourceVersion'])
    result = {'ID': f'{package["name"]}@{package["version"]}', 'Name': package['name'],
              'Identifier': {'PURL': purl(package['name'], package['version'], package['arch'], distro)},
              'Version': upstream, 'Release': release, 'Arch': package['arch'], 'SrcName': package['source'],
              'SrcVersion': source_upstream, 'SrcRelease': source_release}
    if epoch:
        result['Epoch'] = int(epoch)
    if source_epoch:
        result['SrcEpoch'] = int(source_epoch)
    return result


def findings(packages, scenario):
    vulnerabilities = []
    for package in packages:
        matched = package['version'] if scenario == 'binary-only' else package['sourceVersion']
        if package['source'] == 'chromium' and matched == NEGATIVE:
            vulnerabilities += [{'VulnerabilityID': f'CVE-2026-{n}', 'PkgName': package['name'], 'PkgID': f'{package["name"]}@{package["version"]}',
                                 'InstalledVersion': package['version'], 'FixedVersion': '151.0.7922.71-1~deb13u1',
                                 'Severity': 'HIGH', 'Status': 'fixed'} for n in (1001, 1002)]
    if scenario == 'wrong-version-findings':
        vulnerabilities = [dict(v, InstalledVersion='149.0.1-1~deb13u1') for v in vulnerabilities]
    if scenario == 'no-findings':
        vulnerabilities = []
    if scenario in ('vulnerable', 'silent-vulnerable'):
        vulnerabilities.append({'VulnerabilityID': 'CVE-2026-9999', 'PkgName': packages[0]['name'], 'Severity': 'CRITICAL',
                                'InstalledVersion': packages[0]['version'], 'Status': 'fixed'})
    return vulnerabilities


def secret_result(target):
    return {'Target': target, 'Class': 'secret', 'Secrets': [{'RuleID': 'private-key', 'Category': 'AsymmetricPrivateKey',
                                                              'Severity': 'HIGH', 'Title': 'Asymmetric Private Key'}]}


def debian_report(target, artifact_type, family, distro, packages, scenario):
    vulnerabilities = findings(packages, scenario)
    results = [{'Target': f'{target} (debian {distro})', 'Class': 'os-pkgs', 'Type': 'debian',
                'Packages': [row(p, distro) for p in packages], **({'Vulnerabilities': vulnerabilities} if vulnerabilities else {})}]
    if scenario == 'secret':
        results.append(secret_result('etc/open-harness-test-key'))
    report = {'SchemaVersion': 2, 'Trivy': {'Version': '0.74.0-fake'}, 'ArtifactName': target, 'ArtifactType': artifact_type,
              'Metadata': {'OS': {'Family': family, 'Name': distro}}, 'Results': results}
    return report, bool(vulnerabilities) or scenario == 'secret'


def cyclonedx(target, distro, packages):
    components, refs = [], []
    for package in packages:
        epoch, upstream, release = split(package['version'])
        source_epoch, source_upstream, source_release = split(package['sourceVersion'])
        ref = purl(package['name'], package['version'], package['arch'], distro)
        properties = [{'name': 'aquasecurity:trivy:PkgID', 'value': f'{package["name"]}@{package["version"]}'},
                      {'name': 'aquasecurity:trivy:PkgType', 'value': 'debian'},
                      {'name': 'aquasecurity:trivy:SrcName', 'value': package['source']},
                      {'name': 'aquasecurity:trivy:SrcRelease', 'value': source_release},
                      {'name': 'aquasecurity:trivy:SrcVersion', 'value': source_upstream}]
        if source_epoch:
            properties.append({'name': 'aquasecurity:trivy:SrcEpoch', 'value': source_epoch})
        components.append({'bom-ref': ref, 'type': 'library', 'name': package['name'], 'version': package['version'],
                           'purl': ref, 'properties': properties})
        refs.append(ref)
    components.append({'bom-ref': 'os-debian', 'type': 'operating-system', 'name': 'debian', 'version': distro,
                       'properties': [{'name': 'aquasecurity:trivy:Class', 'value': 'os-pkgs'},
                                      {'name': 'aquasecurity:trivy:Type', 'value': 'debian'}]})
    return {'bomFormat': 'CycloneDX', 'specVersion': '1.7', 'version': 1,
            'metadata': {'tools': {'components': [{'type': 'application', 'name': 'trivy', 'version': '0.74.0-fake'}]},
                         'component': {'bom-ref': 'root', 'type': 'application', 'name': target}},
            'components': components, 'dependencies': [{'ref': 'root', 'dependsOn': ['os-debian']}, {'ref': 'os-debian', 'dependsOn': refs}],
            'vulnerabilities': []}


def sbom_packages(document):
    system = next(c for c in document['components'] if c['type'] == 'operating-system')
    packages = []
    for component in document['components']:
        if component['type'] == 'operating-system':
            continue
        props = {p['name'].rsplit(':', 1)[-1]: p['value'] for p in component.get('properties', [])}
        arch = re.search(r'[?&]arch=([^&]+)', component['purl']).group(1)
        packages.append({'name': component['name'], 'version': component['version'], 'source': props['SrcName'], 'arch': arch,
                         'sourceVersion': join(props.get('SrcEpoch'), props['SrcVersion'], props.get('SrcRelease'))})
    return system['version'], packages


def step_name(command, args):
    output = Path(option(args, '--output', 'x')).name
    return {'component-scan.json': 'component-scan', 'component.cdx.json': 'component-sbom', 'sbom-scan.json': 'sbom-scan',
            'negative-scan.json': 'negative-scan', 'image-scan.json': 'image-scan'}.get(output, command)


def image_report(target, image, lock, arch, scenario):
    inspect = image['inspect']
    rows = [{'ID': f'{name}@{version}', 'Name': name, 'Version': version, 'Arch': package_arch}
            for name, (version, package_arch) in lock['finalPackages'][arch].items()]
    results = [{'Target': f'{target} (ubuntu 26.04)', 'Class': 'os-pkgs', 'Type': 'ubuntu', 'Packages': rows}]
    found = False
    if scenario in ('vulnerable', 'silent-vulnerable'):
        results[0]['Vulnerabilities'] = [{'VulnerabilityID': 'CVE-2026-9998', 'PkgName': rows[0]['Name'], 'Severity': 'HIGH',
                                          'InstalledVersion': rows[0]['Version'], 'Status': 'fixed'}]
        found = True
    if scenario == 'secret':
        results.append(secret_result('/home/hermes/.ssh/id_rsa'))
        found = True
    image_id = 'sha256:' + 'e' * 64 if scenario == 'wrong-image-id' else inspect['Id']
    report = {'SchemaVersion': 2, 'Trivy': {'Version': '0.74.0-fake'}, 'ArtifactName': target, 'ArtifactType': 'container_image',
              'Metadata': {'OS': {'Family': 'ubuntu', 'Name': '26.04'}, 'ImageID': image_id,
                           'ImageConfig': {'architecture': inspect['Architecture'], 'os': inspect['Os'],
                                           'config': {'Labels': (inspect.get('Config') or {}).get('Labels')}}},
              'Results': results}
    return report, found and scenario != 'silent-vulnerable'


def main():
    args = sys.argv[1:]
    state = json.loads(STATE.read_text(encoding='utf-8'))
    with LOG.open('a', encoding='utf-8') as log:
        log.write(json.dumps({'argv': args, 'env': sorted(os.environ), 'dockerHost': os.environ.get('DOCKER_HOST'),
                              'home': os.environ.get('HOME'), 'cwd': os.getcwd()}) + '\n')
    leaked = sorted(name for name in os.environ if name.startswith('TRIVY_'))
    if leaked:
        fail(f'inherited scanner configuration: {leaked}', 3)
    command = args[0]
    scenarios = state.get('scenario', {})
    if command == 'version':
        metadata = json.loads((Path(option(args, '--cache-dir')) / 'db/metadata.json').read_text())
        if scenarios.get('version') == 'other-db':
            metadata = dict(metadata, UpdatedAt='2020-01-01T00:00:00Z')
        print(json.dumps({'Version': '0.74.0-fake', 'VulnerabilityDB': metadata}))
        return
    if option(args, '--config') != '/dev/null':
        fail('a scan without --config /dev/null could read a hostile trivy.yaml', 3)
    target = args[-1]
    step = step_name(command, args)
    scenario = scenarios.get(step)
    if scenario == 'hang':
        time.sleep(60)
    if scenario == 'modify-db':
        with open(Path(option(args, '--cache-dir')) / 'db/trivy.db', 'ab') as handle:
            handle.write(b'changed')
    if scenario == 'modify-source-db':
        with open(Path(state['sourceCache']) / 'db/trivy.db', 'ab') as handle:
            handle.write(b'changed')
    if scenario == 'modify-lock':
        with open(state['lock'], 'a', encoding='utf-8') as handle:
            handle.write('\n')
    output, found = option(args, '--output'), False
    if command == 'rootfs' and option(args, '--format') == 'cyclonedx':
        _, distro, packages = component_packages(target)
        document = cyclonedx(target if scenario != 'other-described' else target + '-other', distro, packages)
    elif command == 'rootfs':
        family, distro, packages = component_packages(target)
        if scenario == 'wrong-arch':
            for package in packages:
                package['arch'] = 'arm64' if package['arch'] == 'amd64' else 'amd64'
        document, found = debian_report(target, 'filesystem', family, distro, packages, scenario)
    elif command == 'sbom':
        distro, packages = sbom_packages(json.loads(Path(target).read_text()))
        if scenario == 'binary-only':  # the scanner sees the locked source version, as in root's rejected v1 control
            lock = json.loads(Path(state['lock']).read_text())['debian']['packages'][state['arch']]
            for package in packages:
                package['sourceVersion'] = lock[package['name']]['Version']
        document, found = debian_report(target, 'cyclonedx', 'debian', distro, packages, scenario)
    elif command == 'image' and option(args, '--image-src') == 'docker':
        if os.environ.get('DOCKER_HOST') != state['dockerHost']:
            fail(f'image scan against {os.environ.get("DOCKER_HOST")!r}, not the gate daemon', 3)
        image = state['images'].get(target)
        if image is None:
            fail(f'unable to find the image {target}', 1)
        document, found = image_report(target, image, json.loads(Path(state['lock']).read_text()), state['arch'], scenario)
    else:
        fail(f'unexpected trivy call: {args}')
    if scenario == 'silent-vulnerable':
        found = False
    if scenario == 'wrong-artifact':
        document['ArtifactName'] = target + '.other'
    if scenario == 'wrong-type':
        document['ArtifactType'] = 'repository'
    if scenario == 'garbage':
        Path(output).write_text('{"truncated": ', encoding='utf-8')
    elif scenario != 'no-output':
        Path(output).write_text(json.dumps(document), encoding='utf-8')
    sys.exit(1 if found and option(args, '--exit-code') == '1' else 0)


if __name__ == '__main__':
    main()
