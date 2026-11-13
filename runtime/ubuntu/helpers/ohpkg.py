"""Shared, stdlib-only helpers for the proposed Ubuntu runtime build (Python 3.11+).

Everything here fails closed: an unexpected input raises InputError with a specific message, and the command-line
helpers turn that into exit status 1. Nothing here downloads, installs or runs a package manager.
"""
import fnmatch
import gzip
import hashlib
import io
import json
import lzma
import shutil
import subprocess
import tarfile
from pathlib import Path, PurePosixPath

SUPPORTED_ARCHES = ('arm64', 'amd64')
LOCK_SCHEMA = 'open-harness-ubuntu-runtime-lock/1'


class InputError(Exception):
    """A locked input, package identity or build invariant did not hold."""


def require(condition, message):
    if not condition:
        raise InputError(message)


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for block in iter(lambda: handle.read(1 << 20), b''):
            digest.update(block)
    return digest.hexdigest()


def canonical_json(value):
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + '\n'


def write_json(path, value):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(canonical_json(value), encoding='utf-8')


def load_lock(path, arch=None):
    lock = json.loads(Path(path).read_text(encoding='utf-8'))
    require(lock.get('schema') == LOCK_SCHEMA, f'{path}: unexpected lock schema {lock.get("schema")!r}')
    require(tuple(lock.get('supportedArchitectures', ())) == SUPPORTED_ARCHES, f'{path}: unexpected architectures')
    if arch is not None:
        require(arch in SUPPORTED_ARCHES, f'unsupported architecture {arch!r}; supported: {", ".join(SUPPORTED_ARCHES)}')
    return lock


def full_version(epoch, version, release=None):
    text = f'{version}-{release}' if release else version
    return f'{epoch}:{text}' if epoch not in (None, '', 0, '0') else text


# ---- deb822 (control files, dpkg status, apt-cache output) ----------------------------------------------------

def parse_deb822(text):
    """Paragraphs of 'Field: value' with continuation lines; field names keep their case."""
    paragraphs, current, last = [], {}, None
    for line in text.splitlines():
        if not line.strip():
            if current:
                paragraphs.append(current)
            current, last = {}, None
            continue
        if line[0] in ' \t':
            require(last is not None, f'continuation line without a field: {line!r}')
            current[last] += '\n' + line.strip()
            continue
        name, sep, value = line.partition(':')
        require(sep == ':' and name and ' ' not in name, f'malformed deb822 line: {line!r}')
        require(name not in current, f'duplicate field {name!r}')
        current[name], last = value.strip(), name
    if current:
        paragraphs.append(current)
    return paragraphs


def source_identity(control):
    """(source name, source version) for a binary control paragraph."""
    source = control.get('Source', control['Package'])
    name, _, rest = source.partition(' ')
    version = rest.strip()[1:-1] if rest.strip().startswith('(') else control['Version']
    return name, version


def dpkg_status(path):
    """Installed packages from a dpkg status file: {name: paragraph}.

    Fully installed packages count whatever their selection (install, hold, deinstall); removed packages
    (not-installed, config-files) are skipped. Any half-installed, unpacked or trigger state, or a
    reinstall-required flag, is an error: scanners would still report such a package.
    """
    installed = {}
    for paragraph in parse_deb822(Path(path).read_text(encoding='utf-8')):
        name = paragraph.get('Package')
        status = paragraph.get('Status', '').split()
        require(name and len(status) == 3, f'malformed dpkg status entry {name!r}: {paragraph.get("Status")!r}')
        if status[2] in ('not-installed', 'config-files'):
            continue
        require(status[1:] == ['ok', 'installed'], f'package {name} is in dpkg state {" ".join(status)!r}, not fully installed')
        require(name not in installed, f'package {name} is installed twice (multi-arch is not expected here)')
        installed[name] = paragraph
    return installed


