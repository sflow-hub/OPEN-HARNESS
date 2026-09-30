"""Static policy checks of the proposed Dockerfile against the lock, root's tested steps and the production tail."""
import io
import re
import tarfile
import unittest

import support

BEGIN = '# ---- BEGIN unchanged production installation tail (runtime/hermes/Dockerfile) ----\n'
END = '# ---- END unchanged production installation tail ----\n'


def instructions(text):
    """(stage, keyword, arguments) for every instruction, with continuation lines joined."""
    joined, current = [], ''
    for line in text.splitlines():
        if not current and (not line.strip() or line.lstrip().startswith('#')):
            continue
        if line.endswith('\\'):
            current += line[:-1] + ' '
            continue
        joined.append(current + line)
        current = ''
    stage, result = None, []
    for line in joined:
        keyword, _, rest = line.strip().partition(' ')
        if keyword.upper() == 'FROM':
            match = re.search(r'\bAS\s+(\S+)$', rest, re.I)
            stage = match.group(1) if match else None
        result.append((stage, keyword.upper(), rest.strip()))
    return result


class DockerfilePolicy(unittest.TestCase):
    def setUp(self):
        self.text = support.DOCKERFILE.read_text(encoding='utf-8')
        self.lock = support.load_lock()
        self.steps = instructions(self.text)

    def stage(self, name):
        return [(k, a) for s, k, a in self.steps if s == name]

    def runs(self, name):
        return [a for k, a in self.stage(name) if k == 'RUN']

    def test_bases_are_the_locked_per_architecture_manifests(self):
        froms = [a for _, k, a in self.steps if k == 'FROM']
        pinned = {}
        for line in froms:
            match = re.fullmatch(r'docker\.io/library/(\w+)(?::[\w.-]+)?@(sha256:[0-9a-f]{64}) AS oh-(\w+)-(arm64|amd64)', line)
            if match:
                pinned[(match.group(3), match.group(4))] = match.group(2)
                self.assertEqual(match.group(1), match.group(3))
            else:
                self.assertRegex(line, r'^(oh-(ubuntu|python|node)-\$\{TARGETARCH\}|oh-ubuntu|oh-python|runtime) AS [\w-]+$')
        expected = {(image, arch): digest for image, data in self.lock['images'].items()
                    for arch, digest in data['manifests'].items()}
        self.assertEqual(pinned, expected)
        self.assertEqual(self.text.count('${TARGETARCH} AS '), 3)

    def test_hermes_providers_policy_and_contract(self):
        runtime = '\n'.join(a for _, a in self.stage('runtime'))
        self.assertIn("('provider.vertex', 'provider.bedrock', 'provider.anthropic')", runtime)
        self.assertIn("-e '.[all,bedrock,anthropic]'", runtime)
        contract = re.search(r'export const RUNTIME_CONTRACT = (\d+);',
                             (support.REPO / 'runtime/readiness.ts').read_text()).group(1)
        self.assertEqual(runtime.count('OPEN_HARNESS_RUNTIME=' + contract), 1)
        self.assertIn('HERMES_COMMIT=939e45c91d751fadd94dcd1b873ac3cb44846213', runtime)
        self.assertIn('/opt/open-harness/extension', runtime)
        self.assertIn('CUA_DRIVER_VERSION=0.28.2', runtime)
        self.assertIn(('USER', 'hermes'), self.stage('runtime'))

    @support.needs(support.PRODUCTION_DOCKERFILE)
    def test_tail_preserves_reviewed_candidate(self):
        candidate = support.PRODUCTION_DOCKERFILE.read_text()
        tail = candidate[candidate.index(BEGIN) + len(BEGIN):candidate.index(END)]
        tail = tail.replace('ARG OPEN_HARNESS_RUNTIME=6', 'ARG OPEN_HARNESS_RUNTIME=7')
        start = self.text.index('COPY runtime/hermes/security-constraints.txt')
        self.assertEqual(self.text[start:start + len(tail)], tail)

    def test_tested_python_node_and_nss_steps_are_reused(self):
        self.assertIn('COPY --from=oh-python /usr/local/ /usr/local/\n'
                      'ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 PYTHON_VERSION=3.12.14\n'
                      'RUN ldconfig && python --version && python -m pip check\n', self.text)
        self.assertIn('COPY --from=oh-node /usr/local/LICENSE /opt/open-harness/node/LICENSE\n', self.text)
        self.assertIn(' && npm install -g --registry=https://registry.npmjs.org npm@11.20.0 \\\n'
                      ' && test "$(node --version)" = v24.21.0 && test "$(npm --version)" = 11.20.0 \\\n', self.text)
        self.assertIn('RUN ln -s "$(dpkg-query -L libnss-wrapper | grep \'/libnss_wrapper.so$\')" '
                      '/usr/local/lib/open-harness-nss-wrapper.so\n', self.text)

    @support.needs(support.PYTHON / 'evidence.tar.gz')
    def test_python_step_equals_roots_tested_python_candidate(self):
        data = support.PYTHON.joinpath('evidence.tar.gz').read_bytes()
        self.assertEqual(support.sha256(data), support.read_json(support.PYTHON / 'receipt.json')['sha256'])
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            tested = tar.extractfile('Dockerfile').read().decode().splitlines()[2:]
        self.assertEqual([line.replace('python-runtime', 'oh-python') for line in tested],
                         ['COPY --from=oh-python /usr/local/ /usr/local/',
                          'ENV PATH=/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin LANG=C.UTF-8 PYTHON_VERSION=3.12.14',
                          'RUN ldconfig && python --version && python -m pip check'])

    def test_embedded_input_hashes_match_the_lock_files(self):
        run = self.runs('build-inputs')[0]
        self.assertIn(f'{support.sha256(support.LOCK.read_bytes())} runtime-inputs.lock.json', run)
        self.assertIn(f'{self.lock["ubuntu"]["osPackagesSha256"]} ubuntu-os-packages.txt', run)
        self.assertIn('sha256sum --check --strict -', run)

    def test_pins_equal_the_lock(self):
        curl = self.lock['curl']
        builder = self.runs('curl-builder')[0]
        self.assertIn(f'build-dep curl={curl["source"]["version"]} ', builder)
        self.assertIn(f'source --download-only curl={curl["source"]["version"]} ', builder)
        self.assertIn('install ' + ' '.join(curl['buildDependencies']) + ' ', builder)
        install = self.runs('runtime')[1]
        self.assertIn('apt-get install -y --no-install-recommends ' + ' '.join(self.lock['ubuntu']['curlRuntimeDependencies']), install)
        self.assertIn('cp -R /mnt/curl-http3/debs /opt/open-harness/curl/packages', install)
        files = re.findall(r'dpkg -i ((?:/opt/open-harness/curl/packages/\S+\s+)+)', install)[0].split()
        files = [f.removeprefix('/opt/open-harness/curl/packages/') for f in files]
        version = curl['rebuild']['version']
        self.assertEqual(files, [f'{name}_{version}_${{TARGETARCH}}.deb' for name in curl['rebuild']['runtimePackages']])
        self.assertNotIn('*.deb', install)

    def test_ubuntu_apt_uses_the_locked_snapshot_before_anything_else(self):
        call = ('sh /opt/open-harness-build/helpers/ubuntu-snapshot.sh '
                f'{self.lock["ubuntu"]["snapshot"]} /opt/open-harness-build/lock/ubuntu-os-packages.txt')
        self.assertEqual(self.text.count('sh /opt/open-harness-build/helpers/ubuntu-snapshot.sh '), 2)
        for stage in ('curl-builder', 'runtime'):
            first = self.runs(stage)[0]
            self.assertLess(first.index('check-native-platform.sh'), first.index(call), stage)
            self.assertLess(first.index(call), first.index('apt-get'), stage)
        for forbidden in ('APT::Snapshot', 'snapshot.ubuntu.com', 'apt.conf.d', 'CAInfo', 'ca-certificates.crt'):
            self.assertNotIn(forbidden, self.text)

    def test_signed_apt_and_distribution_test_policy_are_preserved(self):
        lowered = self.text.lower()
        for forbidden in ('--allow-unauthenticated', 'trusted=yes', 'allowinsecurerepositories', '--force-yes',
                          'allow-downgrades', 'check-valid-until', 'nocheck', 'deb_build_options', 'deb_build_profiles',
                          '--no-check-certificate', 'curl -k', '--insecure', '[trusted', 'gpgv --ignore'):
            self.assertNotIn(forbidden, lowered)
        self.assertNotIn(' -nc', self.text)

    def test_debian_repositories_stay_out_of_ubuntu_stages(self):
        ubuntu_stages = ('curl-builder', 'runtime', 'verify', 'verified-runtime')
        for name in ubuntu_stages:
            body = ' '.join(a for _, a in self.stage(name))
            for forbidden in ('deb.debian.org', 'security.debian.org', 'snapshot.debian.org', 'debian.sources',
                              'debian-archive-keyring', 'add-apt-repository', 'sources.list.d/debian', '/etc/apt/sources.list '):
                self.assertNotIn(forbidden, body, name)
        self.assertIn('/etc/apt/sources.list.d/debian.sources', self.runs('debian-inputs')[0])
        self.assertIn('debian_inputs.py fetch', self.runs('debian-inputs')[0])
        for _, keyword, argument in self.steps:
            self.assertFalse(keyword in ('COPY', 'ADD') and 'debian-inputs' in argument, 'Debian inputs are only bind-mounted')
        browser = self.runs('runtime')[3]
        self.assertTrue(browser.startswith('--mount=type=bind,from=build-inputs,'))
        self.assertIn('--mount=type=bind,from=debian-inputs,source=/out,target=/mnt/debian-inputs', browser)
        self.assertIn('cp -R /mnt/debian-inputs/packages /opt/open-harness/debian-browser/packages', browser)
        self.assertIn('--packages /opt/open-harness/debian-browser/packages >', browser)

    def test_offline_non_root_curl_build(self):
        steps = self.stage('curl-builder')
        user = [i for i, (k, a) in enumerate(steps) if k == 'USER' and a == 'builder']
        build = [i for i, (k, a) in enumerate(steps) if k == 'RUN' and 'curl_http3.py build' in a]
        self.assertEqual(len(user), 1)
        self.assertEqual(len(build), 1)
        self.assertLess(user[0], build[0])
        self.assertTrue(steps[build[0]][1].startswith('--network=none '))
        self.assertIn('useradd -m -u 10001 -s /bin/bash builder', self.runs('curl-builder')[0])
        self.assertIn('curl_http3.py verify-source', self.runs('curl-builder')[0])

    def test_architecture_arguments_are_declared_where_used(self):
        for stage in {s for s, _, _ in self.steps if s}:
            steps = self.stage(stage)
            declared = {a for k, a in steps if k == 'ARG'}
            body = ' '.join(a for k, a in steps if k == 'RUN')
            for name in ('TARGETARCH', 'BUILDARCH'):
                if name in body or ('check-native-platform.sh' in body and name == 'BUILDARCH'):
                    self.assertIn(name, declared, f'{stage} uses {name}')
            if 'check-native-platform.sh' in body:
                self.assertIn('TARGETARCH', declared)
                self.assertIn('OPEN_HARNESS_BUILD_MODE', declared)

    def test_emulated_build_requires_explicit_mode_and_records_it(self):
        self.assertIn(('ARG', 'OPEN_HARNESS_BUILD_MODE=native'), self.stage(None))
        self.assertIn(('LABEL', 'dev.openharness.build.mode=$OPEN_HARNESS_BUILD_MODE'), self.stage('runtime'))

    def test_every_stage_that_fetches_runs_the_native_platform_guard(self):
        for stage in ('build-inputs', 'debian-inputs', 'curl-builder', 'runtime'):
            self.assertIn('check-native-platform.sh', self.runs(stage)[0], stage)

    def test_verification_is_part_of_the_default_target(self):
        stages = [s for s, k, _ in self.steps if k == 'FROM']
        self.assertEqual(stages[-1], 'verified-runtime')
        self.assertEqual(self.stage('verified-runtime'), [('FROM', 'runtime AS verified-runtime'),
                                                          ('COPY', '--from=verify /out/verification/ /opt/open-harness/verification/')])
        verify = self.runs('verify')[0]
        self.assertTrue(verify.startswith('--network=none '))
        for check in ('check_packages.py', '--os-packages', 'curl_http3.py" check-runtime', 'elf_arch.py" --expect "$TARGETARCH" --linkage',
                      '/usr/lib/chromium', 'lib-dynload', 'debian_origin.py" record', '/mnt/debian-inputs/debian-os/os-release',
                      '--packages /opt/open-harness/debian-browser/packages', '--arch "$TARGETARCH" --version-file'):
            self.assertIn(check, verify)
        self.assertIn(('USER', 'root'), self.stage('verify'))

    def test_helpers_and_build_inputs_are_not_copied_into_the_runtime(self):
        for stage in ('runtime', 'verify', 'verified-runtime'):
            for keyword, argument in self.stage(stage):
                if keyword in ('COPY', 'ADD'):
                    self.assertNotIn('runtime/ubuntu', argument)
                    self.assertNotIn('open-harness-build', argument)
        referenced = set(re.findall(r'helpers/([\w.-]+\.(?:py|sh))', self.text))
        self.assertTrue(referenced)
        for name in referenced:
            self.assertTrue((support.HELPERS / name).is_file(), name)

    def test_no_local_paths_tags_or_process_details(self):
        for forbidden in ('/home/developer', '/Volumes', 'open-harness-verification', 'open-harness-hermes-os:',
                          'ubuntu26-', 'pids-limit', '"pid"', 'mkdtemp', 'Claude outputs'):
            self.assertNotIn(forbidden, self.text)


if __name__ == '__main__':
    unittest.main()
