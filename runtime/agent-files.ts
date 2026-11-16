import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync, statfsSync, statSync, existsSync, rmSync, renameSync, readdirSync, lstatSync, constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { managedRelativePath } from './harness-manifest';
import { ProfileError, validId } from './profiles';
import { safeWorkspacePath } from './path-safety';

export const FILE_CHUNK_BYTES = 1024 * 1024;
export type FileDestination = 'work' | 'configuration' | 'package';
export type UploadRecord = { id: string; agentId: string; machineId: string; path: string; destination: FileDestination; size: number; checksum: string; replaceId?: string; replaceExisting?: boolean; migrationId?: string; deliveryAttempt?: number; state: string; detail: string; updatedAt: number; createdAt: number };
export type ManagedFile = UploadRecord & { revision: string };
export const fileDigest = async (path: string) => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path, { highWaterMark: FILE_CHUNK_BYTES })) hash.update(chunk); return hash.digest('hex'); };
export async function matchesRegularFile(path: string, size: number, checksum: string) {
  // Existing working files are agent-writable; opening a FIFO for hashing would block delivery.
  let file;
  try { file = await open(path, process.platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW); }
  catch (error) { if (['ENOENT','ELOOP'].includes((error as NodeJS.ErrnoException).code || '')) return false; throw error; }
  try {
    const stat = await file.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size !== size) return false;
    const digest = createHash('sha256'), bytes = Buffer.allocUnsafe(FILE_CHUNK_BYTES);
    for (let position = 0; position < size;) { const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, size - position), position); if (!bytesRead) return false; digest.update(bytes.subarray(0, bytesRead)); position += bytesRead; }
    return digest.digest('hex') === checksum && (await file.stat()).size === size;
  } finally { await file.close(); }
}
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const numberLimit = (name: string, fallback: number) => { const n = Number(process.env[name] || fallback); if (!Number.isSafeInteger(n) || n < FILE_CHUNK_BYTES) throw new Error(`${name} must be a positive byte limit.`); return n; };

