#!/usr/bin/env python3
"""Supplemental Debian-origin release gate for one native Open Harness Hermes runtime image.

  python3 -I -B scripts/debian-origin-gate.py --image sha256:<64 hex> --arch arm64|amd64 \\
      --trivy /absolute/path/to/trivy --cache-dir <directory holding db/trivy.db> --out <new directory>

A whole-image scan reads the image's dpkg database as Ubuntu, so it cannot look up Debian advisories for the three
Debian packages in the image (chromium, chromium-common, libjpeg62-turbo). This gate runs the reviewed Debian
component checks of runtime/ubuntu/helpers/debian_origin.py and keeps the whole-image scan. It:

  * binds everything to one immutable local image ID on its own native architecture (docker image inspect, the
    Docker server and this host), to the helper, lock, Dockerfile, readiness and gate sources, and to one scanner
    binary and database, and requires all of them unchanged at the end;
  * rebuilds the Debian component inside that image from its retained authenticated archives and binds it to the
    image's build-time inventory, installed files, dpkg identities and the lock. The two probe containers are
    read-only, network-none, non-root and capability-free, and see only the public helper and lock directories
    (read-only) and one dedicated output directory: no image export and no other host mount;
  * runs the eleven reviewed scanner and helper steps with unchanged thresholds. HIGH/CRITICAL vulnerabilities and
    secrets fail; there is no ignore file, severity change, path exclusion or fallback scan; the negative control
    must prove Debian advisory lookup. Each report must name the exact artifact it was asked to scan;
  * records every command, exit code, stdout, stderr and report before judging it, failures included, and writes
    receipt.json only when every step and binding holds (failure.json otherwise).

Scanner children get a fresh environment (nothing inherited: no TRIVY_*, DOCKER_*, proxy or Python variables), an
empty working directory, `--config /dev/null` and a private copy of the database, so a hostile environment,
configuration file, ignore file or scan cache cannot weaken a check. Every child has a bounded timeout. Cleanup
removes only the probe containers this invocation created, identified by name, container ID, label and image.
Standard library only; Python 3.11+. It runs Docker and the scanner, so it belongs to root's native release steps.
"""
import argparse
import datetime
import hashlib
import json
import os
import platform
import re
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = 'open-harness-debian-origin-gate/1'
REPO = Path(__file__).resolve().parent.parent
HELPERS = REPO / 'runtime' / 'ubuntu' / 'helpers'
LOCK_DIR = REPO / 'runtime' / 'ubuntu' / 'lock'
LOCK = LOCK_DIR / 'runtime-inputs.lock.json'
DOCKERFILE = REPO / 'runtime' / 'hermes' / 'Dockerfile'
READINESS = REPO / 'runtime' / 'readiness.ts'
SOURCE_FILES = ('scripts/debian-origin-gate.py', 'runtime/hermes/Dockerfile', 'runtime/readiness.ts')
SOURCE_DIRECTORIES = ('runtime/ubuntu/helpers', 'runtime/ubuntu/lock')
# Paths inside the image, as runtime/hermes/Dockerfile creates them.
IMAGE_PYTHON = '/usr/local/bin/python3'
IMAGE_PACKAGES = '/opt/open-harness/debian-browser/packages'
IMAGE_INVENTORY = '/opt/open-harness/verification/debian-origin-inventory.json'
RUNTIME_LABEL = 'dev.openharness.runtime'
PROBE_LABEL = 'dev.openharness.debian-origin-gate'
# The authenticated older Chromium source version of root's negative control.
NEGATIVE_SOURCE, NEGATIVE_VERSION = 'chromium', '150.0.7871.181-1~deb13u1'
NATIVE = {'aarch64': 'arm64', 'arm64': 'arm64', 'x86_64': 'amd64', 'amd64': 'amd64'}
STEPS = (('probe-component-root', 0), ('probe-bind', 0), ('component-scan', 0), ('check-component', 0),
         ('component-sbom', 0), ('check-sbom', 0), ('sbom-scan', 0), ('check-sbom-scan', 0), ('make-negative', 0),
         ('negative-scan', 1), ('check-negative', 0), ('image-scan', 0), ('check-image', 0))
# Seconds per child process; every child except cleanup is also bounded by the gate deadline.
TIMEOUTS = {'docker': 120, 'cleanup': 30, 'probe': 900, 'trivy': 1800, 'helper': 300}
SCOPE = 'Supplemental Debian-origin gate of one native image; not acceptance of other images, databases or release gates.'