def dpkg_path_rules(config_dir):
    """Ordered (include, pattern) rules from dpkg.cfg.d; dpkg applies the last matching rule."""
    rules = []
    directory = Path(config_dir)
    if not directory.is_dir():
        return rules
    for config in sorted(p for p in directory.iterdir() if p.is_file()):
        for line in config.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            for key, include in (('path-exclude', False), ('path-include', True)):
                if line.startswith(key + '=') or line.startswith(key + ' '):
                    rules.append((include, line[len(key) + 1:].strip()))
    return rules


def path_installed_by_policy(path, rules):
    included = True
    for include, pattern in rules:
        if fnmatch.fnmatchcase(path, pattern):
            included = include
    return included


# ---- .deb archives ----------------------------------------------------------------------------------------------

def link_stays_inside(path, target):
    """True for a relative symlink whose target cannot climb above the filesystem root it is unpacked into."""
    if PurePosixPath(target).is_absolute():
        return False
    depth = len(PurePosixPath(path).parent.parts) - 1
    for part in PurePosixPath(target).parts:
        if part == '..':
            depth -= 1
            if depth < 0:
                return False
        elif part != '.':
            depth += 1
    return True


def _ar_members(blob, label):
    require(blob[:8] == b'!<arch>\n', f'{label}: not an ar archive')
    members, offset = [], 8
    while offset < len(blob):
        header = blob[offset:offset + 60]
        require(len(header) == 60 and header[58:60] == b'`\n', f'{label}: corrupt ar header')
        name = header[:16].decode('ascii').strip().rstrip('/')
        size = int(header[48:58].decode('ascii').strip())
        start = offset + 60
        data = blob[start:start + size]
        require(len(data) == size, f'{label}: truncated member {name}')
        members.append((name, data))
        offset = start + size + (size % 2)
    return members


def _open_member_tar(name, data, deb_path):
    if name.endswith('.xz'):
        raw = lzma.decompress(data)
    elif name.endswith('.gz'):
        raw = gzip.decompress(data)
    elif name.endswith('.tar'):
        raw = data
    elif name.endswith('.zst'):
        return None  # needs dpkg-deb; see Deb.control/Deb.data
    else:
        raise InputError(f'{deb_path}: unsupported member compression {name}')
    return tarfile.open(fileobj=io.BytesIO(raw), mode='r:')


