'use client';
import { Trash2 } from 'lucide-react';
import { folderName, folderTarget, type MachineInfo, type SharedFolder } from '../lib/agent-profile';
import type { Agent } from '../lib/types';

type Grant = { id: string; name: string; path: string; mode: 'read' | 'write'; machineId?: string };
type Exports = MachineInfo['folderExports'];

export function addFolder<T extends Grant>(folders: T[], folderExports: Exports, extra: Omit<T, keyof Grant> & Partial<Grant>): T[] {
  const path = folderExports ? (folderExports.find(folder => !folders.some(item => item.path === folder.path)) || folderExports[0])?.path || '' : '';
  return [...folders, { ...extra, id: crypto.randomUUID(), name: path ? folderName(path, folders.map(folder => folder.name)) : '', path, mode: 'read' } as T];
}

// Lowering a folder to read-only lowers everyone's access with it, so the table never shows more than will be mounted.
export function capAgents<T extends Pick<SharedFolder, 'mode' | 'agents'>>(folders: T[]): T[] {
  return folders.map(folder => folder.mode === 'read' ? { ...folder, agents: Object.fromEntries(Object.keys(folder.agents).map(agentId => [agentId, 'read'])) as SharedFolder['agents'] } : folder);
}

// One editor for the workspace's folders and a project's folders. In the Docker Desktop install
// only exported roots can be chosen, and never with more access than the export allows. With
// several computers connected, each folder also says which computer's disk its path is on.
export function FolderGrantRows<T extends Grant>({ folders, onChange, folderExports, machines, scope, label }: { folders: T[]; onChange: (folders: T[]) => void; folderExports?: Exports; machines?: MachineInfo[]; scope: 'agent' | 'project'; label: string }) {
  const machineOf = (folder: T) => machines?.find(machine => machine.id === (folder.machineId || 'local'));
  const exportsOf = (folder: T) => machines ? machineOf(folder)?.folderExports : folderExports;
  const update = (index: number, patch: Partial<Grant>) => onChange(folders.map((item, i) => i === index ? { ...item, ...patch } : item));
  // The name follows the path until someone types their own, so a quick add still gets a readable mount point.
  const withPath = (index: number, path: string, mode?: 'read' | 'write') => {
    const item = folders[index], others = folders.filter((_, i) => i !== index).map(folder => folder.name);
    const automatic = !item.name || item.name === folderName(item.path, others);
    update(index, { path, ...(mode ? { mode } : {}), ...(automatic && path.trim() ? { name: folderName(path, others) } : {}) });
  };
  return <>{folders.map((folder, index) => {
    const available = exportsOf(folder), exported = available?.find(item => item.path === folder.path), readOnlyExport = exported?.mode === 'read', n = index + 1;
    const target = folder.name ? folderTarget({ name: folder.name, scope: scope === 'project' ? 'project' : undefined }) : '';
    return <div className={`computer-folder${machines && machines.length > 1 ? ' with-computer' : ''}`} key={folder.id}>
      <label>Name<input aria-label={`${label} ${n} name`} maxLength={40} value={folder.name} placeholder="website" onChange={e => update(index, { name: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '-') })} /><small className="computer-folder-target" title={target || undefined}>{target || 'Name it to choose its path'}</small></label>
      <label>{available ? 'Exported folder' : 'Host path'}{available
        ? <select aria-label={`${label} ${n} path`} value={folder.path} onChange={e => withPath(index, e.target.value, available.find(item => item.path === e.target.value)?.mode === 'read' ? 'read' : undefined)}>{!exported && <option value={folder.path}>{folder.path ? `${folder.path} · no longer exported` : 'Choose an exported folder'}</option>}{available.map(item => <option key={item.path} value={item.path}>{item.path} · {item.mode === 'read' ? 'read-only' : 'read/write'}</option>)}</select>
        : <input aria-label={`${label} ${n} path`} value={folder.path} placeholder={machineOf(folder)?.platform === 'win32' ? 'C:\\Projects\\website' : '/home/me/projects/website'} onChange={e => withPath(index, e.target.value)} />}</label>
      {machines && machines.length > 1 && <label>Computer<select aria-label={`${label} ${n} computer`} value={folder.machineId || 'local'} onChange={e => update(index, { machineId: e.target.value })}>{machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select></label>}
      <label>Most access<select aria-label={`${label} ${n} access`} value={folder.mode} disabled={readOnlyExport && folder.mode === 'read'} onChange={e => update(index, { mode: e.target.value as 'read' | 'write' })}><option value="read">Read only</option>{(!readOnlyExport || folder.mode === 'write') && <option value="write">Read and write</option>}</select>{readOnlyExport && <small>{folder.mode === 'write' ? 'This folder is now shared read-only with Open Harness. Choose Read only to save.' : 'Shared read-only with Open Harness.'}</small>}</label>
      <button type="button" className="profile-icon-button" aria-label={`Remove ${label.toLowerCase()} ${n}`} onClick={() => onChange(folders.filter((_, i) => i !== index))}><Trash2 size={15} /></button>
    </div>;
  })}</>;
}

// Rows are agents and columns are folders. An agent left at No access never sees that folder.
// `unavailable` explains a cell that cannot be granted, such as a folder on another computer.
export function FolderAccessTable<T extends Pick<SharedFolder, 'id' | 'name' | 'mode' | 'agents'>>({ folders, agents, onChange, unavailable }: { folders: T[]; agents: Agent[]; onChange: (folders: T[]) => void; unavailable?: (agent: Agent, folder: T) => string }) {
  if (!folders.length) return null;
  if (!agents.length) return <p className="muted small">Create an agent to give it access to these folders.</p>;
  const setAccess = (folderId: string, agentId: string, access: string) => onChange(folders.map(folder => folder.id !== folderId ? folder : { ...folder, agents: Object.fromEntries(Object.entries({ ...folder.agents, [agentId]: access }).filter(([, value]) => value === 'read' || value === 'write')) as SharedFolder['agents'] }));
  return <div className="folder-access"><table><thead><tr><th scope="col">Agent</th>{folders.map(folder => <th scope="col" key={folder.id}>{folder.name || 'Unnamed folder'}</th>)}</tr></thead><tbody>{agents.map(agent => <tr key={agent.id}><th scope="row">{agent.name}</th>{folders.map(folder => {
    const reason = unavailable?.(agent, folder) || '';
    return <td key={folder.id}><select aria-label={`${agent.name} access to ${folder.name || 'unnamed folder'}`} title={reason || undefined} value={folder.agents[agent.id] || ''} onChange={event => setAccess(folder.id, agent.id, event.target.value)}><option value="">{reason ? 'Not on this computer' : 'No access'}</option><option value="read" disabled={Boolean(reason)}>Read only</option>{folder.mode === 'write' && <option value="write" disabled={Boolean(reason)}>Read and write</option>}</select>{reason && folder.agents[agent.id] && <small className="folder-access-note">{reason}</small>}</td>;
  })}</tr>)}</tbody></table></div>;
}