class GateError(Exception):
    """A binding, step or postcondition failed; the gate stops and writes failure.json."""


def require(condition, message):
    if not condition:
        raise GateError(message)


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, indent=2, sort_keys=True) + '\n', encoding='utf-8')


def source_files(repo=REPO):
    """{repo-relative path: sha256} of everything the gate and its probes read from the checkout.

    Regular files only: a link or special file refuses the run. __pycache__ directories are skipped; they are never
    read because every Python child runs with -B and a pycache prefix that does not exist. scripts/release-images.mjs
    recomputes exactly this set before publication (debianOriginSources).
    """
    files = {}

    def walk(directory):
        for entry in sorted(os.scandir(directory), key=lambda item: item.name):
            path = Path(entry.path)
            mode = path.lstat().st_mode
            if stat.S_ISDIR(mode) and entry.name == '__pycache__':
                continue
            require(not stat.S_ISLNK(mode), f'{path}: links are not accepted among the gate inputs')
            if stat.S_ISDIR(mode):
                walk(path)
            else:
                require(stat.S_ISREG(mode), f'{path}: only regular files are accepted among the gate inputs')
                files[path.relative_to(repo).as_posix()] = sha256_file(path)

    for relative in SOURCE_FILES:
        path = repo / relative
        require(path.is_file() and not path.is_symlink(), f'{path}: missing or not a regular file')
        files[relative] = sha256_file(path)
    for relative in SOURCE_DIRECTORIES:
        directory = repo / relative
        require(directory.is_dir() and not directory.is_symlink(), f'{directory}: missing or not a directory')
        walk(directory)
    return dict(sorted(files.items()))


def tree_digest(root):
    """Digest of a directory tree at lstat level: every directory and file (mode, bytes) and link (target)."""
    entries = []
    for current, dirs, names in os.walk(root):
        dirs.sort()
        for name in sorted([*dirs, *names]):
            path = Path(current) / name
            relative, info = path.relative_to(root).as_posix(), path.lstat()
            if stat.S_ISLNK(info.st_mode):
                entries.append([relative, 'link', os.readlink(path)])
            elif stat.S_ISDIR(info.st_mode):
                entries.append([relative, 'dir', oct(info.st_mode & 0o7777)])
            elif stat.S_ISREG(info.st_mode):
                entries.append([relative, 'file', oct(info.st_mode & 0o7777), sha256_file(path)])
            else:
                raise GateError(f'{path}: unexpected special file in the component root')
    return sha256_bytes(json.dumps(entries).encode()), len(entries)


def database_files(cache):
    """{relative path: sha256} of the vulnerability and Java databases in a Trivy cache (not its scan cache)."""
    files = {}
    for directory in ('db', 'java-db'):
        base = Path(cache) / directory
        if not base.exists() and not base.is_symlink():
            continue
        require(base.is_dir() and not base.is_symlink(), f'{base}: not a directory')
        for path in sorted(base.rglob('*')):
            require(not path.is_symlink(), f'{path}: links are not accepted in the scanner database')
            if path.is_file():
                files[path.relative_to(cache).as_posix()] = sha256_file(path)
    return files


def mount_source(path):
    text = str(path)
    require(text.startswith('/') and not any(c in text for c in ',"\n\r'), f'{text}: cannot be a Docker mount source')
    return text


def missing_container(code, error, target):
    # A missing daemon socket or a mixed error is not evidence that this container is gone.
    return code == 1 and re.fullmatch(
        rf'(?:Error: |Error response from daemon: )?No such (?:container|object): {re.escape(target)}',
        error.strip(), re.IGNORECASE) is not None


def remove_tree(path):
    def retry(function, target, _):
        os.chmod(os.path.dirname(target), stat.S_IRWXU)
        function(target)
    if Path(path).exists():
        if sys.version_info >= (3, 12):
            shutil.rmtree(path, onexc=retry)
        else:
            shutil.rmtree(path, onerror=retry)


