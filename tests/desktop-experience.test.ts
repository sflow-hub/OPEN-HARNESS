import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile';
import type { Team } from '../lib/team';
import { browserSessionMount, containerSignature } from '../runtime/hermes';
import { DesktopControl, demonstrationDraft, demonstrationStep, executeDesktopCommand, validateDesktopInput } from '../runtime/desktop-control';
import { Store } from '../runtime/db';
import { Profiles, validateProfile } from '../runtime/profiles';
import { TeamStore } from '../runtime/teams';

const agent = (id = 'atlas') => { const profile = draftProfile({ id, name: id, role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] }); profile.computer.desktop = 'virtual'; profile.computer.machineId = 'runner'; return profile; };
const team = { id: 'ops', name: 'Ops', memberAgentIds: ['atlas', 'scout'], retiredAt: null } as Team;
const fixtureRoots: string[] = [];
test.after(() => { for (const root of fixtureRoots) rmSync(root, { recursive: true, force: true }); });
function fixture(options: { root?: string; stop?: () => Promise<void>; remote?: (action: string) => Promise<Record<string, unknown>>; canContinue?: (id: string) => boolean;actor?:()=>{id:string;role:string} } = {}) {
  const profiles = [agent(), agent('scout')], busy = new Set<string>(), commands: string[] = [], released: boolean[] = [];
  const root = options.root || mkdtempSync(join(tmpdir(), 'harness-desktop-control-')); fixtureRoots.push(root);
  const desktop = new DesktopControl(root, {
    getProfile: id => profiles.find(profile => profile.id === id) || null, listProfiles: () => profiles, listTeams: () => [team],
    saveProfile: profile => { const next = { ...profile, revision: profile.revision + 1 }; profiles[profiles.findIndex(item => item.id === profile.id)] = next; return next; },
    isBusy: id => busy.has(id), stopAgent: async id => { commands.push('stop-agent'); await options.stop?.(); busy.delete(id); },
    canContinue: options.canContinue,actor:options.actor,
    remote: async (_profile, input) => { commands.push(input.action); return await options.remote?.(input.action) || { ok: true }; },
    onReleased: (_id, resume) => { released.push(resume); },
  });
  return { desktop, profiles, busy, commands, released, root };
}

test('human ownership survives coordinator restart without persisting screenshots or recorded values', async () => {
  const f = fixture(), lease = await f.desktop.dispatch('atlas', 'take-control', { confirm: true });
  await f.desktop.dispatch('atlas', 'record-start', { leaseId: lease.leaseId });
  await f.desktop.dispatch('atlas', 'input', { leaseId: lease.leaseId, input: { type: 'text', text: 'private-password-value' } });
  const saved = readFileSync(join(f.root, 'desktop-control.json'), 'utf8');
  assert.doesNotMatch(saved, /private-password-value|"image"/);
  if (process.platform !== 'win32') assert.equal(statSync(join(f.root, 'desktop-control.json')).mode & 0o777, 0o600);
  const restarted = fixture({ root: f.root }), status = restarted.desktop.status('atlas');
  assert.equal(restarted.desktop.canRun(restarted.profiles[0]), false);
  assert.equal(status.controlled, true); assert.equal(status.ready, false); assert.equal(status.recording, true);
  await assert.rejects(restarted.desktop.dispatch('atlas', 'input', { leaseId: lease.leaseId, input: { type: 'key', key: 'Enter' } }), /Release control/);
  const finished=await restarted.desktop.dispatch('atlas','record-stop',{leaseId:status.leaseId});assert.equal(finished.steps,1);assert.match(String(finished.draft),/Typed text was omitted/);assert.doesNotMatch(String(finished.draft),/private-password-value/);
  await restarted.desktop.dispatch('atlas', 'release', { leaseId: status.leaseId });
  assert.equal(fixture({ root: f.root }).desktop.canRun(f.profiles[0]), true);
});

test('a corrupt human ownership record blocks startup instead of resuming agent work', () => {
  const f = fixture(); writeFileSync(join(f.root, 'desktop-control.json'), '{invalid');
  assert.throws(() => fixture({ root: f.root }), /ownership record could not be read/);
});

