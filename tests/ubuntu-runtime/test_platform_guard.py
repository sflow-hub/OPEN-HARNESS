"""Wrong-architecture handling: the native platform guard, the lock loader and ELF architecture checks."""
import os
import stat
import struct
import tempfile
import unittest
from pathlib import Path

import support
from support import ohpkg

import elf_arch


def fake_tools(directory, dpkg_arch, machine):
    for name, output in (('dpkg', dpkg_arch), ('uname', machine)):
        path = Path(directory) / name
        path.write_text(f'#!/bin/sh\necho {output}\n')
        path.chmod(path.stat().st_mode | stat.S_IXUSR)


class NativePlatformGuard(unittest.TestCase):
    def guard(self, target, build, dpkg_arch, machine, mode=None):
        with tempfile.TemporaryDirectory() as tools:
            fake_tools(tools, dpkg_arch, machine)
            env = {'PATH': f'{tools}:/usr/bin:/bin', 'TARGETARCH': target, 'BUILDARCH': build}
            if mode is not None:
                env['OPEN_HARNESS_BUILD_MODE'] = mode
            return support.run_helper('check-native-platform.sh', env=env)

    def test_native_arm64_and_amd64_pass(self):
        for target, machine in (('arm64', 'aarch64'), ('amd64', 'x86_64')):
            result = self.guard(target, target, target, machine)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn(f'native {target}', result.stdout)

    def test_unsupported_target_architectures_fail(self):
        for target in ('riscv64', 'arm', 's390x', ''):
            result = self.guard(target, target, target, 'riscv64')
            self.assertEqual(result.returncode, 1)
            self.assertIn('unsupported TARGETARCH', result.stderr)

    def test_emulated_or_cross_build_fails(self):
        result = self.guard('amd64', 'arm64', 'amd64', 'x86_64')
        self.assertEqual(result.returncode, 1)
        self.assertIn('refusing cross or emulated build', result.stderr)

    def test_explicit_arm64_to_amd64_emulation_passes(self):
        result = self.guard('amd64', 'arm64', 'amd64', 'x86_64', 'emulated')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('emulated amd64 (builder arm64)', result.stdout)

    def test_emulation_still_requires_matching_target_packages_and_machine(self):
        for target, build, package, machine in (
            ('amd64', 'amd64', 'amd64', 'x86_64'),
            ('arm64', 'amd64', 'arm64', 'aarch64'),
            ('amd64', 'arm64', 'arm64', 'x86_64'),
            ('amd64', 'arm64', 'amd64', 'aarch64'),
        ):
            result = self.guard(target, build, package, machine, 'emulated')
            self.assertEqual(result.returncode, 1, result.stdout)

    def test_unknown_build_mode_fails(self):
        result = self.guard('amd64', 'amd64', 'amd64', 'x86_64', 'cross')
        self.assertEqual(result.returncode, 1)
        self.assertIn('unsupported OPEN_HARNESS_BUILD_MODE', result.stderr)

    def test_wrong_base_image_architecture_fails(self):
        result = self.guard('arm64', 'arm64', 'amd64', 'aarch64')
        self.assertEqual(result.returncode, 1)
        self.assertIn("base image architecture 'amd64' is not 'arm64'", result.stderr)

    def test_wrong_kernel_machine_fails(self):
        result = self.guard('arm64', 'arm64', 'arm64', 'x86_64')
        self.assertEqual(result.returncode, 1)
        self.assertIn("kernel machine 'x86_64' is not 'arm64'", result.stderr)


class LockArchitecture(unittest.TestCase):
    def test_only_arm64_and_amd64_are_accepted(self):
        for arch in ('arm64', 'amd64'):
            ohpkg.load_lock(support.LOCK, arch)
        for arch in ('riscv64', 'armhf', 'i386', 'x86_64', 'aarch64', ''):
            with self.assertRaisesRegex(ohpkg.InputError, 'unsupported architecture'):
                ohpkg.load_lock(support.LOCK, arch)

    def test_helper_cli_rejects_unsupported_architecture(self):
        result = support.run_helper('debian_inputs.py', 'plan', '--lock', str(support.LOCK), '--arch', 'riscv64')
        self.assertEqual(result.returncode, 1)
        self.assertIn('unsupported architecture', result.stderr)


