import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { profileMemory } from './profile-memory';
import { safeWorkspacePath } from './path-safety';
import { listInside, mkdirInside, readInside, renameIntoInside, rmrfInside, SafeFsError, statInside } from './safe-fs';
import { ProfileError, validId } from './profiles';

export type ContextOperation = { operation: 'get' | 'set-memory' | 'get-skill' | 'put-skill' | 'delete-skill'; memory?: string; user?: string; revision?: string; name?: string; content?: string };
export type ContextResult = { status: number; value: Record<string, unknown> };

function ensureDirectory(anchor: string, rel: string) {
  let stat = statInside(anchor, rel);
  if (!stat) { try { mkdirInside(anchor, rel); } catch (error) { if (!(error instanceof SafeFsError) || error.code !== 'conflict') throw error; } stat = statInside(anchor, rel); }
  if (stat?.isSymbolicLink) throw new SafeFsError('symlink', 'Workspace paths cannot contain symbolic links.');
  if (!stat?.isDirectory) throw new SafeFsError('invalid-path', 'Workspace parent is not a directory.');
}
function write(root: string, anchor: string, rel: string, content: string) {
  const parts = rel.split('/'); let parent = '';
  for (const part of parts.slice(0, -1)) { parent = parent ? `${parent}/${part}` : part; ensureDirectory(anchor, parent); }
  if (statInside(anchor, rel)?.isSymbolicLink) throw new SafeFsError('symlink', 'Workspace paths cannot contain symbolic links.');
  const staging = mkdtempSync(join(root, '.context-'));
  try { writeFileSync(join(staging, 'value'), content, { mode: 0o600, flag: 'wx' }); renameIntoInside(staging, 'value', anchor, rel); }
  finally { rmSync(staging, { recursive: true, force: true }); }
}
function read(anchor: string, rel: string, maxBytes: number) {
  try { return readInside(anchor, rel, { encoding: 'utf8', maxBytes }) as string; }
  catch (error) { if (error instanceof SafeFsError && error.code === 'not-found') return ''; throw error; }
}

// The coordinator and remote runner use the same managed paths and validation.
// Callers serialize these operations against runs and computer transfers.
export function agentContext(root: string, agentId: string, input: ContextOperation): ContextResult {
  const anchor = safeWorkspacePath(root, `agents/${validId(agentId)}`);
  mkdirSync(anchor, { recursive: true, mode: 0o700 });
  if (input.operation === 'get' || input.operation === 'set-memory') {
    const paths = profileMemory(root, agentId);
    const memoryPath = relative(anchor, paths.memory).replaceAll('\\', '/'), userPath = relative(anchor, paths.user).replaceAll('\\', '/');
    const memory = read(anchor, memoryPath, 200_000), user = read(anchor, userPath, 200_000);
    const revision = createHash('sha256').update(JSON.stringify({memory,user})).digest('hex');
    if (input.operation === 'set-memory') {
      if (input.revision !== undefined && input.revision !== revision) throw new ProfileError(`These notes changed elsewhere (revision ${revision.slice(0,12)}). Your draft is preserved; reload the saved notes before saving again.`,409);
      if(input.user!==undefined && input.revision===undefined)throw new ProfileError('Reload these notes before changing personal preferences.',409);
      const nextMemory = input.memory === undefined ? memory : String(input.memory), nextUser = input.user === undefined ? user : String(input.user);
      if (nextMemory.length > 50_000 || nextUser.length > 50_000) throw new ProfileError('Each memory field is limited to 50 KB.', 413);
      if(input.memory!==undefined)write(root,anchor,memoryPath,nextMemory);
      if(input.user!==undefined)write(root,anchor,userPath,nextUser);
      return { status: 200, value: { ok: true,revision:createHash('sha256').update(JSON.stringify({memory:nextMemory,user:nextUser})).digest('hex') } };
    }
    return { status: 200, value: { memory, user, revision, skills: statInside(anchor, 'profile/skills') ? listInside(anchor, 'profile/skills', { max: 10_000 }).filter(item => item.isDirectory).map(item => item.name).slice(0, 200) : [] } };
  }
  if (!['get-skill', 'put-skill', 'delete-skill'].includes(input.operation)) throw new ProfileError('Invalid context operation.');
  const name = String(input.name || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new ProfileError('Invalid skill name.');
  safeWorkspacePath(root, `agents/${agentId}/profile/skills/${name}`);
  const directory = `profile/skills/${name}`, file = `${directory}/SKILL.md`;
  if (input.operation === 'get-skill') {
    try { return { status: 200, value: { name, content: readInside(anchor, file, { encoding: 'utf8', maxBytes: 1_000_000 }) } }; }
    catch (error) { if (error instanceof SafeFsError && error.code === 'not-found') return { status: 404, value: { error: 'Skill not found.' } }; throw error; }
  }
  if (input.operation === 'put-skill') {
    const content = String(input.content || ''); if (Buffer.byteLength(content) > 1_000_000) throw new ProfileError('Skills are limited to 1 MB.', 413);
    write(root, anchor, file, content);
  } else {
    try { rmrfInside(anchor, directory, { maxEntries: 10_000, maxDepth: 16 }); }
    catch (error) { if (!(error instanceof SafeFsError) || error.code !== 'not-found') throw error; }
  }
  return { status: 200, value: { ok: true } };
}