test('a restored human session can release and continue its saved task without reopening desktop input', async () => {
  const f = fixture(), lease = await f.desktop.dispatch('atlas', 'take-control', { confirm: true });
  assert.equal(f.desktop.status('atlas').canContinue, false);
  let resumable = true;
  const restarted = fixture({ root: f.root, canContinue: id => id === 'atlas' && resumable });
  assert.equal(restarted.desktop.status('atlas').ready, false);
  assert.equal(restarted.desktop.status('atlas').canContinue, true);
  assert.equal(restarted.desktop.status('scout').canContinue, false);
  await restarted.desktop.dispatch('atlas', 'release', { leaseId: lease.leaseId, continueWork: true });
  assert.deepEqual(restarted.commands, ['claim','stop']);
  assert.deepEqual(restarted.released, [true]);
  assert.equal(restarted.desktop.blocksAgent('atlas'), false);
  resumable = false;
  assert.equal(restarted.desktop.status('atlas').canContinue, false);
});

test('human takeover blocks admissions before awaiting confirmed task cleanup', async () => {
  let finishStop!: () => void;
  const f = fixture({ stop: () => new Promise(resolve => { finishStop = resolve; }) });
  f.busy.add('atlas');
  const taking = f.desktop.dispatch('atlas', 'take-control', { confirm: true });
  assert.equal(f.desktop.blocksAgent('atlas'), true);
  await assert.rejects(f.desktop.dispatch('atlas', 'input', { input: { type: 'text', text: 'secret' } }), /request is still finishing/);
  assert.deepEqual(f.commands, ['claim','stop-agent']);
  finishStop();
  const lease = await taking;
  assert.deepEqual(f.commands, ['claim','stop-agent','stop','start']);
  await assert.rejects(f.desktop.dispatch('atlas', 'input', { leaseId: 'stale', input: { type: 'key', key: 'Enter' } }), /Take control/);
  await f.desktop.dispatch('atlas', 'release', { leaseId: lease.leaseId, continueWork: true });
  assert.equal(f.desktop.blocksAgent('atlas'), false); assert.deepEqual(f.released, [true]);
});

test('failed cleanup retains the admission lock and offers explicit release recovery', async () => {
  const f = fixture({ stop: async () => { throw new Error('Cleanup unconfirmed.'); } });
  await assert.rejects(f.desktop.dispatch('atlas', 'take-control', { confirm: true }), /Cleanup unconfirmed/);
  assert.equal(f.desktop.canRun(f.profiles[0]), false);
  const status = f.desktop.status('atlas');
  assert.equal(status.ready, false);
  await f.desktop.dispatch('atlas', 'release', { leaseId: status.leaseId });
  assert.equal(f.desktop.canRun(f.profiles[0]), true);
});

test('demonstrations omit every typed value and retain only confirmed safe actions', async () => {
  const f = fixture(), lease = await f.desktop.dispatch('atlas', 'take-control', { confirm: true });
  await f.desktop.dispatch('atlas', 'record-start', { leaseId: lease.leaseId });
  await f.desktop.dispatch('atlas', 'input', { leaseId: lease.leaseId, input: { type: 'text', text: 'password-super-secret https://site.test/?token=private' } });
  await f.desktop.dispatch('atlas', 'input', { leaseId: lease.leaseId, input: { type: 'click', x: 15, y: 30 } });
  await assert.rejects(f.desktop.dispatch('atlas', 'release', { leaseId: lease.leaseId }), /Finish the demonstration/);
  const recording = await f.desktop.dispatch('atlas', 'record-stop', { leaseId: lease.leaseId });
  assert.equal(recording.steps, 2);
  assert.doesNotMatch(String(recording.draft), /super-secret|site\.test|token=private/);
  assert.match(String(recording.draft), /Typed text was omitted/);
  assert.match(String(recording.draft), /\(15, 30\)/);
  assert.match(String(recording.draft), /grants no additional tools or authority/);
});

