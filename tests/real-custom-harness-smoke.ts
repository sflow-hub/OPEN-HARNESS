import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { installCustomPackage } from '../runtime/harness-registry';
import { testHarnessInstallation } from '../runtime/agent-assets';
import { draftProfile } from '../lib/agent-profile';
import { prepareProfile } from '../runtime/profile-runtime';
import { createAgentRuntime } from '../runtime/agent-runtime';
import { stopManagedContainers } from '../runtime/hermes';
if(process.env.OPEN_HARNESS_MOCK==='1')throw new Error('Use real Docker, without mock mode.');
const root=resolve(process.env.OPEN_HARNESS_ACCEPTANCE_STATE||'.open-harness-custom-acceptance');mkdirSync(root,{recursive:true});
try{
  const output=join(root,'echo.zip'),packaged=spawnSync('python3',['examples/harness/package.py','--image','node:22-alpine','--output',output],{encoding:'utf8',timeout:120000});if(packaged.status!==0)throw new Error(packaged.stderr||'Package creation failed.');
  const item=await installCustomPackage(root,output,100*1024**3);await testHarnessInstallation(root,item,crypto.randomUUID());
  const profile=draftProfile({id:`custom-check-${process.pid}`,name:'Custom check',role:'Fixture',description:'',tone:0,instructions:'',memory:[]});profile.harness={kind:item.kind,version:item.version};profile.allowedTools=[];
  prepareProfile(root,profile,{provider:'local',model:'echo',credentialRef:'',baseUrl:''},{environment:()=>({})},'','custom-fixture');const runtime=await createAgentRuntime(root,profile,[]);
  try{await runtime.start();const session=await runtime.request('session.create',{cwd:'/workspace/private'});const result=await runtime.submitPrompt(session.session_id,'CUSTOM_PACKAGE_PROOF');assert.equal(result.text,'Echo harness: CUSTOM_PACKAGE_PROOF');}finally{await runtime.stop();}
  const evidence={ok:true,kind:item.kind,version:item.version,image:item.image,paidInference:false,root};writeFileSync(join(root,'result.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await stopManagedContainers(root);}
