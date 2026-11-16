import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const managed='/run/open-harness', config=JSON.parse(readFileSync(`${managed}/runtime-command.json`,'utf8'));
const env={...process.env};let temporary='';
const environment='/home/hermes/.hermes/.env';
if(existsSync(environment))for(const line of readFileSync(environment,'utf8').split('\n')){const i=line.indexOf('=');if(i>0)env[line.slice(0,i)]=JSON.parse(line.slice(i+1));}
env.OPEN_HARNESS_POLICY=`${managed}/policy.json`;
env.OPEN_HARNESS_RUN_LEASE=`${managed}/run-lease.json`;
env.OPEN_HARNESS_CONFIG_DIRECTORY=config.configRevision?`/workspace/harness-config/${config.configRevision}`:'/workspace/harness-config';
if(config.opencode){env.OPENCODE_CONFIG_CONTENT=JSON.stringify(config.opencode);env.OPENCODE_DISABLE_PROJECT_CONFIG='true';env.OPENCODE_DISABLE_AUTOUPDATE='true';
  // OpenCode imports plugins from its config folder, ~/.opencode and its package cache, and runs
  // tools it downloaded into its data folder (rg, language servers), all ahead of the managed
  // policy. Every one of them is created fresh for this launch and removed afterwards, so nothing
  // the agent wrote in an earlier run is executed. Runs start with session/new, so nothing is lost.
  env.OPENCODE_DISABLE_DEFAULT_PLUGINS='true';const launch=temporary=mkdtempSync(join(tmpdir(),'open-harness-opencode-'));
  for(const [name,folder] of [['HOME','home'],['XDG_CONFIG_HOME','config'],['XDG_DATA_HOME','data'],['XDG_CACHE_HOME','cache'],['XDG_STATE_HOME','state'],['BUN_INSTALL','bun'],['BUN_INSTALL_CACHE_DIR','bun-cache'],['npm_config_cache','npm-cache']])env[name]=join(launch,folder);
  mkdirSync(env.HOME,{recursive:true});
}
const child=spawn(config.command[0],config.command.slice(1),{env,stdio:'inherit'});
const done=code=>{if(temporary)rmSync(temporary,{recursive:true,force:true});process.exit(code);};
child.on('error',()=>done(1));child.on('exit',code=>done(code??1));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
