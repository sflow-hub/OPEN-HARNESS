import { posix } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';

export type SandboxCheck = { ok: boolean | null; detail: string; tampering_suspected?: boolean };
export type SandboxChecks = Record<string, SandboxCheck>;
export type SandboxExpected = { computer: ComputerConfig; teamIds?: string[]; stateRoot: string; agentId: string };
type Inspect = { NetworkSettings?: { Networks?: Record<string, { Internal?: boolean }> }; HostConfig?: { CapDrop?: string[]; CapAdd?: string[]; SecurityOpt?: string[]; Privileged?: boolean; ReadonlyRootfs?: boolean; PidsLimit?: number; Memory?: number; NanoCpus?: number; NetworkMode?: string }; Mounts?: { Source: string; Destination: string; RW: boolean }[] };
export const CONTAINER_CHECKS = ['cap_drop_all', 'no_new_privileges', 'seccomp_not_unconfined', 'not_privileged', 'readonly_rootfs', 'limits', 'no_docker_socket_mount', 'no_host_home_mount', 'mounts_expected', 'network_mode'];

export function attestContainer(inspect: Inspect, expected: SandboxExpected): { checks: SandboxChecks } {
  const h = inspect.HostConfig || {}, mounts = inspect.Mounts || [], options = h.SecurityOpt || [], { computer } = expected;
  const root = posix.normalize(expected.stateRoot), own = `${root}/agents/${expected.agentId}`;
  const allowed = [
    { source: `${own}/managed`, destination: '/run/open-harness', rw: false },
    { source: `${own}/profile`, destination: '/home/hermes/.hermes', rw: true },
    { source: `${own}/private`, destination: '/workspace/private', rw: true },
    { source: `${root}/shared`, destination: '/workspace/shared', rw: true },
    ...(expected.teamIds || []).map(id => ({ source: `${root}/teams/${id}/shared`, destination: `/workspace/teams/${id}`, rw: true })),
  ];
  const managedSources = new Set(allowed.map(m => m.source));
  if (computer.access === 'folders') computer.folders.forEach((folder, index) => allowed.push({ source: posix.normalize(folder.path), destination: `/workspace/mounts/folder-${index + 1}`, rw: folder.mode === 'write' }));
  const matches = (m: NonNullable<Inspect['Mounts']>[number], a: typeof allowed[number]) => posix.normalize(m.Source) === a.source && m.RW === a.rw && m.Destination === a.destination;
  const unexpected = mounts.filter(m => { const source = posix.normalize(m.Source); if ((source === root || root.startsWith(`${source}/`) || source.startsWith(`${root}/`)) && !managedSources.has(source)) return true; return !allowed.some(a => matches(m, a)); });
  const missing = allowed.filter(a => !mounts.some(m => matches(m, a)));
  const networks = Object.values(inspect.NetworkSettings?.Networks || {}), internal = networks.length > 0 && networks.every(n => n.Internal === true);
  const network = h.NetworkMode || 'unknown', mode = computer.network?.mode || 'open';
  const checks: SandboxChecks = {};
  const check = (key: string, ok: boolean | null, detail: string) => { checks[key] = { ok, detail }; };
  check('cap_drop_all', Boolean(h.CapDrop?.some(c => c.toUpperCase() === 'ALL')) && !h.CapAdd?.length, `CapDrop=${JSON.stringify(h.CapDrop || [])}; CapAdd=${JSON.stringify(h.CapAdd || [])}`);
  check('no_new_privileges', options.some(o => /^no-new-privileges(?:(?:=|:)true)?$/.test(o)), `SecurityOpt=${JSON.stringify(options)}`);
  check('seccomp_not_unconfined', !options.some(o => /^seccomp[=:]unconfined$/.test(o)), options.find(o => /^seccomp[=:]/.test(o)) || 'Docker default seccomp profile');
  check('not_privileged', h.Privileged === false, `Privileged=${h.Privileged}`);
  check('readonly_rootfs', h.ReadonlyRootfs === true, h.ReadonlyRootfs ? 'read-only image rootfs' : 'writable image rootfs (hardening pending)');
  check('limits', Number(h.PidsLimit) > 0 && h.Memory === Math.round(computer.resources.memoryMb) * 1024 * 1024 && h.NanoCpus === computer.resources.cpu * 1e9, `PidsLimit=${h.PidsLimit}; Memory=${h.Memory}; NanoCpus=${h.NanoCpus}; expected memory=${computer.resources.memoryMb} MB, cpu=${computer.resources.cpu}`);
  check('no_docker_socket_mount', !mounts.some(m => /(?:^|\/)docker\.sock(?:\/|$)/.test(m.Source) || /(?:^|\/)docker\.sock(?:\/|$)/.test(m.Destination)), 'Mount sources and destinations checked for docker.sock');
  check('no_host_home_mount', !mounts.some(m => { const s = posix.normalize(m.Source); return s === '/' || s === '/root' || s === '/home' || s === '/Users' || /^\/(?:home|Users)\/[^/]+$/.test(s); }), 'Mount sources checked for host root and home directories');
  check('mounts_expected', Array.isArray(inspect.Mounts) && unexpected.length === 0 && missing.length === 0 && mounts.length === allowed.length, unexpected.length ? `Unexpected mounts: ${unexpected.map(m => `${m.Source}:${m.Destination}:${m.RW ? 'rw' : 'ro'}`).join(', ')}` : missing.length ? `Missing mounts: ${missing.map(m => m.destination).join(', ')}` : 'Exact expected mount sources, destinations and write flags');
  // Internal metadata is supplied only from host-side network inspect, never inferred from names.
  check('network_mode', mode === 'open' || network === 'none' || internal ? true : null, `NetworkMode=${network}; profile network.mode=${mode}${mode !== 'open' && network !== 'none' && !internal ? '; not enforced yet' : internal ? '; host-inspected internal network' : ''}`);
  return { checks };
}
