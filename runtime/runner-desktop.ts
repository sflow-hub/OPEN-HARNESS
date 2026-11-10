import { randomUUID } from 'node:crypto';
import { DESKTOP_FILE_LIMITS, desktopUploadResult, validateDesktopUploadName } from './computer-files';
type Request = { id: string; agentId: string; kind: 'desktop'; payload: { action: string; expiresAt: number; [key: string]: unknown } };
type Pending = { machineId: string; command: Request; deadline: number; sent: boolean; resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
function result(action: string, value: unknown, agentId: string, fileName: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || (value as { ok?: unknown }).ok !== true) throw new Error('The runner returned an invalid computer response.');
  const item = value as Record<string, unknown>;
  if(action==='stage-upload')return {ok:true,...desktopUploadResult(item,validateDesktopUploadName(fileName))};
  let files:Record<string,unknown>={};
  if(item.downloads!==undefined){
    if(!Array.isArray(item.downloads)||item.downloads.length>DESKTOP_FILE_LIMITS.entries)throw new Error('The runner returned invalid download details.');
    files.downloads=item.downloads.map(value=>{
      if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('The runner returned invalid download details.');
      const entry=value as Record<string,unknown>,name=validateDesktopUploadName(entry.name);
      if(entry.ownerId!==agentId||typeof entry.id!=='string'||!/^[a-f0-9]{32}$/.test(entry.id)||entry.path!==`downloads/${entry.id}-${name}`||typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)||!Number.isSafeInteger(entry.epoch)||Number(entry.epoch)<0||!Number.isSafeInteger(entry.bytes)||Number(entry.bytes)<0||Number(entry.bytes)>DESKTOP_FILE_LIMITS.fileBytes||typeof entry.savedAt!=='string'||!Number.isFinite(Date.parse(entry.savedAt))||entry.runId!==undefined&&(typeof entry.runId!=='string'||!/^[\w-]{1,100}$/.test(entry.runId)))throw new Error('The runner returned invalid download details.');
      return {id:entry.id,name,path:entry.path,sha256:entry.sha256,ownerId:agentId,epoch:entry.epoch,bytes:entry.bytes,savedAt:entry.savedAt,...(entry.runId?{runId:entry.runId}:{})};
    });
  }
  if(item.fileExchangeError)files={...files,fileExchangeError:'Some browser files could not be copied into the agent workspace. Check the exchange limits and file ownership.'};
  const metadata = { ...(typeof item.containerId === 'string' && /^[a-f0-9]{64}$/.test(item.containerId) ? { containerId: item.containerId } : {}), ...(typeof item.sessionId === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(item.sessionId) ? { sessionId: item.sessionId } : {}), ...(typeof item.browserSessionId === 'string' && /^[A-Za-z0-9:._-]{1,200}$/.test(item.browserSessionId) ? { browserSessionId: item.browserSessionId } : {}), ...(Number.isSafeInteger(item.browserPid) && Number(item.browserPid) > 0 && Number(item.browserPid) <= 2147483647 ? { browserPid: item.browserPid } : {}), ...(Number.isSafeInteger(item.generation) && Number(item.generation) > 0 ? { generation: item.generation } : {}), ...(['agent','human','idle'].includes(String(item.owner)) ? { owner: item.owner } : {}), ...(typeof item.identity === 'string' && item.identity.length > 0 && item.identity.length <= 200 ? { identity: item.identity } : {}) };
  if (action !== 'frame') return { ok: true, ...metadata, ...files };
  const prefix = 'data:image/png;base64,';
  if (typeof item.image !== 'string' || !item.image.startsWith(prefix) || item.image.length > prefix.length + 8_000_000 || !Number.isInteger(item.width) || !Number.isInteger(item.height) || Number(item.width) < 1 || Number(item.width) > 1440 || Number(item.height) < 1 || Number(item.height) > 900) throw new Error('The runner returned an invalid desktop frame.');
  const encoded = item.image.slice(prefix.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) throw new Error('The runner returned an invalid desktop frame.');
  const png = Buffer.from(encoded, 'base64');
  if (png.length > 6_000_000 || png.length < 8 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('The runner returned an invalid desktop frame.');
  return { ok: true, image: item.image, width: item.width, height: item.height, ...metadata, ...files };
}
// Frames and typed credentials are deliberately never put in the durable command spool.
export class RunnerDesktop {
  private pending = new Map<string, Pending>();
  private closed = false;
  constructor(private wake: (machineId: string) => void) {}
  request(machineId: string, agentId: string, payload: { action: string; [key: string]: unknown }): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('The coordinator is stopping.'));
    if (!['claim','start','stop','frame','input','navigate','stage-upload','reset'].includes(payload.action)) return Promise.reject(new Error('Unknown computer action.'));
    if ([...this.pending.values()].some(item => item.command.agentId === agentId)) return Promise.reject(new Error('A computer request is still in progress.'));
    return new Promise((resolve, reject) => {
      const slow = ['claim', 'start', 'stop', 'reset'].includes(payload.action);
      const id = randomUUID(), timer = setTimeout(() => { this.pending.delete(id); reject(new Error('The runner did not answer the computer request. Reconnect it before retrying.')); }, slow ? 90_000 : 25_000);
      const command = { id, agentId, kind: 'desktop' as const, payload: { ...payload, expiresAt: Date.now() + (slow ? 85_000 : 20_000) } };
      this.pending.set(id, { machineId, command, deadline: Date.now() + (slow ? 90_000 : 25_000), sent: false, resolve, reject, timer }); this.wake(machineId);
    });
  }
  poll(machineId: string) {
    const values = [...this.pending.values()].filter(item => item.machineId === machineId && !item.sent), commands: Request[] = [];
    for (const value of values) {
      if (value.command.payload.expiresAt <= Date.now()) { clearTimeout(value.timer); this.pending.delete(value.command.id); value.reject(new Error('The computer request expired before the runner received it.')); }
      else { value.sent = true; commands.push(value.command); }
    }
    return commands;
  }
  complete(machineId: string, id: string, input: { result?: unknown; error?: unknown }) {
    const pending = this.pending.get(id); if (!pending || pending.machineId !== machineId || !pending.sent) throw new Error('Computer request expired or belongs to another runner.');
    clearTimeout(pending.timer); this.pending.delete(id);
    if (pending.deadline <= Date.now()) { pending.reject(new Error('The computer response arrived after its deadline.')); throw new Error('Computer request expired.'); }
    if (!input || typeof input !== 'object' || input.error) pending.reject(new Error('The runner could not complete this computer request.'));
    else { try { pending.resolve(result(pending.command.payload.action, input.result, pending.command.agentId, pending.command.payload.fileName)); } catch (error) { pending.reject(error instanceof Error ? error : new Error('Invalid computer response.')); } }
    return { ok: true };
  }
  close() { this.closed = true; for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('The coordinator is stopping.')); } this.pending.clear(); }
}