class Deb:
    """Read-only view of a .deb: control fields and data members, without executing maintainer scripts."""

    def __init__(self, path):
        self.path = Path(path)
        blob = self.path.read_bytes()
        members = _ar_members(blob, self.path)
        require(members and members[0][0] == 'debian-binary' and members[0][1].startswith(b'2.'),
                f'{self.path}: not a Debian binary package')
        self.members = dict(members)
        self.control_name = next((n for n in self.members if n.startswith('control.tar')), None)
        self.data_name = next((n for n in self.members if n.startswith('data.tar')), None)
        require(self.control_name and self.data_name, f'{self.path}: missing control or data member')
        self._control = None

    def _dpkg_deb(self, *args):
        tool = shutil.which('dpkg-deb')
        require(tool, f'{self.path}: zstd members need dpkg-deb, which is not available')
        return subprocess.run([tool, *args, str(self.path)], check=True, capture_output=True).stdout

    @property
    def control_text(self):
        tar = _open_member_tar(self.control_name, self.members[self.control_name], self.path)
        if tar is None:
            return self._dpkg_deb('--field').decode('utf-8')
        with tar:
            member = next((m for m in tar.getmembers() if m.name in ('./control', 'control')), None)
            require(member is not None and member.isfile(), f'{self.path}: no control file')
            return tar.extractfile(member).read().decode('utf-8')

    @property
    def control(self):
        if self._control is None:
            paragraphs = parse_deb822(self.control_text)
            require(len(paragraphs) == 1, f'{self.path}: control must have one paragraph')
            self._control = paragraphs[0]
        return self._control

    def data_tar(self):
        tar = _open_member_tar(self.data_name, self.members[self.data_name], self.path)
        if tar is None:
            tar = tarfile.open(fileobj=io.BytesIO(self._dpkg_deb('--fsys-tarfile')), mode='r:')
        return tar

    def entries(self):
        """Absolute paths of data members: {'files': {path: sha256}, 'links': {path: target}, 'dirs': set, 'all': [...]}."""
        files, links, dirs, order = {}, {}, set(), []
        with self.data_tar() as tar:
            for member in tar:
                relative = PurePosixPath(member.name.removeprefix('./'))
                if member.name in ('.', './'):
                    continue
                require(not relative.is_absolute() and '..' not in relative.parts, f'{self.path}: unsafe path {member.name}')
                require(not member.mode & 0o6000, f'{self.path}: setuid/setgid member {member.name} is not expected')
                path = '/' + relative.as_posix()
                order.append(path)
                if member.isdir():
                    dirs.add(path)
                elif member.isfile():
                    files[path] = sha256_bytes(tar.extractfile(member).read())
                elif member.issym():
                    require(link_stays_inside(path, member.linkname),
                            f'{self.path}: link {member.name} -> {member.linkname} is absolute or leaves the root')
                    links[path] = member.linkname
                else:
                    raise InputError(f'{self.path}: unsupported member type for {member.name}')
        return {'files': files, 'links': links, 'dirs': dirs, 'all': order}

    def extract_to(self, root):
        """Materialize files, directories and links under root without following links out of it."""
        root = Path(root).resolve()
        written = []
        with self.data_tar() as tar:
            for member in tar:
                if member.name in ('.', './'):
                    continue
                relative = PurePosixPath(member.name.removeprefix('./'))
                require(not relative.is_absolute() and '..' not in relative.parts, f'{self.path}: unsafe path {member.name}')
                require(not member.mode & 0o6000, f'{self.path}: setuid/setgid member {member.name} is not expected')
                target = root / relative
                require(target.parent.resolve().is_relative_to(root), f'{self.path}: {member.name} escapes the root')
                require(not target.is_symlink(), f'{self.path}: {member.name} would replace an existing link')
                if member.isdir():
                    target.mkdir(parents=True, exist_ok=True)
                    continue
                require(not target.exists(), f'{self.path}: {member.name} already exists (package file conflict)')
                target.parent.mkdir(parents=True, exist_ok=True)
                if member.isfile():
                    target.write_bytes(tar.extractfile(member).read())
                    target.chmod(member.mode & 0o777)
                elif member.issym():
                    require(link_stays_inside('/' + relative.as_posix(), member.linkname),
                            f'{self.path}: link {member.name} -> {member.linkname} leaves the root')
                    target.symlink_to(member.linkname)
                else:
                    raise InputError(f'{self.path}: unsupported member type for {member.name}')
                written.append('/' + relative.as_posix())
        return written


def resolve_in_root(root, path, follow_final=True, limit=40):
    """Host path for an absolute in-image path, following links only inside root (an extracted image or '/')."""
    root = Path(root)
    queue = list(PurePosixPath(path).parts[1:])
    current, hops = PurePosixPath('/'), 0
    while queue:
        part = queue.pop(0)
        if part in ('', '.'):
            continue
        if part == '..':
            current = current.parent
            continue
        candidate = current / part
        host = root / candidate.relative_to('/')
        if host.is_symlink() and (queue or follow_final):
            hops += 1
            require(hops <= limit, f'{path}: too many symbolic links')
            target = PurePosixPath(host.readlink().as_posix())
            if target.is_absolute():
                current, queue = PurePosixPath('/'), list(target.parts[1:]) + queue
            else:
                queue = list(target.parts) + queue
            continue
        current = candidate
    return root / current.relative_to('/')


def deb_identity(deb):
    control = deb.control
    source_name, source_version = source_identity(control)
    return {'Package': control['Package'], 'Version': control['Version'], 'Architecture': control['Architecture'],
            'SourceName': source_name, 'SourceVersion': source_version}
