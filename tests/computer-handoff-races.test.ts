import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile';
import type { Team } from '../lib/team';
import { assertComputerOwnership, claimComputerOwnership, readComputerOwnership } from '../runtime/computer-ownership';
import { DesktopControl, executeDesktopCommand } from '../runtime/desktop-control';
function profile(id = 'atlas') { const value = draftProfile({ id, name: id, role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] }); value.computer.desktop = 'virtual'; value.computer.machineId = 'runner'; return value; }

test('shared desktop generations reject old controllers across agents and coordinator restarts', t => {
  const root = mkdtempSync(join(tmpdir(), 'computer-generation-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const atlas = profile(), scout = profile('scout'); atlas.computer.browserSessionTeamId = scout.computer.browserSessionTeamId = 'team';
  const old = { generation: 1, owner: 'agent' as const, identity: 'run-1' }, human = { generation: 2, owner: 'human' as const, identity: 'lease-2' };
  claimComputerOwnership(root, atlas, old); claimComputerOwnership(root, scout, human);
  assert.deepEqual(readComputerOwnership(root, atlas), human); assert.throws(() => assertComputerOwnership(root, atlas, old), /control changed/);
  assert.throws(() => claimComputerOwnership(root, atlas, old), /earlier controller/);
  assert.throws(() => claimComputerOwnership(root, atlas, { ...human, identity: 'another-lease' }), /earlier controller/);
  claimComputerOwnership(root, atlas, human); assertComputerOwnership(root, scout, human);
  scout.computer.machineId = 'different-runner'; assert.throws(() => assertComputerOwnership(root, scout, human), /control changed/);
});

test('old runner inputs stay rejected after takeover readiness and failed handback remains blocked', async t => {
  const root = mkdtempSync(join(tmpdir(), 'computer-handoff-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = process.env.OPEN_HARNESS_MOCK; process.env.OPEN_HARNESS_MOCK = '1'; t.after(() => { if (previous === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = previous; });
  const agent = profile(); let failStop = false, released = 0;
  const deps = { getProfile: (id: string) => id === agent.id ? agent : null, listProfiles: () => [agent], listTeams: () => [] as Team[], saveProfile: (value: typeof agent) => value, stopAgent: async () => {}, isBusy: () => false, remote: async (value: typeof agent, command: Parameters<typeof executeDesktopCommand>[2]) => { if (failStop && command.action === 'stop') throw new Error('Cleanup unconfirmed.'); return executeDesktopCommand(root, value, command); }, onReleased: () => { released++; } };
  const desktop = new DesktopControl(root, deps); await desktop.prepareRun(agent, 'old-run'); const old = desktop.ownership(agent.id)!;
  const lease = await desktop.dispatch(agent.id, 'take-control', { confirm: true }); assert.equal(lease.ready, true);
  await assert.rejects(executeDesktopCommand(root, agent, { action: 'input', input: { type: 'key', key: 'Enter' }, ownership: old }), /control changed/);
  failStop = true; await assert.rejects(desktop.dispatch(agent.id, 'release', { leaseId: lease.leaseId, continueWork: true }), /Cleanup unconfirmed/);
  assert.equal(desktop.status(agent.id).ready, false); assert.equal(desktop.status(agent.id).ownershipState, 'blocked'); assert.equal(desktop.canRun(agent), false); assert.equal(released, 0);
  const restored = new DesktopControl(root, deps); assert.equal(restored.canRun(agent), false); assert.equal(restored.status(agent.id).ready, false);
  failStop = false; await restored.dispatch(agent.id, 'release', { leaseId: lease.leaseId }); assert.equal(released, 1); assert.equal(restored.canRun(agent), true);
});

test('a shared-browser peer sees the controller without acquiring their terminal or lease', async t => {
  const root=mkdtempSync(join(tmpdir(),'computer-peer-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const atlas=profile(),scout=profile('scout');atlas.computer.browserSessionTeamId=scout.computer.browserSessionTeamId='team';
  const members=[atlas,scout],team={id:'team',name:'Team',memberAgentIds:['atlas','scout']} as Team;
  const desktop=new DesktopControl(root,{actor:()=>({id:'alice',role:'owner'}),getProfile:id=>members.find(item=>item.id===id)||null,listProfiles:()=>members,listTeams:()=>[team],saveProfile:value=>value,stopAgent:async()=>{},isBusy:()=>false,remote:async()=>({ok:true})});
  const control=await desktop.dispatch('atlas','take-control',{confirm:true}),peer=desktop.status('scout');
  assert.equal(control.youControl,true);assert.equal(desktop.status('atlas').terminal.ready,true);
  assert.equal(peer.controlled,true);assert.equal(peer.controllerAgentId,'atlas');assert.equal(peer.controllerId,'alice');
  assert.equal(peer.youControl,false);assert.equal(peer.canRelease,false);assert.equal(peer.ready,false);assert.equal(peer.terminal.ready,false);assert.equal(peer.leaseId,'');
  assert.throws(()=>desktop.humanOwnership('scout',String(control.leaseId),'alice'),/current controller/);
  await assert.rejects(desktop.dispatch('scout','take-control',{confirm:true}),/shared|control|use/i);
  team.memberAgentIds=['scout'];assert.throws(()=>desktop.humanOwnership('atlas',String(control.leaseId),'alice'),/membership/);
});