export class AgentFiles {
  readonly maximum = numberLimit('OPEN_HARNESS_MAX_FILE_BYTES', 20 * 1024 ** 3);
  readonly quota = numberLimit('OPEN_HARNESS_MACHINE_FILE_QUOTA', 100 * 1024 ** 3);
  private locks = new Set<string>();
  constructor(readonly db: DatabaseSync, readonly root: string, readonly installedBytes:(machineId:string)=>number=()=>0) {
    db.exec(`CREATE TABLE IF NOT EXISTS managed_install_reservations(id TEXT PRIMARY KEY,machine_id TEXT NOT NULL,bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_uploads(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, machine_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_chunks(upload_id TEXT NOT NULL, chunk_index INTEGER NOT NULL, checksum TEXT NOT NULL, PRIMARY KEY(upload_id,chunk_index));
      CREATE TABLE IF NOT EXISTS managed_files(id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, machine_id TEXT NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_deliveries(file_id TEXT NOT NULL, machine_id TEXT NOT NULL, state TEXT NOT NULL, PRIMARY KEY(file_id,machine_id));`);
    mkdirSync(join(root, 'file-store'), { recursive: true, mode: 0o700 });
    this.expire();
  }
  private path(name: string) { return safeWorkspacePath(this.root, name ? `file-store/${name}` : 'file-store'); }
  blob(id: string) { return this.path(`${validId(id)}/blob`); }
  get(id: string, agentId?: string): UploadRecord {
    const row = this.db.prepare('SELECT json FROM managed_uploads WHERE id=?').get(validId(id)) as { json: string } | undefined;
    if (!row) throw new ProfileError('Upload not found.', 404);
    const value = JSON.parse(row.json) as UploadRecord;
    if (agentId && value.agentId !== agentId) throw new ProfileError('Upload not found.', 404);
    return value;
  }
  file(id: string, agentId?: string): ManagedFile {
    const row = this.db.prepare('SELECT json FROM managed_files WHERE id=?').get(validId(id)) as { json: string } | undefined;
    if (!row) throw new ProfileError('File not found.', 404);
    const value = JSON.parse(row.json) as ManagedFile;
    if (agentId && value.agentId !== agentId) throw new ProfileError('File not found.', 404);
    return value;
  }
  list(agentId: string) { return (this.db.prepare('SELECT json FROM managed_files WHERE agent_id=? ORDER BY rowid DESC').all(validId(agentId)) as { json: string }[]).map(r => JSON.parse(r.json) as ManagedFile); }
  uploads(agentId: string) { return (this.db.prepare('SELECT json FROM managed_uploads WHERE agent_id=? ORDER BY rowid DESC').all(validId(agentId)) as { json: string }[]).map(r => JSON.parse(r.json) as UploadRecord); }
  update(value: UploadRecord, state: string, detail = '') { const next = { ...value, state, detail, updatedAt: Date.now() }; this.db.prepare('UPDATE managed_uploads SET json=? WHERE id=?').run(JSON.stringify(next), value.id); return next; }
  private usage(machineId: string) { return this.installedBytes(machineId) + Number((this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM managed_install_reservations WHERE machine_id=?').get(machineId) as {bytes:number}).bytes) + (this.db.prepare('SELECT json FROM managed_uploads WHERE machine_id=?').all(machineId) as { json: string }[]).reduce((n, row) => { const u = JSON.parse(row.json) as UploadRecord; return n + (['cancelled','expired'].includes(u.state) ? 0 : u.size); }, 0); }
  reserveInstallation(id:string,machineId:string){const bytes=Math.max(0,this.quota-this.usage(machineId));this.db.prepare('INSERT OR REPLACE INTO managed_install_reservations VALUES(?,?,?)').run(id,machineId,bytes);return bytes;}
  releaseInstallation(id:string){this.db.prepare('DELETE FROM managed_install_reservations WHERE id=?').run(id);}
  create(agentId: string, machineId: string, input: { path: string; destination: FileDestination; size: number; checksum: string; replaceId?: string; replaceExisting?: boolean }) {
    this.expire(); validId(agentId); validId(machineId); managedRelativePath(input.path);
    if (!['work','configuration','package'].includes(input.destination) || !Number.isSafeInteger(input.size) || input.size < 0 || input.size > this.maximum || !/^[a-f0-9]{64}$/.test(input.checksum)) throw new ProfileError(`Choose a file up to ${this.maximum} bytes with its SHA-256 checksum.`, 413);
    const existing = this.list(agentId).find(f => f.path.toLowerCase() === input.path.toLowerCase() && f.destination === input.destination && f.machineId === machineId);
    if (existing && input.replaceId !== existing.id) throw new ProfileError('A file already uses this path. Choose Replace explicitly.', 409);
    if (input.replaceId && (!existing || existing.id !== input.replaceId)) throw new ProfileError('The file changed before replacement. Reload the file list.', 409);
    if (this.usage(machineId) + input.size > this.quota) throw new ProfileError('This computer’s managed-file quota is full.', 413);
    const pendingBytes=(this.db.prepare('SELECT json FROM managed_uploads').all() as {json:string}[]).reduce((total,row)=>{const u=JSON.parse(row.json) as UploadRecord;return total+(!['ready','cancelled','expired'].includes(u.state)?u.size*2:0);},0);
    const free = statfsSync(this.path('')); if (free.bavail * free.bsize < input.size * 2 + pendingBytes + FILE_CHUNK_BYTES) throw new ProfileError('There is not enough free space to stage this file.', 507);
    const id = randomUUID(), value: UploadRecord = { id, agentId, machineId, path: input.path, destination: input.destination, size: input.size, checksum: input.checksum, ...(input.replaceId ? { replaceId: input.replaceId } : {}), ...(input.replaceExisting===true?{replaceExisting:true}:{}), state: 'uploading', detail: '', createdAt: Date.now(), updatedAt: Date.now() };
    mkdirSync(this.path(id), { mode: 0o700 });
    this.db.prepare('INSERT INTO managed_uploads VALUES(?,?,?,?)').run(id, agentId, machineId, JSON.stringify(value));
    return value;
  }
  inspect(id: string, agentId?: string) { return { ...this.get(id, agentId), chunkBytes: FILE_CHUNK_BYTES, received: (this.db.prepare('SELECT chunk_index FROM managed_chunks WHERE upload_id=? ORDER BY chunk_index').all(id) as { chunk_index: number }[]).map(r => r.chunk_index) }; }
  async put(id: string, index: number, bytes: Buffer, checksum: string) {
    const u = this.get(id), expected = Math.min(FILE_CHUNK_BYTES, u.size - index * FILE_CHUNK_BYTES);
    if (u.state !== 'uploading' || !Number.isSafeInteger(index) || index < 0 || expected <= 0 || bytes.length !== expected || hash(bytes) !== checksum) throw new ProfileError('Invalid upload chunk or checksum.', 409);
    const key = `${id}:${index}`; if (this.locks.has(key) || this.locks.has(id)) throw new ProfileError('This chunk is being written. Retry shortly.', 409);
    const prior = this.db.prepare('SELECT checksum FROM managed_chunks WHERE upload_id=? AND chunk_index=?').get(id, index) as { checksum: string } | undefined;
    if (prior) { if (prior.checksum !== checksum) throw new ProfileError('This chunk was already uploaded with different content.', 409); return; }
    if ([...this.locks].filter(k => k.startsWith(`${id}:`)).length >= 4) throw new ProfileError('At most four chunks may upload together.', 429);
    this.locks.add(key);
    const temporary = this.path(`${id}/${index}.part`), target = this.path(`${id}/${index}`);
    try { rmSync(temporary,{force:true}); const f = await open(temporary, 'wx', 0o600); try { await f.writeFile(bytes); await f.sync(); } finally { await f.close(); } renameSync(temporary, target); this.db.prepare('INSERT INTO managed_chunks VALUES(?,?,?)').run(id,index,checksum); this.update(u,'uploading'); }
    finally { this.locks.delete(key); rmSync(temporary, { force: true }); }
  }
  queueFinalize(id:string) { const u=this.get(id);if(u.state!=='uploading')return u;if(this.inspect(id).received.length!==Math.ceil(u.size/FILE_CHUNK_BYTES))throw new ProfileError('Some upload chunks are missing.',409);return this.update(u,'assembling','Verifying uploaded bytes.'); }
  async finalize(id: string) {
    const u = this.get(id); if (['uploaded','waiting-machine','delivering','verifying','ready'].includes(u.state)) return u;
    if(existsSync(this.blob(id))&&await fileDigest(this.blob(id))===u.checksum)return this.update(u,'uploaded');
    if (!['uploading','assembling'].includes(u.state) || this.locks.has(id) || [...this.locks].some(k => k.startsWith(`${id}:`))) throw new ProfileError('Wait for all chunks before finishing.',409);
    if (this.inspect(id).received.length !== Math.ceil(u.size / FILE_CHUNK_BYTES)) throw new ProfileError('Some upload chunks are missing.',409);
    this.locks.add(id); const target = this.path(`${id}/assembled`);
    try {
      const out = await open(target, 'w', 0o600); const digest = createHash('sha256');
      try { for (let i=0; i < Math.ceil(u.size / FILE_CHUNK_BYTES); i++) { const bytes = await readFile(this.path(`${id}/${i}`)); digest.update(bytes); await out.writeFile(bytes); } await out.sync(); } finally { await out.close(); }
      if (digest.digest('hex') !== u.checksum) throw new ProfileError('Final file checksum does not match. Cancel and upload again.',409);
      renameSync(target,this.blob(id)); for (let i=0; i < Math.ceil(u.size / FILE_CHUNK_BYTES); i++) rmSync(this.path(`${id}/${i}`));
      return this.update(u,'uploaded');
    } finally { this.locks.delete(id); rmSync(target,{force:true}); }
  }
  async chunk(id: string, index: number) {
    const u = this.get(id); if (['uploading','assembling','cancelled','expired'].includes(u.state) || !Number.isSafeInteger(index) || index < 0 || index >= Math.ceil(u.size / FILE_CHUNK_BYTES)) throw new ProfileError('File chunk unavailable.',404);
    const f = await open(this.blob(id), 'r'); try { const bytes = Buffer.alloc(Math.min(FILE_CHUNK_BYTES,u.size-index*FILE_CHUNK_BYTES)); const result = await f.read(bytes,0,bytes.length,index*FILE_CHUNK_BYTES); if (result.bytesRead !== bytes.length) throw new ProfileError('Stored file is incomplete.',409); return { data: bytes.toString('base64'), checksum: hash(bytes) }; } finally { await f.close(); }
  }
  assertPublication(id:string){const u=this.get(id),old=this.list(u.agentId).find(f=>f.destination===u.destination&&f.path.toLowerCase()===u.path.toLowerCase()&&f.machineId===u.machineId);if(old&&old.id!==u.replaceId&&old.id!==u.id)throw new ProfileError('The destination changed. Reload before replacing it.',409);}
  publish(id: string) {
    const u = this.get(id); const old = this.list(u.agentId).find(f => f.destination === u.destination && f.path.toLowerCase() === u.path.toLowerCase() && f.machineId === u.machineId);
    if (old && old.id !== u.replaceId && old.id !== u.id) throw new ProfileError('The destination changed. Reload before replacing it.',409);
    const file: ManagedFile = { ...u, state:'ready', detail:'', revision:u.id };
    this.db.exec('SAVEPOINT publish_file');
    try { if(old && u.destination==='work') this.db.prepare('DELETE FROM managed_files WHERE id=?').run(old.id); this.db.prepare('INSERT OR REPLACE INTO managed_files VALUES(?,?,?,?)').run(id,u.agentId,u.machineId,JSON.stringify(file)); this.update(u,'ready'); this.delivered(id,u.machineId); this.db.exec('RELEASE publish_file'); } catch(e) { this.db.exec('ROLLBACK TO publish_file; RELEASE publish_file'); throw e; }
    if(old&&u.destination==='work'&&old.id!==u.id){this.update(old,'cancelled');rmSync(this.path(old.id),{recursive:true,force:true});}
    return file;
  }
  delivered(id: string, machineId: string) { this.db.prepare("INSERT OR REPLACE INTO managed_deliveries VALUES(?,?,'ready')").run(id,machineId); }
  hasDelivery(id: string, machineId: string) { return Boolean(this.db.prepare("SELECT 1 FROM managed_deliveries WHERE file_id=? AND machine_id=? AND state='ready'").get(id,machineId)); }
  async publishLocal(id: string, machineId = 'local') { this.assertPublication(id); const u = this.get(id); await installManagedFile(this.root,u,this.blob(id)); this.delivered(id,machineId); return this.publish(id); }
  cancel(id: string) { const u = this.get(id); if (this.locks.has(id) || [...this.locks].some(k => k.startsWith(`${id}:`)) || ['ready','verifying'].includes(u.state)) throw new ProfileError('This file is being installed or is already ready.',409); rmSync(this.path(id),{recursive:true,force:true}); this.db.prepare('DELETE FROM managed_chunks WHERE upload_id=?').run(id); return this.update(u,'cancelled'); }
  retry(id:string) { const u=this.get(id);if(u.state!=='failed')throw new ProfileError('Only failed deliveries can be retried.',409);return this.update({...u,deliveryAttempt:(u.deliveryAttempt||0)+1},existsSync(this.blob(id))?'uploaded':'uploading'); }
  remove(id: string, agentId: string) { const f = this.file(id,agentId); this.db.prepare('DELETE FROM managed_files WHERE id=?').run(f.id); this.update(f,'cancelled'); rmSync(this.path(id),{recursive:true,force:true}); return f; }
  expire() { for (const row of this.db.prepare('SELECT json FROM managed_uploads').all() as {json:string}[]) { const u = JSON.parse(row.json) as UploadRecord; if (u.state === 'uploading' && Date.now()-u.updatedAt > 7*86400000 && !this.locks.has(u.id)) { rmSync(this.path(u.id),{recursive:true,force:true}); this.db.prepare('DELETE FROM managed_chunks WHERE upload_id=?').run(u.id); this.update(u,'expired'); } } }
}

export function installedFilePath(root: string, file: Pick<UploadRecord,'agentId'|'destination'|'path'|'id'>) {
  validId(file.agentId); validId(file.id); managedRelativePath(file.path);
  return safeWorkspacePath(root,`agents/${file.agentId}/files/${file.destination}/${file.destination === 'work' ? '' : file.id + '/'}${file.path}`);
}
export async function installManagedFile(root: string, file: UploadRecord, source: string) {
  const target = installedFilePath(root,file); if(file.destination==='work'&&existsSync(target)&&!file.replaceId&&!file.replaceExisting){if(await matchesRegularFile(target,file.size,file.checksum))return;throw new ProfileError('A working file already uses this path. Choose Replace explicitly.',409);} mkdirSync(dirname(target),{recursive:true,mode:0o700}); safeWorkspacePath(root,`agents/${file.agentId}/files/${file.destination}`);
  const free = statfsSync(dirname(target)); if (free.bavail*free.bsize < file.size + FILE_CHUNK_BYTES) throw new ProfileError('The destination computer has insufficient disk space.',507);
  const temporary = safeWorkspacePath(root,`agents/${file.agentId}/files/${file.id}.part`);
  try { await pipeline(createReadStream(source),createWriteStream(temporary,{mode:0o600})); if (await fileDigest(temporary) !== file.checksum) throw new ProfileError('Delivered file checksum does not match.',409); renameSync(temporary,target); } finally { rmSync(temporary,{force:true}); }
}

// Used when a runner has edited working files: migration stages current bytes, not stale upload copies.
export function managedWorkingFiles(root: string, agentId: string) {
  const base = safeWorkspacePath(root,`agents/${validId(agentId)}/files/work`), files: {path:string;size:number}[] = [];
  const visit = (dir: string, prefix = '') => { if(!existsSync(dir))return; for(const name of readdirSync(dir)) { const relative = prefix + name; managedRelativePath(relative); const path = safeWorkspacePath(base,relative), stat = lstatSync(path); if(stat.isDirectory())visit(path,relative+'/'); else if(stat.isFile()&&stat.nlink===1)files.push({path:relative,size:statSync(path).size}); else throw new ProfileError('Working files contain a link or special file.'); } };
  visit(base); return files;
}
