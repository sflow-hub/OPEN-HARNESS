import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import type { AgentProfile } from '../lib/agent-profile';
import { isSandboxedComputer } from '../lib/agent-profile';
import type { Team } from '../lib/team';
import { stopAgentContainers } from './hermes';
import { desktopResourceKey, ensureDesktopContainerAsync, runningDesktopContainer, stopDesktopContainer } from './computer-runtime';
import { assertComputerOwnership, claimComputerOwnership, readComputerOwnership, validComputerOwnership, type ComputerOwnership } from './computer-ownership';
import { DESKTOP_HELPER } from './desktop-helper';
import { claimDesktopExchange, publishDesktopDownloads, stageDesktopUpload, type DesktopExchangeLease } from './computer-files';
import { ProfileError, validId } from './profiles';
import { atomicWorkspaceWrite, safeWorkspacePath } from './path-safety';

export type DesktopInput = { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; clickCount?: number } | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number } | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount: number } | { type: 'key'; key: string } | { type: 'text'; text: string };
export type DesktopCommand = { action: 'claim' | 'start' | 'frame' | 'input' | 'navigate' | 'stage-upload' | 'stop' | 'reset'; input?: DesktopInput; url?: string; fileName?: string; freshPage?: boolean; expiresAt?: number; ownership?: ComputerOwnership };
const keys = /^(?:(?:Control|Alt|Shift|Meta)\+){0,4}(?:[a-zA-Z0-9]|Enter|Tab|Escape|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Home|End|PageUp|PageDown|Insert|Space|F(?:[1-9]|1[0-2])|[\-=[\]\\;',./`])$/;
const coordinate = (value: unknown, limit: number) => Number.isInteger(value) && Number(value) >= 0 && Number(value) < limit;
export function validateDesktopInput(input: unknown): DesktopInput {
  if (!input || typeof input !== 'object') throw new ProfileError('Choose a desktop action.');
  const value = input as Record<string, unknown>;
  if (value.type === 'click' && coordinate(value.x,1440) && coordinate(value.y,900) && ['left','right','middle'].includes(String(value.button || 'left')) && (value.clickCount === undefined || [1,2].includes(Number(value.clickCount)))) return { type:'click',x:Number(value.x),y:Number(value.y),button:(value.button||'left') as 'left'|'right'|'middle',...(value.clickCount?{clickCount:Number(value.clickCount)}:{}) };
  if (value.type === 'drag' && coordinate(value.fromX,1440) && coordinate(value.fromY,900) && coordinate(value.toX,1440) && coordinate(value.toY,900)) return {type:'drag',fromX:Number(value.fromX),fromY:Number(value.fromY),toX:Number(value.toX),toY:Number(value.toY)};
  if (value.type === 'scroll' && ['up','down','left','right'].includes(String(value.direction)) && Number.isInteger(value.amount) && Number(value.amount)>=1 && Number(value.amount)<=10) return {type:'scroll',direction:value.direction as 'up'|'down'|'left'|'right',amount:Number(value.amount)};
  if (value.type === 'key' && typeof value.key === 'string' && value.key.length <= 80 && keys.test(value.key)) return {type:'key',key:value.key};
  if (value.type === 'text' && typeof value.text === 'string' && value.text.length>0 && value.text.length<=4000 && !value.text.includes('\0')) return {type:'text',text:value.text};
  throw new ProfileError('Desktop input is invalid or outside the supported screen.');
}
export function validateDesktopUrl(value: unknown) {
  if(typeof value!=='string'||value.length>4000)throw new ProfileError('Enter a browser address.');
  let url:URL;try{url=new URL(value);}catch{throw new ProfileError('Enter a complete http or https browser address.');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new ProfileError('Use an http or https address without embedded credentials.');return url.href;
}
function checkDeadline(command: DesktopCommand) {
  if(command.expiresAt!==undefined&&(!Number.isFinite(command.expiresAt)||command.expiresAt<=Date.now()))throw new ProfileError('This computer request expired. Refresh and try again.',409);
}
const executions = new Map<string,Promise<unknown>>();
export async function executeDesktopCommand(root:string,profile:AgentProfile,command:DesktopCommand):Promise<Record<string,unknown>> {
  validId(profile.id);
  if(!isSandboxedComputer(profile.computer)||profile.computer.desktop!=='virtual')throw new ProfileError('Enable the private agent desktop in Computer settings first.',409);
  const key=desktopResourceKey(profile.id,root,profile.computer),previous=executions.get(key);
  const work=(async()=>{
    if(previous)await previous.catch(()=>{});checkDeadline(command);
    const exchangeLease=(ownership:ComputerOwnership):DesktopExchangeLease=>({ownerId:profile.id,epoch:ownership.generation,...(ownership.owner==='agent'?{runId:ownership.identity}:{})});
    if(command.action==='claim') {
      if(!validComputerOwnership(command.ownership))throw new ProfileError('Computer ownership is required.',409);
      claimComputerOwnership(root,profile,command.ownership);
      if(process.env.OPEN_HARNESS_MOCK!=='1'){
        const exchange=await claimDesktopExchange(profile.id,root,profile.computer,exchangeLease(command.ownership),async()=>{const container=await runningDesktopContainer(profile.id,root,profile.computer);if(container)await desktopHelper(container,{action:'stop',expiresAt:command.expiresAt});});
        if(exchange.reset){const container=await ensureDesktopContainerAsync(profile.id,root,profile.computer);await desktopHelper(container,{action:'start',freshPage:true,expiresAt:command.expiresAt});}
      }
      return {ok:true};
    }
    if(command.ownership)assertComputerOwnership(root,profile,command.ownership);
    else if(!['frame','reset'].includes(command.action)&&readComputerOwnership(root,profile))throw new ProfileError('Computer ownership is required.',409);
    const input=command.action==='input'?validateDesktopInput(command.input):undefined;
    const url=command.action==='navigate'?validateDesktopUrl(command.url):undefined;
    if(!['start','frame','input','navigate','stage-upload','stop','reset'].includes(command.action))throw new ProfileError('Unsupported computer command.');
    if(process.env.OPEN_HARNESS_MOCK==='1')return command.action==='frame'?{ok:true,mock:true,image:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',width:1440,height:900}:{ok:true,sessionId:`mock-desktop-${key}`};
    if(command.action==='stop'){await stopAgentContainers(profile.id,root);return {ok:true};}
    if(command.action==='reset'){await stopAgentContainers(profile.id,root);await stopDesktopContainer(profile.id,root,profile.computer);return {ok:true};}
    if(command.action==='stage-upload'){
      if(!command.ownership)throw new ProfileError('Computer ownership is required.',409);
      return {ok:true,...stageDesktopUpload(profile.id,root,profile.computer,exchangeLease(command.ownership),String(command.fileName||''))};
    }
    if(command.action==='start')await ensureDesktopContainerAsync(profile.id,root,profile.computer);
    const container=await runningDesktopContainer(profile.id,root,profile.computer);checkDeadline(command);
    if(command.ownership)assertComputerOwnership(root,profile,command.ownership);
    if(!container)throw new ProfileError('This private desktop is stopped. Take control to open it.',409);
    const result=await desktopHelper(container,{...command,...(input?{input}:{}),...(url?{url}:{})});
    let files:Record<string,unknown>={};
    if(command.ownership){try{files={downloads:publishDesktopDownloads(profile.id,root,profile.computer,exchangeLease(command.ownership))};}catch{files={fileExchangeError:'Some browser files could not be copied into the agent workspace. Check the exchange limits and file ownership.'};}}
    return {...result,...files,...(command.action==='start'?{sessionId:`${container}:${String(result.browserSessionId||result.sessionId||'browser')}`}:{})};
  })();executions.set(key,work);try{return await work;}finally{if(executions.get(key)===work)executions.delete(key);}
}

function desktopHelper(container: string, command: DesktopCommand): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    // Source and target are controlled by this build. Input stays on stdin, never in process args.
    const child = spawn('docker', ['exec', '-i', container, 'timeout', '--signal=KILL', '18s', 'python', '-c', DESKTOP_HELPER], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 20_000, killSignal: 'SIGKILL' });
    let output = '', settled = false;
    const fail = () => { if (!settled) { settled = true; reject(new ProfileError('The private desktop did not respond. Check the runtime and retry.', 503)); } };
    child.stdout.on('data', chunk => { output += chunk; if (output.length > 9_000_000) { child.kill('SIGKILL'); fail(); } });
    child.once('error', fail); child.stdin.on('error', fail);
    child.once('close', code => {
      if (settled) return;
      if (code !== 0) { fail(); return; }
      try { const result = JSON.parse(output); if (!result.ok) { fail(); return; } settled = true; resolve(result); }
      catch { fail(); }
    });
    child.stdin.end(JSON.stringify(command) + '\n');
  });
}