def elf_header(machine, elf_class=2, data=1):
    header = bytearray(64)
    header[:4] = b'\x7fELF'
    header[4], header[5], header[6] = elf_class, data, 1
    struct.pack_into('<H', header, 18, machine)
    return bytes(header)


class ElfArchitecture(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())

    def write(self, name, data):
        path = self.dir / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def test_machines(self):
        self.assertEqual(elf_arch.elf_arch(self.write('a', elf_header(183))), 'arm64')
        self.assertEqual(elf_arch.elf_arch(self.write('b', elf_header(62))), 'amd64')
        for name, data, message in (('riscv', elf_header(243), 'unsupported ELF machine 243'),
                                    ('elf32', elf_header(40, elf_class=1), 'not a 64-bit little-endian'),
                                    ('big', elf_header(183, data=2), 'not a 64-bit little-endian'),
                                    ('text', b'#!/bin/sh\n' + b' ' * 30, 'not an ELF file')):
            with self.assertRaisesRegex(ohpkg.InputError, message):
                elf_arch.elf_arch(self.write(name, data))

    def test_wrong_architecture_binary_in_image_fails(self):
        amd64 = self.write('usr/bin/tool', elf_header(62))
        with self.assertRaisesRegex(ohpkg.InputError, 'amd64 binary in an arm64 image'):
            elf_arch.check('arm64', [str(amd64)])

    def test_directories_check_every_elf_file_and_must_contain_one(self):
        lib = self.dir / 'lib'
        self.write('lib/ok.so', elf_header(183))
        self.write('lib/data.pak', b'not elf')
        self.assertEqual(len(elf_arch.check('arm64', [str(lib)])), 1)
        self.write('lib/sub/stray.so', elf_header(62))
        with self.assertRaisesRegex(ohpkg.InputError, 'amd64 binary in an arm64 image'):
            elf_arch.check('arm64', [str(lib)])
        (self.dir / 'empty').mkdir()
        with self.assertRaisesRegex(ohpkg.InputError, 'no ELF files'):
            elf_arch.check('arm64', [str(self.dir / 'empty')])

    def test_linkage(self):
        path = self.write('bin', elf_header(183))

        def ldd(stdout, returncode=0):
            return lambda *a, **k: type('R', (), {'stdout': stdout, 'stderr': '', 'returncode': returncode})()

        self.assertEqual(elf_arch.linkage(path, ldd('\tlibc.so.6 => /lib/libc.so.6 (0x1)\n')), 'resolved')
        self.assertEqual(elf_arch.linkage(path, ldd('\tstatically linked\n')), 'static')
        self.assertEqual(elf_arch.linkage(path, ldd('\tnot a dynamic executable\n', 1)), 'static')
        with self.assertRaisesRegex(ohpkg.InputError, 'unresolved libraries'):
            elf_arch.linkage(path, ldd('\tlibgtk-3.so.0 => not found\n'))
        with self.assertRaisesRegex(ohpkg.InputError, 'ldd failed'):
            elf_arch.linkage(path, ldd('error\n', 1))

    @unittest.skipUnless(os.uname().machine in ('x86_64', 'aarch64'), 'host architecture not covered')
    def test_host_python_binary_matches_host(self):
        host = {'x86_64': 'amd64', 'aarch64': 'arm64'}[os.uname().machine]
        other = {'amd64': 'arm64', 'arm64': 'amd64'}[host]
        binary = os.path.realpath(support.sys.executable)
        self.assertEqual(elf_arch.check(host, [binary], with_linkage=True)[binary]['linkage'], 'resolved')
        result = support.run_helper('elf_arch.py', '--expect', other, binary)
        self.assertEqual(result.returncode, 1)
        self.assertIn(f'{host} binary in an {other} image', result.stderr)


if __name__ == '__main__':
    unittest.main()