class Gate:
    def __init__(self, args):
        self.args = args
        self.image, self.arch = args.image, args.arch
        self.out = Path(args.out).absolute()
        self.work = self.out / 'work'
        self.probe_root = self.work / 'probe'
        self.cache = self.work / 'trivy-cache'
        self.nonce = secrets.token_hex(8)
        self.deadline = time.monotonic() + args.deadline_minutes * 60
        self.status = {'schema': SCHEMA, 'ok': None, 'nonce': self.nonce, 'startedAt': now(), 'architecture': self.arch,
                       'image': self.image, 'calls': [], 'steps': [], 'cleanup': [], 'scope': SCOPE}
        self.checks, self.reports, self.probes, self.cleanup_errors = {}, {}, [], []
        self.phase = 'preflight'  # preflight, a step name, postconditions or cleanup: where a failure happened

    # ---- recording ------------------------------------------------------------------------------------------
    def save_status(self):
        write_json(self.out / 'status.json', self.status)

    def env(self, docker_host=False):
        """A fresh environment for every child: nothing is inherited from the invoking shell."""
        env = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(self.work / 'home'),
               'TMPDIR': str(self.work / 'tmp'), 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8',
               'DOCKER_CONFIG': str(self.work / 'docker-config'), 'PYTHONDONTWRITEBYTECODE': '1'}
        if docker_host:
            env['DOCKER_HOST'] = self.args.docker_host
        return env

    def timeout(self, kind):
        if kind == 'cleanup':  # cleanup keeps its own bounded time after the deadline
            return TIMEOUTS['cleanup']
        remaining = self.deadline - time.monotonic()
        require(remaining > 0, 'the gate deadline passed')
        return max(1.0, min(TIMEOUTS[kind], remaining))

    def run(self, command, limit, docker_host=False):
        started = time.monotonic()
        try:
            result = subprocess.run(command, capture_output=True, env=self.env(docker_host), cwd=self.work / 'cwd',
                                    timeout=limit, stdin=subprocess.DEVNULL)
            return result.returncode, result.stdout, result.stderr, time.monotonic() - started, False
        except subprocess.TimeoutExpired as expired:  # the child was killed
            return None, expired.stdout or b'', expired.stderr or b'', time.monotonic() - started, True

    def call(self, name, command, kind='docker', docker_host=False):
        """A recorded command outside the thirteen steps (Docker version/inspect/rm, scanner version)."""
        limit = self.timeout(kind)
        code, stdout, stderr, seconds, timed_out = self.run(command, limit, docker_host)
        name = f'{len(self.status["calls"]):02d}-{name}'
        (self.out / 'calls' / f'{name}.stdout').write_bytes(stdout)
        (self.out / 'calls' / f'{name}.stderr').write_bytes(stderr)
        self.status['calls'].append({'name': name, 'command': command, 'returncode': code, 'timedOut': timed_out,
                                     'seconds': round(seconds, 3),
                                     'stdout': {'path': f'calls/{name}.stdout', 'sha256': sha256_bytes(stdout)},
                                     'stderr': {'path': f'calls/{name}.stderr', 'sha256': sha256_bytes(stderr)}})
        self.save_status()
        require(not timed_out, f'{name}: timed out after {limit:.0f} s')
        return code, stdout.decode('utf-8', errors='replace'), stderr.decode('utf-8', errors='replace')

    def docker(self, name, *arguments, allow_failure=False, kind='docker'):
        code, stdout, stderr = self.call(name, [self.args.docker, '--host', self.args.docker_host, *arguments], kind)
        require(allow_failure or code == 0, f'{name}: docker exited {code}: {stderr[-400:]}')
        return code, stdout, stderr

    def step(self, name, command, kind, outputs=(), docker_host=False):
        """One of the thirteen gate steps: record everything first, then judge exit code and reports."""
        done = [s['name'] for s in self.status['steps']]
        require(len(done) < len(STEPS) and done == [n for n, _ in STEPS][:len(done)] and STEPS[len(done)][0] == name,
                f'{name}: out of order after {done}')
        self.phase = name
        limit = self.timeout(kind)
        expected = dict(STEPS)[name]
        entry = {'name': name, 'command': command, 'expectedReturncode': expected, 'startedAt': now()}
        self.status['steps'].append(entry)
        self.save_status()
        try:
            code, stdout, stderr, seconds, timed_out = self.run(command, limit, docker_host)
        except BaseException as error:  # interrupted: the child was killed; keep the record of what was running
            entry.update(returncode=None, timedOut=False, interrupted=str(error) or type(error).__name__)
            self.save_status()
            raise
        (self.out / 'steps' / f'{name}.stdout').write_bytes(stdout)
        (self.out / 'steps' / f'{name}.stderr').write_bytes(stderr)
        entry.update(returncode=code, timedOut=timed_out, seconds=round(seconds, 3),
                     stdout={'path': f'steps/{name}.stdout', 'sha256': sha256_bytes(stdout)},
                     stderr={'path': f'steps/{name}.stderr', 'sha256': sha256_bytes(stderr)},
                     outputs={p.relative_to(self.out).as_posix(): (sha256_file(p) if p.is_file() else None) for p in outputs})
        self.save_status()
        require(not timed_out, f'{name} timed out after {limit:.0f} s')
        require(code == expected, f'{name} exited {code}, expected {expected}: {stderr.decode(errors="replace")[-600:]}')
        for path in outputs:
            require(path.is_file() and path.stat().st_size > 0, f'{name}: report {path.name} is missing or empty')
            try:
                json.loads(path.read_text(encoding='utf-8'))
            except ValueError as error:
                raise GateError(f'{name}: report {path.name} is not JSON: {error}') from None
        return stdout.decode('utf-8', errors='replace')

    # ---- preflight: every identity is fixed before the first step ----------------------------------------------
    def preflight(self):
        require(re.fullmatch(r'sha256:[0-9a-f]{64}', self.image), f'{self.image!r} is not an immutable local image ID')
        machine = platform.machine()
        require(NATIVE.get(machine.lower()) == self.arch, f'this host is {machine}, not native {self.arch}')
        for option, value in (('--docker', self.args.docker), ('--trivy', self.args.trivy), ('--cache-dir', self.args.cache_dir)):
            require(os.path.isabs(value), f'{option} must be an absolute path')
        uid, own = os.getuid(), f'{os.getuid()}:{os.getgid()}'
        user = self.args.probe_user or (own if uid != 0 else None)
        require(user, 'running as root: pass --probe-user UID:GID (non-root) for the probe containers')
        match = re.fullmatch(r'([0-9]+):([0-9]+)', user)
        require(match and int(match[1]) != 0 and int(match[2]) != 0, f'probe user {user!r} must be a non-root UID:GID')
        user = f'{int(match[1])}:{int(match[2])}'
        require(uid == 0 or user == own, f'the probes run as this user ({own}), who owns their output directory; '
                                         '--probe-user is only for a gate run as root')
        self.probe_user = user
        # Sources: the lock must be the one the Dockerfile builds with; the image must carry this runtime contract.
        self.sources = source_files()
        dockerfile = DOCKERFILE.read_text(encoding='utf-8')
        for name in ('runtime-inputs.lock.json', 'ubuntu-os-packages.txt'):
            pinned = re.findall(rf'([0-9a-f]{{64}}) {re.escape(name)}', dockerfile)
            require(pinned == [self.sources[f'runtime/ubuntu/lock/{name}']],
                    f'{name} differs from the hash runtime/hermes/Dockerfile builds with')
        lock = json.loads(LOCK.read_text(encoding='utf-8'))
        self.debian_packages = sorted(lock['debian']['packages'][self.arch])
        self.final_packages = len(lock['finalPackages'][self.arch])
        require(self.debian_packages and self.final_packages, f'the lock has no {self.arch} packages')
        contract = re.search(r'export const RUNTIME_CONTRACT = (\d+);', READINESS.read_text(encoding='utf-8'))
        require(contract, 'runtime/readiness.ts has no RUNTIME_CONTRACT')
        self.contract = contract[1]
        for path in (HELPERS, LOCK_DIR, self.probe_root):
            mount_source(path)
        # Scanner and database: absolute, regular, hashed; the database is copied into a fresh private cache.
        self.trivy = str(Path(self.args.trivy).resolve())
        require(Path(self.trivy).is_file() and os.access(self.trivy, os.X_OK), f'{self.args.trivy}: not an executable file')
        require(Path(self.args.docker).is_file() and os.access(self.args.docker, os.X_OK), f'{self.args.docker}: not an executable file')
        self.trivy_sha256 = sha256_file(self.trivy)
        self.source_db = database_files(self.args.cache_dir)
        require({'db/trivy.db', 'db/metadata.json'} <= set(self.source_db),
                f'{self.args.cache_dir}: needs db/trivy.db and db/metadata.json, downloaded before the gate')
        for relative in self.source_db:
            (self.cache / relative).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(Path(self.args.cache_dir) / relative, self.cache / relative)
        self.used_db = database_files(self.cache)
        require(self.used_db == self.source_db, 'the private database copy differs from its source')
        self.db_metadata = json.loads((self.cache / 'db' / 'metadata.json').read_text(encoding='utf-8'))
        self.status.update(sources={'files': self.sources, 'runtimeContract': self.contract},
                           database={'sourceBefore': self.source_db, 'usedBefore': self.used_db, 'metadata': self.db_metadata},
                           scanner={'path': self.args.trivy, 'resolvedPath': self.trivy, 'sha256': self.trivy_sha256})
        self.save_status()
        # Docker server, image and scanner identities.
        _, text, _ = self.docker('docker-version', 'version', '--format', '{{json .Server}}')
        server = json.loads(text)
        require(server.get('Os') == 'linux' and server.get('Arch') == self.arch,
                f'the Docker server is {server.get("Os")}/{server.get("Arch")}, not native linux/{self.arch}')
        self.image_record = self.inspect_image()
        code, text, error = self.call('trivy-version', [self.trivy, 'version', '--cache-dir', str(self.cache), '--format', 'json'], 'helper')
        require(code == 0, f'trivy version exited {code}: {error[-400:]}')
        version = json.loads(text)
        database = version.get('VulnerabilityDB') or {}
        require(version.get('Version') and database.get('Version') == self.db_metadata.get('Version')
                and database.get('UpdatedAt') == self.db_metadata.get('UpdatedAt'), 'the scanner does not report the copied database')
        self.status['host'] = {'machine': machine, 'docker': {k: server.get(k) for k in ('Version', 'ApiVersion', 'Os', 'Arch')},
                               'dockerHost': self.args.docker_host, 'probeUser': self.probe_user}
        self.status['scanner']['version'] = version
        self.save_status()

    def inspect_image(self):
        _, text, _ = self.docker('image-inspect', 'image', 'inspect', self.image)
        images = json.loads(text)
        require(isinstance(images, list) and len(images) == 1, 'docker image inspect must return exactly one image')
        image = images[0]
        require(image.get('Id') == self.image, f'docker resolved {self.image} to {image.get("Id")}')
        require(image.get('Os') == 'linux' and image.get('Architecture') == self.arch,
                f'the image is {image.get("Os")}/{image.get("Architecture")}, not linux/{self.arch}')
        config = image.get('Config') or {}
        labels = config.get('Labels') or {}
        require(labels.get(RUNTIME_LABEL) == self.contract,
                f'the image runtime contract is {labels.get(RUNTIME_LABEL)!r}, not {self.contract} (runtime/readiness.ts)')
        return {'id': image['Id'], 'os': image['Os'], 'architecture': image['Architecture'], 'variant': image.get('Variant'),
                'created': image.get('Created'), 'repoTags': image.get('RepoTags') or [], 'repoDigests': image.get('RepoDigests') or [],
                'labels': labels, 'user': config.get('User'), 'layers': (image.get('RootFS') or {}).get('Layers') or []}

    # ---- probes: the image's own files, never exported ---------------------------------------------------------
    def probe(self, name, helper):
        container = f'oh-debian-origin-gate-{self.nonce}-{name}'
        probe = {'container': container, 'cidfile': self.out / 'steps' / f'{name}.cid', 'attempted': False, 'removed': False}
        self.probes.append(probe)
        command = [self.args.docker, '--host', self.args.docker_host, 'run', '--name', container,
                   '--cidfile', str(probe['cidfile']), '--rm', '--label', f'{PROBE_LABEL}={self.nonce}', '--pull', 'never',
                   '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
                   '--pids-limit', '256', '--memory', '3g', '--memory-swap', '3g', '--user', self.probe_user,
                   '--workdir', '/out', '--env', 'PYTHONDONTWRITEBYTECODE=1',
                   '--mount', f'type=bind,src={mount_source(HELPERS)},dst=/gate/helpers,readonly',
                   '--mount', f'type=bind,src={mount_source(LOCK_DIR)},dst=/gate/lock,readonly',
                   '--mount', f'type=bind,src={mount_source(self.probe_root)},dst=/out',
                   '--entrypoint', IMAGE_PYTHON, self.image,
                   '-I', '-B', '-X', 'pycache_prefix=/gate/no-pycache', '/gate/helpers/debian_origin.py', *helper]
        try:
            return json.loads(self.step(name, command, 'probe'))
        finally:
            self.remove_probe(probe)

    def remove_probe(self, probe):
        """Remove exactly this invocation's probe container if it still exists; never touch anything else."""
        if probe['attempted']:
            return
        probe['attempted'] = True
        container = probe['container']
        try:
            code, text, error = self.docker('probe-inspect', 'inspect', '--type', 'container', container,
                                            allow_failure=True, kind='cleanup')
            if code != 0:
                require(missing_container(code, error, container), f'{container}: cannot inspect: {error[-300:]}')
                self.status['cleanup'].append({'container': container, 'action': 'absent'})
            else:
                info = json.loads(text)[0]
                cid = probe['cidfile'].read_text(encoding='utf-8').strip() if probe['cidfile'].is_file() else None
                labels = (info.get('Config') or {}).get('Labels') or {}
                require(info.get('Name') == f'/{container}' and labels.get(PROBE_LABEL) == self.nonce
                        and (info.get('Config') or {}).get('Image') == self.image and cid in (None, info.get('Id')),
                        f"{container} exists but is not this invocation's probe; it was left untouched")
                self.docker('probe-remove', 'rm', '--force', info['Id'], allow_failure=True, kind='cleanup')
                code, _, error = self.docker('probe-reinspect', 'inspect', '--type', 'container', info['Id'],
                                             allow_failure=True, kind='cleanup')
                require(missing_container(code, error, info['Id']), f'{container} could not be removed')
                self.status['cleanup'].append({'container': container, 'id': info['Id'], 'action': 'removed'})
            probe['removed'] = True
        except Exception as error:  # recorded; a cleanup problem always fails the gate
            self.cleanup_errors.append(f'{container}: {error}')
        self.save_status()

    # ---- the thirteen steps ------------------------------------------------------------------------------------
    def helper(self, *arguments):
        return [sys.executable, '-I', '-B', '-X', f'pycache_prefix={self.work / "no-pycache"}',
                str(HELPERS / 'debian_origin.py'), *arguments]

    def check(self, name, command, *arguments):
        self.checks[name] = json.loads(self.step(name, self.helper(command, '--lock', str(LOCK), '--arch', self.arch, *arguments), 'helper'))
        return self.checks[name]

    def scan(self, name, command, target, report, artifact_type, docker_host=False):
        """A scanner step whose JSON report must name exactly the artifact it was asked to scan."""
        self.step(name, command, 'trivy', [report], docker_host)
        document = json.loads(report.read_text(encoding='utf-8'))
        found = {'artifactName': document.get('ArtifactName'), 'artifactType': document.get('ArtifactType')}
        self.reports[name] = found
        require(found == {'artifactName': target, 'artifactType': artifact_type},
                f'{name}: the report is of {found["artifactType"]} {found["artifactName"]!r}, not {artifact_type} {target!r}')
        return document

    def gate(self):
        lock = ['--lock', '/gate/lock/runtime-inputs.lock.json', '--arch', self.arch]
        built = self.probe('probe-component-root', ['component-root', *lock, '--packages', IMAGE_PACKAGES,
                                                     '--inventory', IMAGE_INVENTORY, '--out', '/out/component'])
        require(built.get('root') == '/out/component' and built.get('packages') == self.debian_packages,
                f'component-root reported {built}')
        bound = self.probe('probe-bind', ['bind', *lock, '--inventory', IMAGE_INVENTORY, '--image-root', '/',
                                          '--component-root', '/out/component'])
        require(bound.get('architecture') == self.arch and bound.get('packages') == self.debian_packages
                and re.fullmatch(r'[0-9a-f]{64}', str(bound.get('inventoryDigest')))
                and built.get('files') == bound.get('files', -1) + bound.get('omittedByPolicy', -1), f'bind reported {bound}')
        component = self.probe_root / 'component'
        self.component = tree_digest(component)
        self.status['probe'] = {'user': self.probe_user, 'componentRoot': built, 'bind': bound,
                                'componentTreeSha256': self.component[0], 'componentEntries': self.component[1]}
        self.save_status()
        reports = self.out / 'reports'
        common = ['--cache-dir', str(self.cache), '--skip-db-update', '--offline-scan', '--disable-telemetry',
                  '--skip-version-check', '--config', '/dev/null']
        scan = ['--list-all-pkgs', '--severity', 'HIGH,CRITICAL', '--ignorefile', '/dev/null', '--exit-code', '1', '--format', 'json']
        sbom, control = reports / 'component.cdx.json', reports / 'control.cdx.json'
        out = {name: reports / f'{name}.json' for name in ('component-scan', 'sbom-scan', 'negative-scan', 'image-scan')}
        self.scan('component-scan', [self.trivy, 'rootfs', *common, *scan, '--scanners', 'vuln,secret',
                                     '--output', str(out['component-scan']), str(component)], str(component), out['component-scan'], 'filesystem')
        self.check('check-component', 'check-scan', '--scan', str(out['component-scan']))
        self.step('component-sbom', [self.trivy, 'rootfs', *common, '--format', 'cyclonedx', '--output', str(sbom), str(component)],
                  'trivy', [sbom])
        document = json.loads(sbom.read_text(encoding='utf-8'))
        described = ((document.get('metadata') or {}).get('component') or {}).get('name')
        self.reports['component-sbom'] = {'bomFormat': document.get('bomFormat'), 'componentName': described}
        require(document.get('bomFormat') == 'CycloneDX' and described == str(component),
                f'component-sbom: the SBOM describes {described!r}, not {str(component)!r}')
        self.check('check-sbom', 'check-sbom', '--sbom', str(sbom))
        self.scan('sbom-scan', [self.trivy, 'sbom', *common, *scan, '--output', str(out['sbom-scan']), str(sbom)],
                  str(sbom), out['sbom-scan'], 'cyclonedx')
        self.check('check-sbom-scan', 'check-scan', '--scan', str(out['sbom-scan']))
        made = json.loads(self.step('make-negative', self.helper('negative-control', '--sbom', str(sbom), '--source', NEGATIVE_SOURCE,
                                                                 '--version', NEGATIVE_VERSION, '--out', str(control)), 'helper', [control]))
        require(made.get('version') == NEGATIVE_VERSION and made.get('regressed'), f'negative-control reported {made}')
        self.scan('negative-scan', [self.trivy, 'sbom', *common, *scan, '--output', str(out['negative-scan']), str(control)],
                  str(control), out['negative-scan'], 'cyclonedx')
        negative = self.check('check-negative', 'check-negative-control', '--scan', str(out['negative-scan']),
                              '--source', NEGATIVE_SOURCE, '--version', NEGATIVE_VERSION)
        require(negative.get('severeFindings', 0) > 0, 'the negative control found no HIGH/CRITICAL advisories')
        whole = self.scan('image-scan', [self.trivy, 'image', '--image-src', 'docker', *common, *scan, '--scanners', 'vuln,secret',
                                         '--output', str(out['image-scan']), self.image], self.image, out['image-scan'],
                          'container_image', docker_host=True)
        metadata = whole.get('Metadata') or {}
        config = metadata.get('ImageConfig') or {}
        self.reports['image-scan'].update(imageId=metadata.get('ImageID'), os=config.get('os'), architecture=config.get('architecture'))
        require(metadata.get('ImageID') == self.image and config.get('os') == 'linux' and config.get('architecture') == self.arch,
                f'image-scan: the scanner saw image {metadata.get("ImageID")} {config.get("os")}/{config.get("architecture")}, '
                f'not {self.image} linux/{self.arch}')
        image = self.check('check-image', 'check-image-scan', '--scan', str(out['image-scan']), '--image', self.image)
        require(image.get('packages') == self.final_packages, f'the whole-image scan listed {image.get("packages")} packages')

    # ---- postconditions and receipt ----------------------------------------------------------------------------
    def postconditions(self):
        require([(s['name'], s['returncode']) for s in self.status['steps']] == list(STEPS), 'the step record is incomplete')
        require(source_files() == self.sources, 'gate, helper, lock, Dockerfile or readiness sources changed during the gate')
        require(sha256_file(self.trivy) == self.trivy_sha256, 'the scanner binary changed during the gate')
        source_db, used_db = database_files(self.args.cache_dir), database_files(self.cache)
        self.status['database'].update(sourceAfter=source_db, usedAfter=used_db)
        require(source_db == self.source_db and used_db == self.used_db, 'the scanner database changed during the gate')
        require(self.inspect_image() == self.image_record, 'the image record changed during the gate')
        require(tree_digest(self.probe_root / 'component') == self.component, 'the component root changed after bind')
        require(not self.cleanup_errors and all(p['removed'] for p in self.probes), f'probe cleanup failed: {self.cleanup_errors}')

    def receipt(self):
        keys = ('name', 'command', 'expectedReturncode', 'returncode', 'timedOut', 'seconds', 'stdout', 'stderr', 'outputs')
        return {'schema': SCHEMA, 'ok': True, 'nonce': self.nonce, 'startedAt': self.status['startedAt'], 'finishedAt': now(),
                'architecture': self.arch, 'image': self.image_record, 'host': self.status['host'], 'sources': self.status['sources'],
                'scanner': self.status['scanner'], 'database': self.status['database'],
                'probe': dict(self.status['probe'], containers=self.status['cleanup']), 'calls': self.status['calls'],
                'steps': [{k: s[k] for k in keys} for s in self.status['steps']], 'reports': self.reports, 'checks': self.checks,
                'negativeControl': dict(self.checks['check-negative'], source=NEGATIVE_SOURCE, version=NEGATIVE_VERSION),
                'scope': SCOPE}

    def execute(self):
        self.out.mkdir(mode=0o700)
        for directory in ('calls', 'steps', 'reports', 'work', 'work/cwd', 'work/home', 'work/tmp', 'work/docker-config',
                          'work/probe', 'work/trivy-cache'):
            (self.out / directory).mkdir(mode=0o700)
        failure = None
        try:
            self.preflight()
            if os.getuid() == 0:
                os.chown(self.probe_root, *(int(x) for x in self.probe_user.split(':')))
            self.gate()
            self.phase = 'postconditions'
            self.postconditions()
        except Exception as error:  # any error is a recorded gate failure; cleanup below still runs
            failure = error
        finally:
            for probe in self.probes:
                self.remove_probe(probe)
            if not self.args.keep_work:
                try:
                    remove_tree(self.work)
                except Exception as error:  # recorded below; a leftover work directory never hides the result
                    self.cleanup_errors.append(f'work directory {self.work}: {error}')
            if self.cleanup_errors and failure is None:
                self.phase = 'cleanup'
                failure = GateError(f'cleanup failed: {self.cleanup_errors}')
        if failure is None:
            receipt = self.receipt()
            self.status.update(ok=True, finishedAt=receipt['finishedAt'])
            self.save_status()
            write_json(self.out / 'receipt.json', receipt)
            print(json.dumps({'ok': True, 'receipt': str(self.out / 'receipt.json'), 'steps': len(STEPS),
                              'negativeControl': receipt['negativeControl']}, sort_keys=True))
            return 0
        failed = self.phase if self.phase in dict(STEPS) else None
        self.status.update(ok=False, finishedAt=now(), error=str(failure), phase=self.phase, failedStep=failed)
        self.save_status()
        write_json(self.out / 'failure.json', {'schema': SCHEMA, 'ok': False, 'error': str(failure), 'phase': self.phase,
                                               'failedStep': failed, 'at': now(), 'image': self.image,
                                               'architecture': self.arch, 'cleanupErrors': self.cleanup_errors})
        print(f'debian-origin-gate: {failure}', file=sys.stderr)
        return 1


