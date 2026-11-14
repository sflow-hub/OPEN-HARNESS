import { FOLDER_NAME, folderName, type FolderGrant, type SharedFolder } from '../lib/agent-profile';

type Row = Record<string, unknown>;
const agentIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const machinePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;

// One validator for project folders and the workspace folder list. An agent's access to a folder
// never exceeds what the folder itself allows, so lowering a folder lowers everyone with it.
export function parseFolderList(input: unknown, { max, label, fail, machines = false }: { max: number; label: string; fail: (message: string) => Error; machines?: boolean }): SharedFolder[] {
  if (!Array.isArray(input) || input.length > max) throw fail(`${label} can share at most ${max} folders.`);
  const names = new Set<string>();
  return input.map((raw: Row) => {
    const mode = raw?.mode === 'write' || raw?.mode === 'read' ? raw.mode : null, path = String(raw?.path || '').trim();
    if (!mode || !path || path.length > 4000) throw fail('Folders need a path and read or write access.');
    const name = raw.name ? String(raw.name) : folderName(path, names);
    if (!FOLDER_NAME.test(name) || names.has(name)) throw fail('Folder names must be unique and use lowercase letters, numbers, dots, dashes, or underscores (up to 40).');
    names.add(name);
    const machineId = machines ? String(raw.machineId || 'local') : undefined;
    if (machineId !== undefined && !machinePattern.test(machineId)) throw fail('Choose the computer this folder is on.');
    const agents = Object.fromEntries(Object.entries(raw.agents && typeof raw.agents === 'object' ? raw.agents as Row : {})
      .filter(([agentId, access]) => agentIdPattern.test(agentId) && (access === 'read' || access === 'write'))
      .map(([agentId, access]) => [agentId, mode === 'read' ? 'read' : access])) as SharedFolder['agents'];
    return { id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 100) : crypto.randomUUID(), name, path, mode, agents, ...(machineId ? { machineId } : {}) };
  });
}

// Host paths are checked only when new or changed, so an unrelated edit never fails on disk state.
export function changedFolders(next: SharedFolder[], current: SharedFolder[]) {
  return next.filter(folder => { const before = current.find(item => item.id === folder.id); return !before || before.path !== folder.path || before.mode !== folder.mode || before.machineId !== folder.machineId; });
}

export function folderGrants(folders: SharedFolder[], agentId: string, scope?: 'project'): FolderGrant[] {
  return folders.filter(folder => folder.agents?.[agentId]).map(folder => ({ id: folder.id, name: folder.name, path: folder.path, mode: folder.mode === 'write' && folder.agents[agentId] === 'write' ? 'write' : 'read', ...(scope ? { scope } : {}) }));
}
