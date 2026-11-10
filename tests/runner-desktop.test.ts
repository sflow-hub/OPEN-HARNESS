import test from 'node:test';
import assert from 'node:assert/strict';
import { RunnerDesktop } from '../runtime/runner-desktop';

const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
test('desktop ownership commands retain validated generation and immutable container metadata', async () => {
  const bridge = new RunnerDesktop(() => {}), metadata = { generation: 7, owner: 'human', identity: 'lease:actor', containerId: 'f'.repeat(64), sessionId: 'f'.repeat(64) + ':browser-session', browserSessionId: 'browser-session', browserPid: 123 };
  const pending = bridge.request('runner', 'atlas', { action: 'claim', ...metadata }), [command] = bridge.poll('runner');
  assert.equal(command.payload.generation, 7); bridge.complete('runner', command.id, { result: { ok: true, ...metadata, privateExtra: 'not reflected' } });
  assert.deepEqual(await pending, { ok: true, ...metadata }); bridge.close();
});
test('desktop requests are ephemeral, machine-scoped, delivered once and limited to one operation per agent', async () => {
  const wakes: string[] = [], bridge = new RunnerDesktop(id => { wakes.push(id); });
  const pending = bridge.request('runner-a', 'atlas', { action: 'input', encrypted: { data: 'sealed' } });
  await assert.rejects(bridge.request('runner-b', 'atlas', { action: 'frame' }), /still in progress/);
  assert.deepEqual(bridge.poll('runner-b'), []);
  const [command] = bridge.poll('runner-a'); assert.equal(command.kind, 'desktop'); assert.equal(command.agentId, 'atlas');
  assert.ok(command.payload.expiresAt > Date.now()); assert.deepEqual(command.payload.encrypted, { data: 'sealed' });
  assert.deepEqual(bridge.poll('runner-a'), []);
  assert.throws(() => bridge.complete('runner-b', command.id, { result: { ok: true } }), /another runner/);
  assert.deepEqual(bridge.complete('runner-a', command.id, { result: { ok: true, privateExtra: 'must not be reflected' } }), { ok: true });
  assert.deepEqual(await pending, { ok: true }); assert.deepEqual(wakes, ['runner-a']);
  assert.throws(() => bridge.complete('runner-a', command.id, { result: { ok: true } }), /expired/);
  const restarted = new RunnerDesktop(() => {}); assert.deepEqual(restarted.poll('runner-a'), []); restarted.close(); bridge.close();
});

test('desktop bridge validates bounded PNG frames and suppresses arbitrary runner error text', async () => {
  const bridge = new RunnerDesktop(() => {});
  const pending = bridge.request('runner', 'atlas', { action: 'frame' }), [command] = bridge.poll('runner');
  bridge.complete('runner', command.id, { result: { ok: true, image: png, width: 1440, height: 900, other: 'omitted' } });
  assert.deepEqual(await pending, { ok: true, image: png, width: 1440, height: 900 });
  for (const result of [{ ok: true, image: 'https://example.com/image', width: 100, height: 100 }, { ok: true, image: png, width: 1441, height: 900 }, { ok: true, image: png, width: 100, height: 0 }, { ok: true, image: 'data:image/png;base64,PHN2Zz4=', width: 100, height: 100 }, { ok: true, image: 'data:image/png;base64,' + 'a'.repeat(8_000_001), width: 100, height: 100 }, null]) {
    const request = bridge.request('runner', 'atlas', { action: 'frame' }), rejected = assert.rejects(request, /invalid/), [item] = bridge.poll('runner'); bridge.complete('runner', item.id, { result }); await rejected;
  }
  const failure = bridge.request('runner', 'atlas', { action: 'start' }), rejected = assert.rejects(failure, error => error instanceof Error && !error.message.includes('password-fixture')), [item] = bridge.poll('runner');
  bridge.complete('runner', item.id, { error: 'password-fixture' }); await rejected; bridge.close();
});

test('expired desktop input is never polled or replayed and shutdown cancels outstanding requests', async t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const bridge = new RunnerDesktop(() => {});
  const expired = bridge.request('runner', 'atlas', { action: 'input', encrypted: {} }), rejected = assert.rejects(expired, /expired before/);
  t.mock.timers.tick(20_001); assert.deepEqual(bridge.poll('runner'), []); await rejected;
  const timedOut = bridge.request('runner', 'atlas', { action: 'input', encrypted: {} }), timedOutCheck = assert.rejects(timedOut, /did not answer/), [command] = bridge.poll('runner');
  t.mock.timers.tick(25_001); await timedOutCheck; assert.throws(() => bridge.complete('runner', command.id, { result: { ok: true } }), /expired/);
  const closing = bridge.request('runner', 'atlas', { action: 'start' }), closeCheck = assert.rejects(closing, /stopping/); bridge.close(); await closeCheck;
  assert.deepEqual(bridge.poll('runner'), []); await assert.rejects(bridge.request('runner', 'atlas', { action: 'frame' }), /stopping/);
});
test('remote upload replies only return bounded matching container paths',async()=>{
  const bridge=new RunnerDesktop(()=>{}),file={name:'file.txt',bytes:4,path:'/workspace/exchange/uploads/0123456789abcdef-file.txt'};
  const pending=bridge.request('runner','atlas',{action:'stage-upload',fileName:'file.txt'}),[command]=bridge.poll('runner');
  bridge.complete('runner',command.id,{result:{ok:true,...file,secret:'omitted'}});assert.deepEqual(await pending,{ok:true,...file});
  for(const change of [{path:'/host/secret'},{bytes:30*1024*1024},{name:'another.txt'},{path:'/workspace/exchange/uploads/0123456789abcdef-../file.txt'}]){
    const request=bridge.request('runner','atlas',{action:'stage-upload',fileName:'file.txt'}),rejected=assert.rejects(request,/invalid upload/),[item]=bridge.poll('runner');
    bridge.complete('runner',item.id,{result:{ok:true,...file,...change}});await rejected;
  }bridge.close();
});
test('remote download metadata stays agent scoped and claims have bounded startup time',async t=>{
  t.mock.timers.enable({apis:['setTimeout','Date'],now:1000});
  const bridge=new RunnerDesktop(()=>{}),claim=bridge.request('runner','atlas',{action:'claim'}),[command]=bridge.poll('runner');
  assert.equal(command.payload.expiresAt,86000);t.mock.timers.tick(26000);bridge.complete('runner',command.id,{result:{ok:true}});await claim;
  const receipt={id:'a'.repeat(32),name:'file.txt',path:`downloads/${'a'.repeat(32)}-file.txt`,sha256:'b'.repeat(64),ownerId:'atlas',epoch:2,bytes:4,savedAt:new Date().toISOString(),runId:'run'};
  const capture=bridge.request('runner','atlas',{action:'frame'}),[frame]=bridge.poll('runner');
  bridge.complete('runner',frame.id,{result:{ok:true,image:png,width:1,height:1,downloads:[{...receipt,secret:'omitted'}],fileExchangeError:'private details'}});
  const result=await capture as {downloads:unknown[];fileExchangeError:string};assert.deepEqual(result.downloads,[receipt]);assert.doesNotMatch(result.fileExchangeError,/private details/);
  const foreign=bridge.request('runner','atlas',{action:'frame'}),rejected=assert.rejects(foreign,/invalid download/),[item]=bridge.poll('runner');
  bridge.complete('runner',item.id,{result:{ok:true,image:png,width:1,height:1,downloads:[{...receipt,ownerId:'scout'}]}});await rejected;bridge.close();
});