test('shared browser consent, membership, same-machine scope and serialization are enforced', async () => {
  const f = fixture();
  await assert.rejects(f.desktop.dispatch('atlas', 'configure-sharing', { teamId: 'ops', revision: 0 }), /Confirm/);
  await assert.rejects(f.desktop.dispatch('atlas', 'configure-sharing', { teamId: 'foreign', consent: true, revision: 0 }), /membership/);
  await f.desktop.dispatch('atlas', 'configure-sharing', { teamId: 'ops', consent: true, revision: 0 });
  await f.desktop.dispatch('scout', 'configure-sharing', { teamId: 'ops', consent: true, revision: 0 });
  f.busy.add('scout');
  assert.equal(f.desktop.canRun(f.profiles[0]), false);
  await assert.rejects(f.desktop.dispatch('atlas', 'take-control', { confirm: true }), /Another teammate/);
  f.busy.delete('scout');
  const lease = await f.desktop.dispatch('atlas', 'take-control', { confirm: true });
  assert.equal(f.desktop.blocksAgent('scout'), true);
  await f.desktop.dispatch('atlas', 'release', { leaseId: lease.leaseId });
  assert.equal(f.desktop.canRun(f.profiles[1]), true);
  f.profiles[1].computer.machineId = 'another-runner';
  assert.throws(() => f.desktop.validateSharing(f.profiles[0]), /same computer/);
});

