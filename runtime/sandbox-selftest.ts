import { spawn } from 'node:child_process';
import { attestContainer, CONTAINER_CHECKS, type SandboxChecks, type SandboxExpected } from './sandbox-attest';

export const PROBE_CHECKS = ['writes_outside_writable_mounts_denied', 'docker_socket_absent', 'host_home_absent', 'no_privilege_escalation', 'cpu_mem_pids_limited'];
export type SandboxResult = { probe: 'sandbox-selftest/v1'; runnerKind: 'container' | 'native'; attestation: 'host-attested' | 'runner-attested' | 'mock'; status: 'green' | 'amber' | 'red'; checks: SandboxChecks; observations?: SandboxChecks };
export function combineSandbox(checks: SandboxChecks, observations: SandboxChecks = {}, attestation: SandboxResult['attestation'] = 'host-attested'): SandboxResult {
  const combined = Object.fromEntries(Object.entries(checks).map(([key, value]) => [key, { ...value }]));
  const corroboration: Record<string, string[]> = { readonly_rootfs: ['writes_outside_writable_mounts_denied'], no_docker_socket_mount: ['docker_socket_absent'], no_host_home_mount: ['host_home_absent'], limits: ['cpu_mem_pids_limited'], no_new_privileges: ['no_privilege_escalation'], cap_drop_all: ['no_privilege_escalation'], seccomp_not_unconfined: ['no_privilege_escalation'] };
  for (const [key, names] of Object.entries(corroboration)) for (const name of names) {
    const fact = combined[key], observation = observations[name];
    // A composite privilege failure contradicts the conjunction, not each fact alone.
    const composite = ['no_privilege_escalation', 'cpu_mem_pids_limited'].includes(name);
    const allPrivilegeFacts = ['no_new_privileges', 'cap_drop_all', 'seccomp_not_unconfined'].every(key => combined[key]?.ok === true);
    const contradictsComposite = !composite || observation?.ok === true || (name === 'no_privilege_escalation' && allPrivilegeFacts) || name === 'cpu_mem_pids_limited';
    if (fact && observation && fact.ok !== null && observation.ok !== null && fact.ok !== observation.ok && contradictsComposite) {
      fact.tampering_suspected = true; fact.detail += `; tampering_suspected: probe ${name} disagrees`;
    }
  }
  const values = Object.values(combined), status = values.some(c => c.ok === false || c.tampering_suspected) ? 'red' : values.some(c => c.ok === null) || Object.values(observations).some(c => c.ok !== true) ? 'amber' : 'green';
  return { probe: 'sandbox-selftest/v1', runnerKind: 'container', attestation, status, checks: combined, observations };
}
export function directSandbox(attestation: SandboxResult['attestation'] = 'host-attested'): SandboxResult {
  return { probe: 'sandbox-selftest/v1', runnerKind: 'native', attestation, status: 'amber', checks: Object.fromEntries([...CONTAINER_CHECKS, ...PROBE_CHECKS].map(key => [key, { ok: null, detail: 'not a sandbox (direct access)' }])) };
}
export function mockSandbox(): SandboxResult {
  return combineSandbox(Object.fromEntries(CONTAINER_CHECKS.map(key => [key, { ok: key !== 'readonly_rootfs', detail: key === 'readonly_rootfs' ? 'writable image rootfs (hardening pending)' : 'Deterministic mock; isolation was not tested' }])), {}, 'mock');
}
export const SANDBOX_EXEC_ARGS = ['env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'python', '-I', '-S', '/opt/open-harness/sandbox_selftest.py'];
export function dockerJson(args: string[], input = '{}\n'): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = []; let size = 0, failure: Error | undefined;
    const timer = setTimeout(() => { failure = new Error('Sandbox check timed out.'); child.kill('SIGKILL'); }, 25_000);
    child.stdout.on('data', (part: Buffer) => { size += part.length; if (size > 1_000_000) { failure = new Error('Sandbox check output exceeded its limit.'); child.kill('SIGKILL'); } else chunks.push(part); });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (failure || code) return reject(failure || new Error('Docker sandbox check failed.')); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('Sandbox check returned invalid JSON.')); } });
    child.stdin.end(input);
  });
}
function probeChecks(value: unknown): SandboxChecks {
  if (!value || typeof value !== 'object' || !('probe' in value) || value.probe !== 'sandbox-selftest/v1' || !('checks' in value) || !value.checks || typeof value.checks !== 'object' || Array.isArray(value.checks)) throw new Error('Invalid sandbox probe response.');
  const checks = value.checks;
  if (!PROBE_CHECKS.every(key => key in checks)) throw new Error('Incomplete sandbox probe response.');
  for (const check of Object.values(value.checks)) if (!check || ![true, false, null].includes(check.ok) || typeof check.detail !== 'string') throw new Error('Invalid sandbox probe check.');
  return value.checks as SandboxChecks;
}
export async function sandboxSelftest(container: string, expected: SandboxExpected, attestation: SandboxResult['attestation'] = 'host-attested', transport = dockerJson): Promise<SandboxResult> {
  const inspected = await transport(['inspect', container]);
  if (!Array.isArray(inspected) || inspected.length !== 1 || !inspected[0]?.HostConfig) throw new Error('Invalid Docker inspect response.');
  const containerInspect = inspected[0];
  if (expected.computer.network?.mode !== 'open' && containerInspect.HostConfig.NetworkMode !== 'none') {
    const networks = containerInspect.NetworkSettings?.Networks || {};
    const names = Object.keys(networks);
    for (const name of names) networks[name].Internal = false;
    if (names.length) {
      try {
        const metadata = await transport(['network', 'inspect', ...names]);
        if (Array.isArray(metadata)) for (const name of names) {
          const network = metadata.find(n => n.Name === name && n.Id === networks[name].NetworkID);
          networks[name].Internal = network?.Internal === true;
        }
      } catch { /* Without host evidence, restrictive networking stays unknown. */ }
    }
  }
  const { checks } = attestContainer(inspected[0], expected);
  let observations: SandboxChecks;
  try { observations = probeChecks(await transport(['exec', '-i', container, ...SANDBOX_EXEC_ARGS])); }
  catch (error) { observations = { probe_available: { ok: null, detail: error instanceof Error ? error.message : 'Probe unavailable; rebuild the Hermes image.' } }; }
  return combineSandbox(checks, observations, attestation);
}