type Recording = { id: string; steps: string[]; startedAt: string };
type Lease = { id:string;ready:boolean;actorId:string;recording?:Recording;since:string;state:'taking-control'|'human'|'handing-back'|'blocked';preserved:boolean;shellJobsStopped:boolean };
type Dependencies = {
  actor?():{id:string;role:string};
  getProfile(id: string): AgentProfile | null;
  listProfiles(): AgentProfile[];
  listTeams(): Team[];
  saveProfile(profile: AgentProfile): AgentProfile;
  stopAgent(id: string): Promise<void>;
  isBusy(id: string): boolean;
  canContinue?(id: string): boolean;
  machine?(id:string):{id:string;name:string;status:string;capabilities?:unknown};
  controllerName?(id:string):string;
  revocation?(id:string):Record<string,unknown>;
  remote?(profile: AgentProfile, command: DesktopCommand): Promise<Record<string, unknown>>;
  onReleased?(id: string, continueWork: boolean): Promise<unknown> | unknown;
  onDraft?(id:string,instructions:string):{id:string};
};

export function demonstrationStep(input: DesktopInput) {
  if (input.type === 'text') return 'Enter the required value. Typed text was omitted; ask the operator for credentials or private values when needed.';
  if (input.type === 'click') return `Click the intended control near screen position (${input.x}, ${input.y}) with the ${input.button} button. Identify the control by its current label before acting; coordinates may change.`;
  if (input.type === 'scroll') return `Scroll ${input.direction} ${input.amount} step${input.amount === 1 ? '' : 's'}.`;
  if(input.type==='drag')return 'Drag the intended item to its destination after checking the current screen.';
  const base=input.key.replace(/^(?:Shift\+)+/,'');
  if(!/(?:Control|Alt|Meta)\+/.test(input.key)&&(base.length===1||base==='Space'))return 'Type the required value. Individual typed characters were omitted.';
  return `Press ${input.key}.`;
}

