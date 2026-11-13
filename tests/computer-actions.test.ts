import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../runtime/db';
import { ToolReviews } from '../runtime/tool-reviews';
import { ComputerActions } from '../runtime/computer-actions';

function fixture(){const store=new Store(':memory:'),stamp=new Date().toISOString();store.createRun({id:'run',agent_id:'atlas',conversation_id:'conversation',prompt:'Use the private browser.',state:'running',depth:0,parent_run_id:null,session_id:null,result:null,error:null,created_at:stamp,updated_at:stamp});const reviews=new ToolReviews(store,()=>{}),actions=new ComputerActions(store,reviews,'private-key');return {store,reviews,actions,approve:()=>store.db.prepare("UPDATE approvals SET state='approve' WHERE run_id='run'").run()};}
test('computer broker reviews mutation, omits typed values, and executes an approved identity only once',async()=>{
  const f=fixture();let calls=0;try{const input={action:'input',requestId:randomUUID(),input:{type:'text',text:'private-code-123'}},execute=async()=>{calls++;return {ok:true};};
    assert.equal((await f.actions.call('run',input,()=>true,execute)).state,'pending');assert.equal(calls,0);
    assert.doesNotMatch(JSON.stringify(f.store.pendingApprovals('run')),/private-code-123/);f.approve();
    assert.equal((await f.actions.call('run',input,()=>true,execute)).ok,true);assert.equal(calls,1);
    assert.equal((await f.actions.call('run',input,()=>true,execute)).receipt,true);assert.equal(calls,1);
    await assert.rejects(f.actions.call('run',{...input,input:{type:'text',text:'different'}},()=>true,execute),/another request/);
  }finally{f.store.db.close();}
});
test('computer approval cannot outlive ownership and captures require current permission',async()=>{
  const f=fixture();try{const input={action:'navigate',requestId:randomUUID(),url:'https://example.com/path?private=value'};let calls=0;const execute=async()=>{calls++;return {ok:true};};
    await f.actions.call('run',input,()=>true,execute);assert.doesNotMatch(JSON.stringify(f.store.pendingApprovals('run')),/private=value/);f.approve();
    await assert.rejects(f.actions.call('run',input,()=>false,execute),/permission/);assert.equal(calls,0);
    await assert.rejects(f.actions.call('run',{action:'capture'},()=>false,execute),/permission/);
    await f.actions.call('run',{action:'capture'},()=>true,execute);assert.equal(calls,1);
  }finally{f.store.db.close();}
});
test('a failed computer action is never replayed by retries or restart',async()=>{
  const f=fixture();try{const input={action:'navigate',requestId:randomUUID(),url:'https://example.com'},execute=async()=>{throw new Error('Connection lost after dispatch.');};
    await f.actions.call('run',input,()=>true,execute);f.approve();await assert.rejects(f.actions.call('run',input,()=>true,execute),/Connection lost/);
    const resumed=new ComputerActions(f.store,f.reviews,'private-key');await assert.rejects(resumed.call('run',input,()=>true,async()=>{assert.fail('replayed');}),/uncertain outcome/);
    assert.equal(f.reviews.list('run')[0].state,'uncertain');
  }finally{f.store.db.close();}
});
test('concurrent retries cannot dispatch the same approved input twice',async()=>{
  const f=fixture();try{const input={action:'input',requestId:randomUUID(),input:{type:'key',key:'Enter'}};let finish!:(value:Record<string,unknown>)=>void;const execute=()=>new Promise<Record<string,unknown>>(resolve=>{finish=resolve;});
    await f.actions.call('run',input,()=>true,execute);f.approve();const first=f.actions.call('run',input,()=>true,execute);
    await assert.rejects(f.actions.call('run',input,()=>true,execute),/already in progress/);finish({ok:true});await first;
  }finally{f.store.db.close();}
});
test('staging an upload requires review and returns only a bounded container path on first delivery and retry',async()=>{
  const f=fixture();try{const input={action:'stage-upload',fileName:'proposal.txt',requestId:randomUUID()},file={name:'proposal.txt',path:'/workspace/exchange/uploads/0123456789abcdef-proposal.txt',bytes:12};let calls=0;
    const execute=async(command:Record<string,unknown>)=>{calls++;assert.equal(command.fileName,'proposal.txt');return {ok:true,...file,secret:'never returned'};};
    assert.equal((await f.actions.call('run',input,()=>true,execute)).state,'pending');assert.equal(calls,0);
    assert.match(JSON.stringify(f.store.pendingApprovals('run')),/current contents of proposal.txt/);assert.match(JSON.stringify(f.store.pendingApprovals('run')),/does not submit/);f.approve();
    assert.deepEqual(await f.actions.call('run',input,()=>true,execute),{ok:true,...file});
    const restarted=new ComputerActions(f.store,f.reviews,'private-key');assert.deepEqual(await restarted.call('run',input,()=>true,execute),{ok:true,...file,receipt:true});assert.equal(calls,1);
    await assert.rejects(f.actions.call('run',{...input,fileName:'../secret'},()=>true,execute),/ordinary file name/);
    await assert.rejects(f.actions.call('run',{...input,fileName:'different.txt'},()=>true,execute),/another request/);
  }finally{f.store.db.close();}
});
test('upload result never reflects host paths or unchecked runner details',async()=>{
  const f=fixture();try{const input={action:'stage-upload',fileName:'file.txt',requestId:randomUUID()};await f.actions.call('run',input,()=>true,async()=>({}));f.approve();
    await assert.rejects(f.actions.call('run',input,()=>true,async()=>({name:'file.txt',bytes:1,path:'/etc/passwd'})),/invalid upload/);
    await assert.rejects(f.actions.call('run',input,()=>true,async()=>({})),/uncertain outcome/);
  }finally{f.store.db.close();}
});
