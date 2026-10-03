#!/usr/bin/env python3
"""Fail unless the installed dpkg package set is exactly the locked set for this architecture.

Usage: check_packages.py --lock L --arch A [--status /var/lib/dpkg/status] [--os-packages FILE] [--report OUT]

Every installed package must be locked with the same version and architecture, and every locked package must be
installed: a missing, extra, re-versioned or other-architecture package is an error. --os-packages also checks that
the OS package list the image was built from is the one the lock records. --report writes the comparison as JSON.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import ohpkg  # noqa: E402
from ohpkg import require  # noqa: E402


def compare(expected, installed):
    actual = {name: [p['Version'], p['Architecture']] for name, p in installed.items()}
    return {
        'missing': sorted(set(expected) - set(actual)),
        'unexpected': {name: actual[name] for name in sorted(set(actual) - set(expected))},
        'different': {name: {'locked': expected[name], 'installed': actual[name]}
                      for name in sorted(set(expected) & set(actual)) if expected[name] != actual[name]},
        'installed': len(actual),
        'locked': len(expected),
    }


def check(lock, arch, status, os_packages=None):
    if os_packages is not None:
        digest = ohpkg.sha256_file(os_packages)
        require(digest == lock['ubuntu']['osPackagesSha256'], f'{os_packages}: SHA256 {digest} is not the locked OS list')
    expected = lock['finalPackages'].get(arch)
    require(expected, f'no final package set for {arch}')
    return compare(expected, ohpkg.dpkg_status(status))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    parser.add_argument('--lock', required=True)
    parser.add_argument('--arch', required=True)
    parser.add_argument('--status', default='/var/lib/dpkg/status')
    parser.add_argument('--os-packages')
    parser.add_argument('--report')
    args = parser.parse_args(argv)
    lock = ohpkg.load_lock(args.lock, args.arch)
    result = check(lock, args.arch, args.status, args.os_packages)
    result['architecture'] = args.arch
    result['lockSha256'] = ohpkg.sha256_file(args.lock)
    result['validation'] = lock['validation'][args.arch]
    if args.report:
        ohpkg.write_json(args.report, result)
    problems = {k: result[k] for k in ('missing', 'unexpected', 'different') if result[k]}
    require(not problems, f'installed packages differ from the {args.arch} lock: {problems}')


if __name__ == '__main__':
    try:
        main()
    except (ohpkg.InputError, OSError, KeyError, ValueError) as error:
        print(f'check_packages: {error}', file=sys.stderr)
        sys.exit(1)