export function demonstrationDraft(steps: string[]) {
  return `---\nname: demonstrated-workflow\ndescription: A recorded workflow to review and test before reuse.\n---\n\n# Demonstrated workflow\n\nDraft: describe the goal, starting page, expected result, and which actions require approval before saving.\n\nObserve the current application before each step. Never replay coordinates blindly. Do not repeat completed submissions, purchases, or messages. Ask before taking any sensitive action not already authorized.\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join('\n')}\n\n## Verification\n\nReplace this paragraph with the observable success checks. Test once with supervision before creating a routine. This draft grants no additional tools or authority.\n`;
}

export class DesktopControl {
  private leases = new Map<string, Lease>();
  private operations = new Set<string>();
  private ownershipFile:string;
  private ownerships=new Map<string,ComputerOwnership>();
  private sessions=new Map<string,string>();
  constructor(readonly root: string, private deps: Dependencies) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    this.ownershipFile = safeWorkspacePath(root, 'desktop-control.json');
    if (existsSync(this.ownershipFile)) {
      try {
        const data = readFileSync(this.ownershipFile, 'utf8');
        if (data.length > 300_000) throw new Error('Ownership record is too large.');
        const saved = JSON.parse(data) as { version: number; leases: Array<{ agentId: string; leaseId: string;actorId?:string;recording?:Recording;since?:string }>; ownerships?:Array<[string,ComputerOwnership]> };
        if (![1,2].includes(saved.version) || !Array.isArray(saved.leases) || saved.leases.length > 1000) throw new Error('Invalid ownership record.');
        for(const [key,value] of saved.ownerships||[]){if(typeof key!=='string'||!validComputerOwnership(value))throw new Error('Invalid ownership generation.');this.ownerships.set(key,value);}
        for (const lease of saved.leases) {
          if (typeof lease.agentId !== 'string') throw new Error('Invalid ownership agent.');
          const id = validId(lease.agentId);
          if (this.leases.has(id) || typeof lease.leaseId !== 'string' || !/^[a-f0-9-]{36}$/.test(lease.leaseId)) throw new Error('Invalid ownership lease.');
          if(lease.recording&&(!Array.isArray(lease.recording.steps)||lease.recording.steps.length>200||lease.recording.steps.some(step=>typeof step!=='string'||step.length>1000)))throw new Error('Invalid recording.');
          if(lease.actorId!==undefined&&(typeof lease.actorId!=='string'||!lease.actorId||lease.actorId.length>200))throw new Error('Invalid human controller.');
          this.leases.set(id, { id: lease.leaseId, actorId:lease.actorId||'local-owner',ready:false,since:lease.since||new Date().toISOString(),state:'blocked',preserved:false,shellJobsStopped:false,...(lease.recording?{recording:lease.recording}:{}) });
        }
      } catch { throw new ProfileError('The saved human desktop ownership record could not be read. Restore desktop-control.json from a valid backup before starting the coordinator; agent work remains blocked.'); }
    }
  }
  private persistOwnership() {
    atomicWorkspaceWrite(this.ownershipFile, JSON.stringify({ version:2,ownerships:[...this.ownerships],leases: [...this.leases].map(([agentId, lease]) => ({ agentId, leaseId: lease.id,actorId:lease.actorId,since:lease.since,...(lease.recording?{recording:lease.recording}:{}) })) }));
  }
  private profile(id: string, checkSharing = true) {
    const profile = this.deps.getProfile(validId(id));
    if (!profile) throw new ProfileError('Agent profile not found.', 404);
    if (!isSandboxedComputer(profile.computer) || profile.computer.desktop !== 'virtual') throw new ProfileError('Enable the private agent desktop in Computer settings first.', 409);
    if (checkSharing) this.validateSharing(profile);
    return profile;
  }
  validateSharing(profile: AgentProfile) {
    const teamId = profile.computer.browserSessionTeamId;
    if (!teamId) return;
    if (!this.deps.listTeams().some(team => team.id === teamId && !team.retiredAt && team.memberAgentIds.includes(profile.id))) throw new ProfileError('Shared browser access requires current membership in an active team.', 409);
    if (this.deps.listProfiles().some(other => other.id !== profile.id && other.computer.browserSessionTeamId === teamId && other.computer.machineId !== profile.computer.machineId)) throw new ProfileError('Agents sharing browser logins must use the same computer.', 409);
  }
  peers(profile: AgentProfile) {
    return profile.computer.browserSessionTeamId ? this.deps.listProfiles().filter(other => other.id !== profile.id && other.computer.browserSessionTeamId === profile.computer.browserSessionTeamId) : [];
  }
  blocksAgent(id: string) {
    if (this.leases.has(id)) return true;
    const profile = this.deps.getProfile(id);
    return Boolean(profile && this.peers(profile).some(other => this.leases.has(other.id)));
  }
  canRun(profile: AgentProfile) {
    return !this.operations.has(profile.id) && !this.blocksAgent(profile.id) && !this.peers(profile).some(other => this.deps.isBusy(other.id) || this.operations.has(other.id));
  }
  ownership(id:string){const profile=this.deps.getProfile(validId(id));return profile?.computer.desktop==='virtual'?this.ownerships.get(desktopResourceKey(id,this.root,profile.computer)):undefined;}
  humanOwnership(id:string,leaseId:string,actorId:string){this.profile(id);const lease=this.leases.get(id),ownership=this.ownership(id);if(!lease||!lease.ready||lease.id!==leaseId||lease.actorId!==actorId||ownership?.owner!=='human'||ownership.identity!==leaseId)throw new ProfileError('Only the current controller can open this terminal.',403);return {...ownership};}
  private async claim(profile:AgentProfile,owner:ComputerOwnership['owner'],identity:string){
    const key=desktopResourceKey(profile.id,this.root,profile.computer),prior=this.ownerships.get(key),local=profile.computer.machineId==='local'?readComputerOwnership(this.root,profile):null;
    const ownership:ComputerOwnership={generation:Math.max(prior?.generation||0,local?.generation||0)+1,owner,identity};this.ownerships.set(key,ownership);this.persistOwnership();await this.execute(profile,{action:'claim',ownership});return ownership;
  }
  async prepareRun(profile:AgentProfile,runId=profile.id){
    this.validateSharing(profile);if(!this.canRun(profile))throw new ProfileError('This shared browser is in use. Wait for its task or human control session to finish.',409);
    if(profile.computer.desktop!=='virtual')return;
    const ownership=await this.claim(profile,'agent',runId),result=await this.execute(profile,{action:'start',ownership});
    if(typeof result.sessionId==='string')this.sessions.set(desktopResourceKey(profile.id,this.root,profile.computer),result.sessionId);
  }
  async agentCommand(id:string,runId:string,command:DesktopCommand,permitted:()=>boolean){
    const profile=this.profile(id),ownership=this.ownership(id);
    if(!ownership||ownership.owner!=='agent'||ownership.identity!==runId||this.blocksAgent(id)||!permitted())throw new ProfileError('The active task no longer controls this computer.',409);
    if(this.operations.has(id)||this.peers(profile).some(peer=>this.operations.has(peer.id)))throw new ProfileError('A computer operation is still finishing.',409);
    this.operations.add(id);try{if(!permitted()||this.blocksAgent(id))throw new ProfileError('Computer control changed.',409);return await this.execute(profile,{...command,ownership});}finally{this.operations.delete(id);}
  }
  private execute(profile: AgentProfile, command: DesktopCommand) {
    if (profile.computer.machineId === 'local') return executeDesktopCommand(this.root, profile, command);
    if (!this.deps.remote) throw new ProfileError('This runner does not support desktop supervision. Update and reconnect it.', 409);
    return this.deps.remote(profile, command);
  }
  readOnlyStatus(id: string) {
    const profile=this.deps.getProfile(validId(id));if(!profile)throw new ProfileError('Agent profile not found.',404);
    const peer=this.peers(profile).find(peer=>this.leases.has(peer.id)),lease=this.leases.get(id)||(peer?this.leases.get(peer.id):undefined);
    const machine=this.deps.machine?.(profile.computer.machineId)||{id:profile.computer.machineId,name:profile.computer.machineId==='local'?'This computer':profile.computer.machineId,status:'online'};
    return {readOnly:true,agentActive:this.deps.isBusy(id),machine:{id:machine.id,name:machine.name,status:machine.status},controllerName:lease?this.deps.controllerName?.(lease.actorId)||'Workspace operator':'',ownershipState:lease?.state||'agent',inControlSince:lease?.since||'',available:isSandboxedComputer(profile.computer)&&profile.computer.desktop==='virtual',controlled:Boolean(lease),youControl:false,canRelease:false,ready:false,canContinue:false,leaseId:'',recording:false,steps:0,revision:0,browserSessionTeamId:'',teams:[],sharedWith:[],terminal:{available:false,ready:false}};
  }
  status(id: string) {
    const profile = this.deps.getProfile(validId(id));
    if (!profile) throw new ProfileError('Agent profile not found.', 404);
    const ownLease=this.leases.get(id),peer=this.peers(profile).find(peer=>this.leases.has(peer.id)),lease=ownLease||(peer?this.leases.get(peer.id):undefined);
    const machine=this.deps.machine?.(profile.computer.machineId)||{id:profile.computer.machineId,name:profile.computer.machineId==='local'?'This computer':profile.computer.machineId,status:'online'};
    return {machine,controllerAgentId:ownLease?id:peer?.id||'',ownershipState:lease?.state||'agent',controllerName:lease?this.deps.controllerName?.(lease.actorId)||'Workspace operator':'',inControlSince:lease?.since||'',browserSessionPreserved:Boolean(lease?.preserved),shellJobsStopped:Boolean(lease?.shellJobsStopped),terminal:{available:profile.computer.desktop==='virtual',ready:Boolean(ownLease?.ready&&machine.status==='online'),...(!lease?.ready?{reason:'Take control to open your workspace terminal.'}:{})},revocation:this.deps.revocation?.(id)||{state:'none'},ownership:this.ownership(id), available: isSandboxedComputer(profile.computer) && profile.computer.desktop === 'virtual', controlled: Boolean(lease),controllerId:lease?.actorId||'',youControl:Boolean(ownLease&&lease?.actorId===(this.deps.actor?.().id||'local-owner')),canRelease:Boolean(ownLease&&lease&&(lease.actorId===(this.deps.actor?.().id||'local-owner')||(this.deps.actor?.().role||'owner')==='owner')), leaseId: ownLease?.id || '', ready: Boolean(ownLease?.ready), canContinue: Boolean(this.deps.canContinue?.(id)), recording: Boolean(lease?.recording), steps: lease?.recording?.steps.length || 0, revision: profile.revision, browserSessionTeamId: profile.computer.browserSessionTeamId || '', teams: this.deps.listTeams().filter(team => !team.retiredAt && team.memberAgentIds.includes(id)).map(team => ({ id: team.id, name: team.name })), sharedWith: this.peers(profile).map(other => ({ id: other.id, name: other.name })) };
  }
  async dispatch(id: string, action: string, input: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (action === 'status') return this.status(id);
    const profile = this.profile(id, !['release', 'configure-sharing'].includes(action));
    if (this.operations.has(id)||this.peers(profile).some(peer=>this.operations.has(peer.id))) throw new ProfileError('A desktop request is still finishing. Try again in a moment.', 409);
    this.operations.add(id);
    try {
      if (action === 'take-control') {
        if (input.confirm !== true) throw new ProfileError('Confirm that active work will be stopped before taking control.');
        if (this.blocksAgent(id)) throw new ProfileError('A human control session already owns this browser. Release it first.', 409);
        if (this.peers(profile).some(peer => this.deps.isBusy(peer.id) || this.operations.has(peer.id))) throw new ProfileError('Another teammate is using this shared browser. Wait for it to finish.', 409);
        const lease:Lease={id:randomUUID(),ready:false,actorId:this.deps.actor?.().id||'local-owner',since:new Date().toISOString(),state:'taking-control',preserved:false,shellJobsStopped:false};
        this.leases.set(id, lease);
        this.persistOwnership();
        const ownership=await this.claim(profile,'human',lease.id);
        await this.deps.stopAgent(id);
        if (this.deps.isBusy(id)) throw new ProfileError('Agent cleanup is still in progress. Control is blocked until it stops.', 409);
        await this.execute(profile,{action:'stop',ownership});
        const key=desktopResourceKey(id,this.root,profile.computer),prior=this.sessions.get(key),result=await this.execute(profile,{action:'start',ownership});
        lease.preserved=Boolean(prior&&result.sessionId===prior);if(typeof result.sessionId==='string')this.sessions.set(key,result.sessionId);
        lease.ready=true;lease.state='human';lease.shellJobsStopped=true;
        return { ...this.status(id), leaseId: lease.id };
      }
      if (action === 'frame') return await this.execute(profile, { action: 'frame' });
      if (action === 'configure-sharing') {
        if (this.blocksAgent(id) || this.deps.isBusy(id) || this.peers(profile).some(peer => this.deps.isBusy(peer.id))) throw new ProfileError('Finish active work and release desktop control before changing shared logins.', 409);
        const teamId = String(input.teamId || '');
        if (teamId && input.consent !== true) throw new ProfileError('Confirm that opted-in teammates can access the same browser logins.');
        const next = { ...profile, revision: Number(input.revision), computer: { ...profile.computer, browserSessionTeamId: teamId || undefined } };
        this.validateSharing(next);
        if (this.peers(next).some(peer => this.deps.isBusy(peer.id) || this.leases.has(peer.id) || this.operations.has(peer.id))) throw new ProfileError('The selected team browser is busy. Try again when it is free.', 409);
        await this.execute(profile,{action:'reset'});
        this.deps.saveProfile(next);
        return this.status(id);
      }
      const lease = this.leases.get(id);
      if (!lease || input.leaseId !== lease.id) throw new ProfileError('Take control of this desktop before sending input.', 409);
      const actor=this.deps.actor?.()||{id:'local-owner',role:'owner'};if(actor.id!==lease.actorId&&!(actor.role==='owner'&&['release','record-stop'].includes(action)))throw new ProfileError('Another workspace member controls this desktop. Only that person can send input; an owner can finish the recording and release control.',403);
      if (!lease.ready && !['release','record-stop'].includes(action)) throw new ProfileError('Desktop startup did not finish. Release control before retrying.', 409);
      if (action === 'input') {
        const value = validateDesktopInput(input.input);
        if (lease.recording && lease.recording.steps.length >= 200) throw new ProfileError('This demonstration has reached 200 steps. Stop recording and review the draft.');
        await this.execute(profile,{action:'input',input:value,ownership:this.humanOwnership(id,lease.id,actor.id)});
        if (lease.recording) {
          lease.recording.steps.push(demonstrationStep(value));
          this.persistOwnership();
        }
        return { ok: true, steps: lease.recording?.steps.length || 0 };
      }
      if (action === 'record-start') { if (lease.recording) throw new ProfileError('A demonstration is already recording.', 409); lease.recording = { id: randomUUID(), steps: [], startedAt: new Date().toISOString() };this.persistOwnership(); return { ok: true, recording: true }; }
      if (action === 'record-stop') { const recording = lease.recording; if (!recording) throw new ProfileError('There is no demonstration to finish.', 409);const instructions=demonstrationDraft(recording.steps),saved=this.deps.onDraft?.(id,instructions);delete lease.recording;this.persistOwnership(); return { ok: true, draft:instructions,draftId:saved?.id,steps: recording.steps.length }; }
      if (action === 'release') {
        if (lease.recording) throw new ProfileError('Finish the demonstration and review its draft before releasing control.', 409);
        lease.ready=false;lease.state='handing-back';this.persistOwnership();
        const ownership=await this.claim(profile,'idle',lease.id);await this.execute(profile,{action:'stop',ownership});
        this.leases.delete(id);
        try { this.persistOwnership(); } catch (error) { this.leases.set(id, lease); throw error; }
        try{await this.deps.onReleased?.(id, input.continueWork === true);}catch(error){lease.ready=false;this.leases.set(id,lease);this.persistOwnership();throw error;}
        return { ok: true, controlled: false, shellJobsStopped:true };
      }
      throw new ProfileError('Unknown desktop action.', 404);
    } catch(error){const lease=this.leases.get(id);if(lease&&!lease.ready){lease.state='blocked';this.persistOwnership();}throw error;} finally { this.operations.delete(id); }
  }
}
