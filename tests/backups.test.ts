import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {Store} from '../runtime/db';
import {Profiles} from '../runtime/profiles';
import {Workspaces} from '../runtime/workspaces';
import {Responsibilities} from '../runtime/responsibilities';
import {createBackup,restoreBackup,generateBackupKey,portableBackupPath} from '../runtime/backups';

test('encrypted workspace migration preserves artifacts and revisions, omits credentials, and pauses work',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'oh-backups-')),root=join(folder,'source'),target=join(folder,'restored'),archive=join(folder,'workspace.ohb');await mkdir(root);const store=new Store(join(root,'state.db')),profiles=new Profiles(store.db),workspace=new Workspaces(store.db,root);
  try{
    const profile=profiles.import({id:'atlas',name:'Atlas',role:'Assistant',description:'',instructions:'Preserve these instructions.',tone:0,memory:[]});assert.ok(profile);
    const responsibilities=new Responsibilities(store.db,{actor:()=>workspace.actor(),createRun:()=>{throw new Error('unused');},canRun:()=>false});responsibilities.create({agentId:profile.id,title:'Daily report',goal:'Keep the report current'});
    store.db.exec("CREATE TABLE machine_pairings(id TEXT PRIMARY KEY,code_hash TEXT); INSERT INTO machine_pairings VALUES('pending','old-code-hash'); CREATE TABLE machines(id TEXT PRIMARY KEY,revoked_at TEXT,credential_hash TEXT,status TEXT); INSERT INTO machines VALUES('remote',NULL,'old-machine-key','online'); CREATE TABLE workflow_routines(workflow_id TEXT PRIMARY KEY,enabled INTEGER,webhook_hash TEXT); INSERT INTO workflow_routines VALUES('routine',1,'old-hook-hash')");
    store.db.exec("CREATE TABLE terminal_permission_revocations(id TEXT PRIMARY KEY); INSERT INTO terminal_permission_revocations VALUES('old-machine-cleanup'); CREATE TABLE cli_cleanup_commands(agent_id TEXT PRIMARY KEY); INSERT INTO cli_cleanup_commands VALUES('atlas'); CREATE TABLE desktop_continuations(agent_id TEXT PRIMARY KEY); INSERT INTO desktop_continuations VALUES('atlas')");
    await mkdir(join(root,'shared'),{recursive:true});await mkdir(join(root,'agents/atlas/profile/memories'),{recursive:true});await mkdir(join(root,'agents/atlas/private/.config/chromium'),{recursive:true});
    await writeFile(join(root,'shared/report.md'),'Verified report');await writeFile(join(root,'secrets.json'),'operator-token-never-export');await writeFile(join(root,'agents/atlas/profile/.env'),'API_KEY=never-export');await writeFile(join(root,'agents/atlas/private/.config/chromium/Cookies'),'login-never-export');await writeFile(join(root,'agents/atlas/profile/memories/MEMORY.md'),'Remember this preference.');
    const key=generateBackupKey(),result=await createBackup({root,target:archive,key,workspaceId:workspace.id});assert.ok(result.files>=3);if(process.platform!=='win32')assert.equal((await stat(archive)).mode&0o777,0o600);assert.ok(!(await readFile(archive)).includes(Buffer.from('Verified report')));
    const restored=await restoreBackup({archive,target,key,workspaceId:'destination-workspace',edition:'managed'});assert.equal(restored.reauthorizationRequired,true);assert.equal(await readFile(join(target,'shared/report.md'),'utf8'),'Verified report');assert.equal(await readFile(join(target,'agents/atlas/profile/memories/MEMORY.md'),'utf8'),'Remember this preference.');await assert.rejects(stat(join(target,'secrets.json')));await assert.rejects(stat(join(target,'agents/atlas/profile/.env')));await assert.rejects(stat(join(target,'agents/atlas/private/.config/chromium/Cookies')));
    const saved=new Store(join(target,'state.db'));try{assert.equal((saved.db.prepare('SELECT id FROM workspace_identity').get()!).id,'destination-workspace');assert.equal((saved.db.prepare('SELECT state FROM responsibilities').get()!).state,'paused');assert.equal((saved.db.prepare('SELECT count(*) AS count FROM machine_pairings').get()!).count,0);assert.equal((saved.db.prepare('SELECT credential_hash FROM machines WHERE id=\'remote\'').get()!).credential_hash,null);assert.equal((saved.db.prepare('SELECT webhook_hash FROM workflow_routines').get()!).webhook_hash,null);assert.equal(new Profiles(saved.db).get('atlas')?.revision,profile.revision);assert.equal((saved.db.prepare('SELECT count(*) AS count FROM profile_revisions').get()!).count,1);}finally{saved.db.close();}
    const restoredState=new Store(join(target,'state.db'));try{for(const table of ['terminal_permission_revocations','cli_cleanup_commands','desktop_continuations'])assert.equal(restoredState.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count,0,table);}finally{restoredState.db.close();}
    await assert.rejects(restoreBackup({archive,target,key}),/new folder/);const bad=join(folder,'bad-key-target');await assert.rejects(restoreBackup({archive,target:bad,key:generateBackupKey()}),/authenticated/);await assert.rejects(stat(bad));
    const damaged=Buffer.from(await readFile(archive));damaged[25]^=1;const corrupt=join(folder,'corrupt.ohb');await writeFile(corrupt,damaged);await assert.rejects(restoreBackup({archive:corrupt,target:join(folder,'corrupt-target'),key}),/authenticated/);
    for(const path of ['secrets.json','shared/../secret','agents/atlas/profile/.env','agents/atlas/private/.ssh/id_rsa','shared/.env.local','agents/atlas/private/.git/config'])assert.equal(portableBackupPath(path),false,path);
  }finally{store.db.close();await rm(folder,{recursive:true,force:true});}
});
