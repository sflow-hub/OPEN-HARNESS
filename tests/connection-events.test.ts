import test from 'node:test';
import assert from 'node:assert/strict';
import {Store} from '../runtime/db';
import {Profiles} from '../runtime/profiles';
import {Workspaces} from '../runtime/workspaces';
import {Connections} from '../runtime/connections';
import {Responsibilities} from '../runtime/responsibilities';
import {ConnectionEvents} from '../runtime/connection-events';
test('event cursors survive restart, deduplicate wakes, catch up on current sheet state, and honor pauses',async()=>{
  const store=new Store(':memory:');new Profiles(store.db);const workspace=new Workspaces(store.db,'/events');store.db.prepare("INSERT INTO agent_profiles VALUES('atlas',1,'{}')").run();let calls=0,values=[['first']];
  const secrets:Record<string,string>={SHEET_CREDENTIAL:JSON.stringify({access_token:'private-token',expires_at:Date.now()+3600000})},connections=new Connections(store.db,{environment:()=>secrets,set:(name,value)=>{secrets[name]=value;},delete:name=>{delete secrets[name];}},()=>workspace.actor(),(async()=>{calls++;return new Response(JSON.stringify({values}),{headers:{'Content-Type':'application/json'}});}) as typeof fetch);
  store.db.prepare('INSERT INTO app_connections VALUES(?,?,?,?,?,?,?,NULL,?,?,?)').run('sheet','sheets','test-account','local-owner','["atlas"]',JSON.stringify(['https://www.googleapis.com/auth/spreadsheets.readonly']),'connected','SHEET_CREDENTIAL',Date.now()+3600000,new Date().toISOString());
  const responsibilities=new Responsibilities(store.db,{actor:()=>workspace.actor(),createRun:()=>{throw new Error('No model is called by event delivery.');},canRun:()=>false}),goal=responsibilities.create({agentId:'atlas',title:'Pipeline report',goal:'Keep the approved report current'}),events=new ConnectionEvents(store.db,connections,responsibilities,()=>workspace.actor());
  events.create({connectionId:'sheet',responsibilityId:goal.id,resource:{spreadsheetId:'test-sheet',range:'Pipeline!A1:B5'},intervalSeconds:60});const start=Date.now();await events.tick(start);assert.equal(store.db.prepare('SELECT count(*) AS count FROM responsibility_events').get()!.count,0);
  values=[['second']];await events.tick(start+61000);assert.equal(store.db.prepare('SELECT count(*) AS count FROM responsibility_events').get()!.count,1);
  const restarted=new ConnectionEvents(store.db,connections,responsibilities,()=>workspace.actor());await restarted.tick(start+122000);assert.equal(store.db.prepare('SELECT count(*) AS count FROM responsibility_events').get()!.count,1);
  values=[['first']];await restarted.tick(start+183000);assert.equal(store.db.prepare('SELECT count(*) AS count FROM responsibility_events').get()!.count,2);
  const current=responsibilities.get(goal.id);responsibilities.update(goal.id,{revision:current.revision,state:'paused'});const before=calls;await restarted.tick(start+244000);assert.equal(calls,before);store.db.close();
});
