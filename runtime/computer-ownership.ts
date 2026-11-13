import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile } from '../lib/agent-profile';
import { desktopResourceKey } from './computer-runtime';
import { atomicWorkspaceWrite, safeWorkspacePath } from './path-safety';
import { ProfileError } from './profiles';

export type ComputerOwnership = { generation: number; owner: 'agent' | 'human' | 'idle'; identity: string };
export function validComputerOwnership(value: unknown): value is ComputerOwnership {
  if (!value || typeof value !== 'object') return false;
  const item = value as ComputerOwnership;
  return Number.isSafeInteger(item.generation) && item.generation > 0 && ['agent','human','idle'].includes(item.owner) && typeof item.identity === 'string' && item.identity.length > 0 && item.identity.length <= 200;
}
function ownershipPath(root: string, profile: AgentProfile) {
  const directory = safeWorkspacePath(root, 'computer-ownership'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${desktopResourceKey(profile.id, root, profile.computer)}.json`);
}
export function readComputerOwnership(root: string, profile: AgentProfile): ComputerOwnership | null {
  const path = ownershipPath(root, profile); if (!existsSync(path)) return null;
  let value: unknown; try { value = JSON.parse(readFileSync(path, 'utf8')); } catch { throw new ProfileError('Computer ownership could not be read. Control remains blocked.', 409); }
  if (!validComputerOwnership(value)) throw new ProfileError('Computer ownership is invalid. Control remains blocked.', 409);
  return value;
}
export function claimComputerOwnership(root: string, profile: AgentProfile, value: ComputerOwnership) {
  if (!validComputerOwnership(value)) throw new ProfileError('Invalid computer ownership.', 409);
  const current = readComputerOwnership(root, profile);
  if (current && (value.generation < current.generation || value.generation === current.generation && (value.owner !== current.owner || value.identity !== current.identity))) throw new ProfileError('This computer request belongs to an earlier controller.', 409);
  atomicWorkspaceWrite(ownershipPath(root, profile), JSON.stringify(value));
}
export function assertComputerOwnership(root: string, profile: AgentProfile, value: ComputerOwnership) {
  const current = readComputerOwnership(root, profile);
  if (!validComputerOwnership(value) || !current || current.generation !== value.generation || current.owner !== value.owner || current.identity !== value.identity) throw new ProfileError('Computer control changed. Reconnect before sending input.', 409);
}
