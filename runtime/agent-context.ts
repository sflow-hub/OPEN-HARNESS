import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { profileMemory } from './profile-memory';
import { safeWorkspacePath } from './path-safety';
import { ProfileError, validId } from './profiles';

export type ContextOperation = { operation: 'get' | 'set-memory' | 'get-skill' | 'put-skill' | 'delete-skill'; memory?: string; name?: string; content?: string };
export type ContextResult = { status: number; value: Record<string, unknown> };

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' }); renameSync(temporary, path); }
  finally { rmSync(temporary, { force: true }); }
}

// The coordinator and remote runner use the same managed paths and validation.
// Callers serialize these operations against runs and computer transfers.
export function agentContext(root: string, agentId: string, input: ContextOperation): ContextResult {
  const profile = `agents/${validId(agentId)}/profile`;
  const skills = safeWorkspacePath(root, `${profile}/skills`);
  if (input.operation === 'get' || input.operation === 'set-memory') {
    const paths = profileMemory(root, agentId);
    if (input.operation === 'set-memory') {
      const memory = String(input.memory || '');
      if (memory.length > 50_000) throw new ProfileError('Memory is limited to 50 KB.', 413);
      write(paths.memory, memory);
      return { status: 200, value: { ok: true } };
    }
    return { status: 200, value: {
      memory: existsSync(paths.memory) ? readFileSync(paths.memory, 'utf8') : '',
      user: existsSync(paths.user) ? readFileSync(paths.user, 'utf8') : '',
      skills: existsSync(skills) ? readdirSync(skills, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).slice(0, 200) : [],
    } };
  }
  if (!['get-skill', 'put-skill', 'delete-skill'].includes(input.operation)) throw new ProfileError('Invalid context operation.');
  const name = String(input.name || '');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) throw new ProfileError('Invalid skill name.');
  const directory = safeWorkspacePath(root, `${profile}/skills/${name}`);
  const file = safeWorkspacePath(root, `${profile}/skills/${name}/SKILL.md`);
  if (input.operation === 'get-skill') return existsSync(file)
    ? { status: 200, value: { name, content: readFileSync(file, 'utf8') } }
    : { status: 404, value: { error: 'Skill not found.' } };
  if (input.operation === 'put-skill') write(file, String(input.content || ''));
  else if (existsSync(directory)) rmSync(directory, { recursive: true });
  return { status: 200, value: { ok: true } };
}