test('browser mounts share only a dedicated profile and reject planted source symlinks', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-desktop-'));
  try {
    const computer = { ...agent().computer, browserSessionTeamId: 'ops' };
    const args = browserSessionMount(root, computer);
    assert.equal(args[0], '-v'); assert.match(args[1].replaceAll('\\', '/'), /browser-sessions\/[^:]+:\/workspace\/private\/\.config\/chromium$/);
    assert.ok(!args.join(' ').replaceAll('\\', '/').includes('/agents/')); assert.ok(args.includes('AGENT_BROWSER_PROFILE=/workspace/private/.config/chromium'));
    assert.notEqual(containerSignature(computer, 'image', root), containerSignature({ ...computer, browserSessionTeamId: undefined }, 'image', root));
    const other = join(root, 'other'); mkdirSync(other); rmSync(join(root, 'browser-sessions'), { recursive: true }); symlinkSync(other, join(root, 'browser-sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => browserSessionMount(root, computer), /symbolic links/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('profile persistence checks team membership and protects shared browser assignment on transfer', () => {
  const store = new Store(':memory:'), profiles = new Profiles(store.db), teams = new TeamStore(store.db);
  try {
    const atlas = profiles.save(agent()), scout = profiles.save(agent('scout'));
    assert.throws(() => profiles.save({ ...atlas, computer: { ...atlas.computer, browserSessionTeamId: 'missing' } }), /membership/);
    const created = teams.create({ name: 'Ops', description: '', color: 'sage', icon: 'people', memberAgentIds: [atlas.id, scout.id] });
    profiles.save({ ...atlas, computer: { ...atlas.computer, browserSessionTeamId: created.id } });
    assert.throws(() => profiles.save({ ...scout, computer: { ...scout.computer, browserSessionTeamId: created.id, machineId: 'other' } }), /same computer/);
    assert.throws(() => validateProfile({ ...scout, computer: { ...scout.computer, desktop: 'none', browserSessionTeamId: created.id } }), /private agent desktop/);
  } finally { store.db.close(); }
});

test('desktop accepts only bounded input and never permits a host desktop', async () => {
  for (const input of [{ type: 'click', x: -1, y: 0 }, { type: 'click', x: 1440, y: 0 }, { type: 'key', key: 'Control+Alt+Invalid' }, { type: 'text', text: 'x'.repeat(4001) }, { type: 'shell', command: 'anything' }]) assert.throws(() => validateDesktopInput(input), /invalid/);
  assert.deepEqual(validateDesktopInput({ type: 'click', x: 0, y: 899 }), { type: 'click', x: 0, y: 899, button: 'left' });
  const profile = agent(); profile.computer.desktop = 'existing'; profile.computer.access = 'direct';
  await assert.rejects(executeDesktopCommand('/unused', profile, { action: 'frame' }), /private agent desktop/);
  assert.doesNotMatch(demonstrationDraft([demonstrationStep({ type: 'text', text: 'SECRET' })]), /SECRET/);
});


test('a human desktop lease binds input to its controller while an owner can recover release',async()=>{
  let actor={id:'alice',role:'operator'};const f=fixture({actor:()=>actor}),lease=await f.desktop.dispatch('atlas','take-control',{confirm:true});assert.equal(f.desktop.status('atlas').controllerId,'alice');actor={id:'bob',role:'operator'};assert.equal(f.desktop.status('atlas').youControl,false);await assert.rejects(f.desktop.dispatch('atlas','input',{leaseId:lease.leaseId,input:{type:'key',key:'Enter'}}),/Another workspace member/);await assert.rejects(f.desktop.dispatch('atlas','release',{leaseId:lease.leaseId}),/Another workspace member/);actor={id:'owner',role:'owner'};await f.desktop.dispatch('atlas','release',{leaseId:lease.leaseId});assert.equal(f.desktop.blocksAgent('atlas'),false);
});

test('read-only computer status exposes ownership and activity without using write identity or leaking control capability',async()=>{
  let viewer=false;const f=fixture({actor:()=>{if(viewer)throw new Error('A viewer cannot obtain a write identity');return{id:'alice',role:'operator'};}});
  f.busy.add('atlas');assert.equal(f.desktop.readOnlyStatus('atlas').agentActive,true);
  await f.desktop.dispatch('atlas','take-control',{confirm:true});viewer=true;
  const status=f.desktop.readOnlyStatus('atlas');
  assert.deepEqual(Object.keys(status).sort(),['agentActive','available','browserSessionTeamId','canContinue','canRelease','controlled','controllerName','inControlSince','leaseId','machine','ownershipState','readOnly','ready','recording','revision','sharedWith','steps','teams','terminal','youControl']);
  assert.deepEqual(status.machine,{id:'runner',name:'runner',status:'online'});assert.equal(status.readOnly,true);assert.equal(status.agentActive,false);assert.equal(status.ownershipState,'human');assert.equal(status.controllerName,'Workspace operator');assert.ok(status.inControlSince);assert.equal(status.leaseId,'');assert.deepEqual(status.terminal,{available:false,ready:false});for(const key of ['ownership','controllerId','draft'])assert.equal(key in status,false);for(const key of ['youControl','canRelease','ready','canContinue','recording'])assert.equal((status as Record<string,unknown>)[key],false);assert.equal(status.revision,0);assert.deepEqual(status.teams,[]);assert.deepEqual(status.sharedWith,[]);
  assert.throws(()=>f.desktop.status('atlas'),/write identity/);
  assert.throws(()=>f.desktop.readOnlyStatus('missing'),/not found/);
});

test('demonstration recording omits individually typed secrets from disk and the reusable draft',async()=>{
  const f=fixture(),lease=await f.desktop.dispatch('atlas','take-control',{confirm:true});
  await f.desktop.dispatch('atlas','record-start',{leaseId:lease.leaseId});
  const printable=['s','3','c','r','e','t','Shift+1','Shift+Shift+Q','Space','Shift+Space'];
  for(const key of [...printable,'Enter','Control+l'])await f.desktop.dispatch('atlas','input',{leaseId:lease.leaseId,input:{type:'key',key}});
  const saved=JSON.parse(readFileSync(join(f.root,'desktop-control.json'),'utf8')),steps=saved.leases[0].recording.steps as string[];
  assert.equal(steps.length,12);
  assert.ok(steps.slice(0,printable.length).every(step=>step==='Type the required value. Individual typed characters were omitted.'));
  assert.deepEqual(steps.slice(-2),['Press Enter.','Press Control+l.']);
  const finished=await f.desktop.dispatch('atlas','record-stop',{leaseId:lease.leaseId});
  for(const secret of ['Press s.','Press 3.','Press Shift+1.','Shift+Shift+Q'])assert.ok(!String(finished.draft).includes(secret));
  assert.match(String(finished.draft),/Press Control\+l/);
});
