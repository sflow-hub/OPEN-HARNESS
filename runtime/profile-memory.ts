import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { safeWorkspacePath } from './path-safety';
import { validId } from './profiles';

// Hermes loads these files from HERMES_HOME/memories at each session start.
// Older dashboards saved them one directory higher. Adopt legacy notes only
// when Hermes has no file, including preserving an intentionally empty file.
export function profileMemory(root: string, agentId: string) {
  const profile = `agents/${validId(agentId)}/profile`;
  const directory = safeWorkspacePath(root, `${profile}/memories`);
  mkdirSync(directory, { recursive: true });
  const paths = { memory: '', user: '' };
  for (const [key, file] of [['memory', 'MEMORY.md'], ['user', 'USER.md']] as const) {
    const target = safeWorkspacePath(root, `${profile}/memories/${file}`);
    const legacy = safeWorkspacePath(root, `${profile}/${file}`);
    if (!existsSync(target) && existsSync(legacy)) {
      try { writeFileSync(target, readFileSync(legacy), { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    // Keep the original as a backup; it must never overwrite newer runtime notes.
    paths[key] = target;
  }
  return paths;
}
