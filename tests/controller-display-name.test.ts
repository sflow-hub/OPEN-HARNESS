import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Store } from '../runtime/db';
import { Workspaces, actorContext } from '../runtime/workspaces';
import { accountDisplayName } from '../lib/display-name';

test('controller names remain plain display text with bounded length and no control characters',()=>{
  assert.equal(accountDisplayName('  Zoë 李  '),'Zoë 李');assert.equal(accountDisplayName('x'.repeat(100)),'x'.repeat(100));
  for(const value of [null,{},'', 'x'.repeat(101),'Alice\nOwner','Alice\u0000','Alice\u202e','Alice\u2066'])assert.equal(accountDisplayName(value),undefined);
  const name=accountDisplayName('<Alice & Bob>');assert.equal(name,'<Alice & Bob>');assert.equal(renderToStaticMarkup(createElement('span',null,name)),'<span>&lt;Alice &amp; Bob&gt;</span>');
});

test('only verified relay display names are saved without changing identity or old-relay compatibility',async t=>{
  const store=new Store(':memory:'),workspace=new Workspaces(store.db,'/fixture/display-name'),pair=await generateKeyPair('EdDSA'),rogue=await generateKeyPair('EdDSA');
  const oldKey=process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK,oldIssuer=process.env.OPEN_HARNESS_RELAY_ISSUER;
  process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK=JSON.stringify(await exportJWK(pair.publicKey));process.env.OPEN_HARNESS_RELAY_ISSUER='https://identity.example';
  t.after(()=>{if(oldKey===undefined)delete process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK;else process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK=oldKey;if(oldIssuer===undefined)delete process.env.OPEN_HARNESS_RELAY_ISSUER;else process.env.OPEN_HARNESS_RELAY_ISSUER=oldIssuer;store.db.close();});
  const issue=(displayName?:unknown,subject='alice',role='operator',key=pair.privateKey)=>new SignJWT({workspaceId:workspace.id,role,...(displayName===undefined?{}:{displayName})}).setSubject(subject).setIssuer('https://identity.example').setAudience(`open-harness:${workspace.id}`).setIssuedAt().setExpirationTime('30s').setProtectedHeader({alg:'EdDSA'}).sign(key);
  assert.equal(workspace.controllerName('local-owner'),'You');await workspace.relayActor(await issue());assert.equal(workspace.controllerName('alice'),'Workspace operator');
  const actor=await workspace.relayActor(await issue('Alice & Bob'));assert.deepEqual(actor,{id:'alice',workspaceId:workspace.id,role:'operator',source:'oidc'});assert.equal(workspace.controllerName('alice'),'Alice & Bob');
  assert.equal(new Workspaces(store.db,'/fixture/display-name').controllerName('alice'),'Alice & Bob');
  await workspace.relayActor(await issue());assert.equal(workspace.controllerName('alice'),'Alice & Bob','An older relay does not erase a verified saved name');
  await workspace.relayActor(await issue('Invalid\nname'));assert.equal(workspace.controllerName('alice'),'Alice & Bob');
  await assert.rejects(workspace.relayActor(await issue('Forged name','alice','owner',rogue.privateKey)),/identity/);assert.equal(workspace.controllerName('alice'),'Alice & Bob');assert.equal(workspace.memberActor('alice').role,'operator');
  const viewer=await workspace.relayActor(await issue('Workspace owner','viewer','viewer'));actorContext.run(viewer,()=>{assert.throws(()=>workspace.requireWrite(),/read-only/);assert.equal(workspace.controllerName('local-owner'),'Workspace owner');});
});
