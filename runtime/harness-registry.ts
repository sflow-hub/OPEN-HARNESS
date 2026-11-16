import { validateImageArchive } from './image-archive';
import { mkdirSync, readdirSync, readFileSync, existsSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HERMES_RELEASE } from '../lib/hermes-pin';
import { FALLBACK_HARNESSES, harnessOf, groupSupported, type HarnessChoice, type HarnessInfo, type HarnessKind } from '../lib/harness';
import type { AgentProfile, ModelChoice, ToolInfo } from '../lib/agent-profile';
import { HERMES_IMAGE, RUNTIME_LABEL, RUNTIME_CONTRACT } from './readiness';
import { commandAsync } from './commands';
import { validateManifest, type HarnessManifest } from './harness-manifest';
import { ProfileError } from './profiles';
import { atomicWorkspaceWrite, safeWorkspacePath } from './path-safety';
import { fileDigest } from './agent-files';
import { extractHarnessZip } from './package-zip';

export const OPENCODE_VERSION = '1.2.27';
export const OPENCODE_IMAGE = `docker.io/library/open-harness-opencode:${OPENCODE_VERSION}-acp1`;
export type HarnessInstallation = { kind: HarnessKind; version: string; image: string; command: string[]; protocol: 'hermes'|'acp/v1'|'open-harness-runtime/v1'; manifest?: HarnessManifest; tested: boolean; expandedBytes?: number };
export function installations(root: string): HarnessInstallation[] {
  const base=join(root,'harnesses');if(!existsSync(base))return [];
  const values:HarnessInstallation[]=[];
  for(const id of readdirSync(base))for(const version of readdirSync(safeWorkspacePath(base,id))){const path=safeWorkspacePath(base,`${id}/${version}/installation.json`);if(existsSync(path))values.push(JSON.parse(readFileSync(path,'utf8')));}
  return values;
}
export function installationBytes(root:string){return installations(root).reduce((n,item)=>n+(item.expandedBytes||0),0);}
export function resolveInstallation(root: string, choice: HarnessChoice): HarnessInstallation {
  if(choice.kind==='hermes'){if(choice.version&&choice.version!==HERMES_RELEASE)throw new ProfileError('This Hermes version is unavailable. Select the installed version.',409);return {kind:'hermes',version:HERMES_RELEASE,image:HERMES_IMAGE,command:[],protocol:'hermes',tested:true};}
  const matches=installations(root).filter(i=>i.kind===choice.kind&&i.tested&&(!choice.version||i.version===choice.version));
  const found=matches.at(-1);if(!found)throw new ProfileError('Install and test this harness on the assigned computer before running it.',409);return found;
}
export async function harnessCatalog(root: string): Promise<HarnessInfo[]> {
  const mock=process.env.OPEN_HARNESS_MOCK==='1',docker=mock?{status:0}:await commandAsync('docker',['version','--format','{{.Server.Version}}'],5000);
  const list=installations(root),out:HarnessInfo[]=[];
  for(const base of FALLBACK_HARNESSES){const versions=base.kind==='hermes'?[HERMES_RELEASE]:list.filter(i=>i.kind===base.kind&&i.tested).map(i=>i.version);const image=base.kind==='hermes'?HERMES_IMAGE:list.find(i=>i.kind===base.kind&&i.tested)?.image;const inspected=docker.status===0&&image?(mock?{status:0,stdout:String(RUNTIME_CONTRACT),stderr:''}:await commandAsync('docker',['image','inspect','-f',base.kind==='hermes'?`{{index .Config.Labels \"${RUNTIME_LABEL}\"}}`:'{{.Id}}',image],5000)):{status:1,stdout:'',stderr:''};const available=inspected.status===0&&(base.kind!=='hermes'||inspected.stdout.trim()===String(RUNTIME_CONTRACT));out.push({...base,version:versions.at(-1)||(base.kind==='opencode'?OPENCODE_VERSION:''),versions,available,reason:available?undefined:docker.status!==0?'Docker is not responding.':base.kind==='hermes'?(inspected.status===0||/no such image/i.test(inspected.stderr)?'Finish Hermes setup in Workspace settings → Run setup again.':'Docker could not verify the Hermes image. Check that Docker is responding.'):'Install and test this harness on this computer.',providers:base.kind==='hermes'?[]:[...base.providers,...(mock?['mock']:[])],features:{...base.features}});}
  const kinds=[...new Set(list.filter(i=>i.manifest).map(i=>i.kind))];
  for(const kind of kinds){const entries=list.filter(i=>i.kind===kind&&i.tested),item=entries.at(-1);if(!item?.manifest)continue;const present=mock?{status:0}:await commandAsync('docker',['image','inspect',item.image],5000);const m=item.manifest;out.push({kind,label:m.name,description:'Custom managed harness',version:m.version,versions:entries.map(i=>i.version),license:m.license,available:present.status===0,features:m.features,providers:m.providers});}
  return out;
}
export function validateHarnessCapabilities(profile: AgentProfile, effective: ModelChoice, info: HarnessInfo) {
  if(info.providers.length&&!info.providers.includes(effective.provider))throw new ProfileError(`${info.label} does not support ${effective.provider}. Choose another model provider.`,409);
  if(profile.computer.desktop!=='none'&&!info.features.desktop)throw new ProfileError(`${info.label} does not support a private desktop.`,409);
  if(!info.features.mcp&&profile.connectors.some(c=>c.enabled))throw new ProfileError(`${info.label} does not support MCP connections.`,409);
  if(harnessOf(profile).kind!=='hermes'&&effective.provider==='openai-codex')throw new ProfileError('ChatGPT sign-in is supported only by the managed Hermes adapter.',409);
}
export function harnessToolCatalog(tools:ToolInfo[],info:HarnessInfo){return tools.filter(t=>groupSupported(t.group,info));}
export async function installCustomPackage(root:string,source:string,quota:number):Promise<HarnessInstallation>{
  const base=join(root,'harness-staging',randomUUID());mkdirSync(base,{recursive:true,mode:0o700});
  try{const names=await extractHarnessZip(source,base,quota),manifestPath=safeWorkspacePath(base,'harness.json');if(!existsSync(manifestPath)||names.length>10001)throw new Error('Package is missing harness.json.');if(statSync(manifestPath).size>1000000)throw new Error('Harness manifest is too large.');const m=validateManifest(JSON.parse(readFileSync(manifestPath,'utf8')));
    if(!m.architecture.includes(process.arch))throw new Error(`This package does not support ${process.arch}.`);
    for(const name of names){if(name==='harness.json')continue;if(!m.files[name]||await fileDigest(safeWorkspacePath(base,name))!==m.files[name])throw new Error(`Package checksum failed: ${name}`);}
    if(Object.keys(m.files).some(name=>!names.includes(name)))throw new Error('Package payload is incomplete.');
    const destination=safeWorkspacePath(root,`harnesses/${m.id}/${m.version}`);if(existsSync(destination)){const old=JSON.parse(readFileSync(join(destination,'installation.json'),'utf8')) as HarnessInstallation;if(JSON.stringify(old.manifest)!==JSON.stringify(m))throw new ProfileError('This harness version is immutable. Publish a new version instead.',409);return old;}
    if(m.imageArchive)await validateImageArchive(safeWorkspacePath(base,m.imageArchive));
    if(process.env.OPEN_HARNESS_MOCK!=='1'){const result=m.imageArchive?await loadUntagged(safeWorkspacePath(base,m.imageArchive)):await commandAsync('docker',['pull',m.image],3600000);if(result.status!==0)throw new Error(result.stderr||'Harness image installation failed.');const verified=await commandAsync('docker',['image','inspect','-f','{{json .RepoDigests}}',m.image],10000);if(verified.status!==0||(!m.image.startsWith('sha256:')&&!JSON.parse(verified.stdout).includes(m.image)))throw new Error('The installed image does not match the package digest.');}
    if(process.env.OPEN_HARNESS_MOCK!=='1'){const platform=await commandAsync('docker',['image','inspect','-f','{{.Architecture}} {{.Os}}',m.image],10000),expected=({x64:'amd64',arm64:'arm64'} as Record<string,string>)[process.arch];if(platform.status!==0||platform.stdout.trim()!==expected+' linux')throw new ProfileError('The package image does not match this computer’s architecture or Linux container platform.',409);}
    const image=process.env.OPEN_HARNESS_MOCK==='1'?m.image:await imageIdentity(m.image);
    const value:HarnessInstallation={kind:`custom:${m.id}`,version:m.version,image,command:m.command,protocol:m.protocol,manifest:m,tested:false,expandedBytes:names.reduce((n,name)=>n+statSync(safeWorkspacePath(base,name)).size,0)};
    atomicWorkspaceWrite(join(base,'installation.json'),JSON.stringify(value));mkdirSync(join(root,'harnesses',m.id),{recursive:true,mode:0o700});renameSync(base,destination);return value;
  }finally{rmSync(base,{recursive:true,force:true});}
}
async function imageTags(){const r=await commandAsync('docker',['image','ls','--no-trunc','--format','{{.Repository}}:{{.Tag}} {{.ID}}'],60000);if(r.status!==0)throw new Error('Docker could not list its images, so the harness image was not loaded.');return new Map(r.stdout.split('\n').filter(line=>line&&!line.includes('<none>')).map(line=>line.split(' ') as [string,string]));}
// The archive check already refuses tags; this catches a parser disagreement with Docker after the
// fact. A load that names any image is undone, so it cannot take over another agent's runtime tag.
export async function loadUntagged(archive:string){
  const before=await imageTags(),result=await commandAsync('docker',['load','-i',archive],3600000);if(result.status!==0)return result;
  const after=await imageTags(),named=[...result.stdout.matchAll(/^Loaded image: (\S+)$/gm)].map(match=>match[1]),moved=[...before].filter(([tag,id])=>after.get(tag)!==undefined&&after.get(tag)!==id);
  if(!named.length&&!moved.length)return result;
  for(const [tag,id] of moved)await commandAsync('docker',['tag',id,tag],10000);
  for(const tag of named.filter(tag=>!before.has(tag)&&!before.has(`docker.io/library/${tag}`)))await commandAsync('docker',['image','rm','--no-prune',tag],30000);
  throw new ProfileError('This harness image archive tried to name or replace a Docker image. Its tags were removed and existing images were restored. Export the image without repository tags and upload it again.',409);
}
export async function imageIdentity(image:string){const result=await commandAsync('docker',['image','inspect','-f','{{.Id}}',image],10000);if(result.status!==0||!/^sha256:[a-f0-9]{64}$/.test(result.stdout.trim()))throw new Error('Docker could not verify the harness image. '+(result.stderr||result.error?.message||'').trim());return result.stdout.trim();}
export function saveInstallation(root:string,item:HarnessInstallation){const id=item.kind==='opencode'?'opencode':item.kind.replace('custom:','');const dir=safeWorkspacePath(root,`harnesses/${id}/${item.version}`);mkdirSync(dir,{recursive:true,mode:0o700});atomicWorkspaceWrite(join(dir,'installation.json'),JSON.stringify(item));}
export async function installOpenCode(root:string){
  const existing=installations(root).find(i=>i.kind==='opencode'&&i.version===OPENCODE_VERSION);if(existing){if(process.env.OPEN_HARNESS_MOCK!=='1')await imageIdentity(existing.image);return existing;}
  if(process.env.OPEN_HARNESS_MOCK!=='1'){const dockerfile=`FROM ${HERMES_IMAGE}\nUSER root\nRUN npm install -g opencode-ai@${OPENCODE_VERSION}\n`;const result=await commandAsync('docker',['build','-t',OPENCODE_IMAGE,'-'],3600000,{input:dockerfile});if(result.status!==0)throw new Error(result.stderr||'OpenCode installation failed.');}
  const image=process.env.OPEN_HARNESS_MOCK==='1'?OPENCODE_IMAGE:await imageIdentity(OPENCODE_IMAGE);
  if(process.env.OPEN_HARNESS_MOCK!=='1'){const pinned=await commandAsync('docker',['tag',image,`${OPENCODE_IMAGE}-${image.slice(7,19)}`],10000);if(pinned.status!==0)throw new Error('Docker could not retain the immutable OpenCode image.');}
  const value:HarnessInstallation={kind:'opencode',version:OPENCODE_VERSION,image,command:['opencode','--print-logs','acp'],protocol:'acp/v1',tested:false};saveInstallation(root,value);return value;
}
