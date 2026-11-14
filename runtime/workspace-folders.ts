import type { DatabaseSync } from 'node:sqlite';
import { folderName, type FolderGrant, type SharedFolder } from '../lib/agent-profile';
import { changedFolders, folderGrants, parseFolderList } from './folder-list';
import { ProfileError } from './profiles';

export type WorkspaceFolderList = { revision: number; folders: SharedFolder[] };

// The folders agents keep across every run, and who may use each one. This is the only place
// lasting folder access is stored: grants once saved on individual agents are moved in here.
export class WorkspaceFolders {
  constructor(private db: DatabaseSync, private checkFolder: (folder: SharedFolder) => void = () => {}) {
    db.exec('CREATE TABLE IF NOT EXISTS workspace_folders(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL)');
  }
  get(): WorkspaceFolderList {
    const row = this.db.prepare('SELECT revision,json FROM workspace_folders WHERE id=1').get() as { revision: number; json: string } | undefined;
    if (!row) return { revision: 0, folders: [] };
    try { const folders = JSON.parse(row.json); return { revision: row.revision, folders: Array.isArray(folders) ? folders : [] }; } catch { return { revision: row.revision, folders: [] }; }
  }
  private write(revision: number, folders: SharedFolder[]) {
    this.db.prepare('INSERT INTO workspace_folders VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(revision, JSON.stringify(folders));
    return this.get();
  }
  save(input: { revision?: unknown; folders?: unknown }) {
    const current = this.get();
    if (Number(input.revision) !== current.revision) throw new ProfileError('Folder access was changed elsewhere. Reload before saving again; your draft is still here.', 409);
    const folders = parseFolderList(input.folders, { max: 100, label: 'The workspace', fail: message => new ProfileError(message), machines: true });
    changedFolders(folders, current.folders).forEach(this.checkFolder);
    return this.write(current.revision + 1, folders);
  }
  // A folder lives on one computer, so it reaches an agent only while that agent works there.
  grants(agentId: string, machineId: string): FolderGrant[] {
    return folderGrants(this.get().folders.filter(folder => (folder.machineId || 'local') === machineId), agentId);
  }
  // Moves grants saved on an agent into the list without narrowing anything: a folder already
  // listed for that computer gains the agent, and its access only ever grows to match the grant.
  absorb(agentId: string, machineId: string, grants: FolderGrant[]) {
    if (!grants.length) return;
    const { revision, folders } = this.get(), next = folders.map(folder => ({ ...folder, agents: { ...folder.agents } }));
    for (const grant of grants) {
      const listed = next.find(folder => folder.path === grant.path && (folder.machineId || 'local') === machineId);
      if (listed) { if (grant.mode === 'write') listed.mode = 'write'; if (listed.agents[agentId] !== 'write') listed.agents[agentId] = grant.mode; continue; }
      const taken = next.map(folder => folder.name);
      next.push({ id: next.some(folder => folder.id === grant.id) ? crypto.randomUUID() : grant.id, name: grant.name && !taken.includes(grant.name) ? grant.name : folderName(grant.path, taken), path: grant.path, mode: grant.mode, machineId, agents: { [agentId]: grant.mode } });
    }
    // A grant already listed (a retried save, a re-import) must not bump the revision under an open draft.
    if (JSON.stringify(next) !== JSON.stringify(folders)) this.write(revision + 1, next);
  }
}
