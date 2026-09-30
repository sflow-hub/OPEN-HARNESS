#!/usr/bin/env python3
"""Fail unless native files are 64-bit little-endian ELF for the expected architecture (and, optionally, fully linked).

Usage: elf_arch.py --expect {arm64,amd64} [--linkage] [--report OUT] PATH...
  A file PATH must be ELF (symlinks are followed). A directory PATH is searched recursively and every ELF file in
  it is checked; it must contain at least one. --linkage also requires `ldd` to resolve every shared library.
"""
import argparse
import json
import struct
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ohpkg  # noqa: E402
from ohpkg import require  # noqa: E402

MACHINES = {183: 'arm64', 62: 'amd64'}  # EM_AARCH64, EM_X86_64
STATIC = ('not a dynamic executable', 'statically linked')


def is_elf(path):
    with open(path, 'rb') as handle:
        return handle.read(4) == b'\x7fELF'


def elf_arch(path):
    with open(path, 'rb') as handle:
        header = handle.read(20)
    require(len(header) == 20 and header[:4] == b'\x7fELF', f'{path}: not an ELF file')
    require(header[4] == 2 and header[5] == 1, f'{path}: not a 64-bit little-endian ELF file')
    machine = struct.unpack_from('<H', header, 18)[0]
    require(machine in MACHINES, f'{path}: unsupported ELF machine {machine}')
    return MACHINES[machine]


def targets(paths):
    for value in paths:
        path = Path(value)
        if path.is_dir():
            found = [p for p in sorted(path.rglob('*')) if p.is_file() and not p.is_symlink() and is_elf(p)]
            require(found, f'{path}: no ELF files found')
            yield from found
        else:
            yield path


def linkage(path, run=subprocess.run):
    result = run(['ldd', str(path)], capture_output=True, text=True)
    output = result.stdout + result.stderr
    if any(marker in output for marker in STATIC):
        return 'static'
    require(result.returncode == 0, f'{path}: ldd failed: {output.strip()}')
    missing = [line.strip() for line in output.splitlines() if 'not found' in line]
    require(not missing, f'{path}: unresolved libraries {missing}')
    return 'resolved'


def check(expect, paths, with_linkage=False, run=subprocess.run):
    report = {}
    for path in targets(paths):
        actual = elf_arch(path)
        require(actual == expect, f'{path}: {actual} binary in an {expect} image')
        report[str(path)] = {'architecture': actual}
        if with_linkage:
            report[str(path)]['linkage'] = linkage(path, run)
    return report


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--expect', required=True, choices=ohpkg.SUPPORTED_ARCHES)
    parser.add_argument('--linkage', action='store_true')
    parser.add_argument('--report')
    parser.add_argument('paths', nargs='+')
    args = parser.parse_args(argv)
    report = check(args.expect, args.paths, args.linkage)
    if args.report:
        ohpkg.write_json(args.report, {'architecture': args.expect, 'files': report})
    print(json.dumps({'architecture': args.expect, 'checked': len(report)}))


if __name__ == '__main__':
    try:
        main()
    except (ohpkg.InputError, OSError) as error:
        print(f'elf_arch: {error}', file=sys.stderr)
        sys.exit(1)
