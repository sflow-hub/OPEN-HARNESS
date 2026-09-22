import { resolve } from 'node:path';

export type StateDirReason = 'explicit' | 'existing' | 'project' | 'home';
export type StateDirChoice = { path: string; reason: StateDirReason };

// Where Open Harness keeps state.db, secrets and agent profiles. Precedence: an explicit
// OPEN_HARNESS_STATE_DIR always wins; a project folder that already holds state is never
// abandoned; otherwise the project default, unless Docker cannot read it -- Docker Desktop
// only bind-mounts folders on its file-sharing list, and a checkout on another drive mounts
// as an empty directory -- in which case a folder under the home directory, which Docker
// Desktop shares by default.
export function chooseStateDir(input: { explicit?: string; projectDefault: string; homeDefault: string; hasState: (path: string) => boolean; dockerCanRead: (path: string) => boolean }): StateDirChoice {
  if (input.explicit) return { path: resolve(input.explicit), reason: 'explicit' };
  const project = resolve(input.projectDefault);
  if (input.hasState(project)) return { path: project, reason: 'existing' };
  if (input.dockerCanRead(project)) return { path: project, reason: 'project' };
  return { path: resolve(input.homeDefault), reason: 'home' };
}

// The env-file content with NAME set to value, or null when the file already sets it to
// something non-empty (the user's choice stands). An empty assignment, as .env.example
// invites, is replaced in place; otherwise the line is appended. Nothing else is touched.
// Double quotes keep paths with spaces intact for Node's --env-file parser.
export function withEnvValue(existing: string, name: string, value: string): string | null {
  const assignment = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
  const lines = existing.split(/\r?\n/);
  const index = lines.findIndex(line => assignment.test(line));
  const line = `${name}="${value}"`;
  if (index === -1) return `${existing}${existing.length && !existing.endsWith('\n') ? '\n' : ''}${line}\n`;
  const current = (lines[index].match(assignment)![1] || '').trim().replace(/^["']|["']$/g, '');
  if (current) return null;
  lines[index] = line;
  return lines.join('\n');
}