def parse(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--image', required=True, help='immutable local image ID, sha256:<64 hex>')
    parser.add_argument('--arch', required=True, choices=('arm64', 'amd64'), help="this host's native architecture")
    parser.add_argument('--trivy', required=True, help='absolute path of the scanner binary')
    parser.add_argument('--cache-dir', required=True, help='absolute Trivy cache holding db/trivy.db and db/metadata.json')
    parser.add_argument('--out', required=True, help='new output directory')
    parser.add_argument('--docker', default='/usr/bin/docker', help='absolute path of the Docker CLI')
    parser.add_argument('--docker-host', default='unix:///var/run/docker.sock')
    parser.add_argument('--probe-user', help='when run as root: non-root UID:GID for the probe containers (default: this user)')
    parser.add_argument('--deadline-minutes', type=float, default=75, help='bound for the whole gate (0 < minutes <= 180)')
    parser.add_argument('--keep-work', action='store_true', help='keep the component root and database copy')
    args = parser.parse_args(argv)
    if not 0 < args.deadline_minutes <= 180:
        parser.error('--deadline-minutes must be in (0, 180]')
    return args


def interrupted(signum, _frame):
    if not interrupted.raised:  # later signals (e.g. SIGTERM after SIGINT) let cleanup and failure.json finish
        interrupted.raised = True
        raise GateError(f'interrupted by signal {signum}')


interrupted.raised = False


def main(argv=None):
    args = parse(argv)
    # A cancelled CI step (SIGINT, then SIGTERM) still records failure.json and removes this run's probes.
    signal.signal(signal.SIGINT, interrupted)
    signal.signal(signal.SIGTERM, interrupted)
    out = Path(args.out)
    if out.exists() or out.is_symlink():
        print(f'debian-origin-gate: {out} already exists; each run needs a new output directory', file=sys.stderr)
        return 1
    if not out.absolute().parent.is_dir():
        print(f'debian-origin-gate: {out.absolute().parent} does not exist', file=sys.stderr)
        return 1
    return Gate(args).execute()


if __name__ == '__main__':
    sys.exit(main())
