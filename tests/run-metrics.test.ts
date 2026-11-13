import test from 'node:test';
import assert from 'node:assert/strict';
import { Store, type RunRow } from '../runtime/db';
import { metricsSummary, runMetrics, recordRunMetrics } from '../runtime/run-metrics';
import { Outcomes } from '../runtime/outcomes';

const epoch = Date.parse('2026-10-29T12:00:00.000Z');
const stamp = (ms: number) => new Date(epoch + ms).toISOString();
function run(store: Store, id: string, state: RunRow['state'] = 'completed') {
  const value: RunRow = { id, agent_id: 'atlas', conversation_id: id, prompt: 'Fixture task', state, session_id: null, parent_run_id: null, depth: 0, created_at: stamp(0), updated_at: stamp(1000), result: null, error: null };
  store.createRun(value); return value;
}
function event(store: Store, id: string, type: string, ms: number | string, payload: unknown = {}) {
  const created = store.appendEvent(id, type, payload);
  store.db.prepare('UPDATE events SET created_at=? WHERE id=?').run(typeof ms === 'string' ? ms : stamp(ms), created.id);
}

test('metrics use admission, output and cleanup timestamps with approval time included in total', () => {
  const store = new Store(':memory:');
  try {
    run(store, 'a');
    event(store, 'a', 'run.admitted', 100); event(store, 'a', 'run.started', 400);
    event(store, 'a', 'run.phase', 500, { phase: 'gateway-ready' });
    event(store, 'a', 'message.delta', 900, { text: 'Working' }); event(store, 'a', 'approval.request', 1100);
    event(store, 'a', 'approval.resolved', 2000); event(store, 'a', 'run.phase', 2500, { phase: 'execution-finished' }); event(store, 'a', 'run.completed', 2800);
    const metrics = runMetrics(store.db, 'a');
    assert.equal(metrics.queueMs, 100); assert.equal(metrics.startupMs, 400); assert.equal(metrics.firstOutputMs, 900);
    assert.equal(metrics.cleanupMs, 300); assert.equal(metrics.totalMs, 2800); assert.equal(metrics.approvals, 1);
    assert.match(metrics.evidence, /Coordinator event timestamps/);
  } finally { store.db.close(); }
});

test('legacy and remote runs expose only recorded phases and incomplete work has no invented finish time', () => {
  const store = new Store(':memory:');
  try {
    run(store, 'legacy'); event(store, 'legacy', 'run.started', 120); event(store, 'legacy', 'tool.start', 500); event(store, 'legacy', 'run.completed', 1000);
    const legacy = runMetrics(store.db, 'legacy');
    assert.equal(legacy.queueMs, 120); assert.equal(legacy.startupMs, null); assert.equal(legacy.cleanupMs, null); assert.equal(legacy.firstOutputMs, 500);
    run(store, 'live', 'waiting_approval'); event(store, 'live', 'run.started', 10); event(store, 'live', 'approval.request', 20);
    const live = runMetrics(store.db, 'live'); assert.equal(live.totalMs, null); assert.equal(live.firstOutputMs, null);
    assert.throws(() => runMetrics(store.db, 'missing'), /Run not found/);
  } finally { store.db.close(); }
});

test('malformed phase payloads and invalid or reversed clocks stay unknown without poisoning the summary', () => {
  const store = new Store(':memory:');
  try {
    run(store, 'a'); event(store, 'a', 'run.admitted', -10); event(store, 'a', 'run.phase', -20, { phase: 'gateway-ready' });
    event(store, 'a', 'run.phase', 5, null); event(store, 'a', 'run.phase', 5, 'string');
    const malformed = store.appendEvent('a', 'run.phase', {}); store.db.prepare('UPDATE events SET payload_json=? WHERE id=?').run('{broken', malformed.id);
    event(store, 'a', 'message.delta', 'not a timestamp'); event(store, 'a', 'run.completed', -5);
    const metrics = runMetrics(store.db, 'a');
    for (const key of ['queueMs','startupMs','firstOutputMs','cleanupMs','totalMs'] as const) assert.equal(metrics[key], null, key);
    run(store, 'invalid-admission'); event(store, 'invalid-admission', 'run.admitted', 'invalid'); event(store, 'invalid-admission', 'run.started', 20);
    assert.equal(runMetrics(store.db, 'invalid-admission').queueMs, null);
    const summary = metricsSummary(store.db); assert.equal(summary.timings.totalMs.sampleSize, 0); assert.equal(summary.timings.totalMs.median, null);
  } finally { store.db.close(); }
});

test('summary reports measured sample sizes, conventional median and nearest-rank p95 without claiming business success', () => {
  const store = new Store(':memory:');
  try {
    for (let i = 1; i <= 20; i++) { run(store, `run-${i}`); event(store, `run-${i}`, 'run.completed', i); }
    run(store, 'failed', 'failed'); run(store, 'unfinished', 'running');
    const summary = metricsSummary(store.db);
    assert.equal(summary.sampleSize, 22); assert.equal(summary.completed, 20); assert.equal(summary.failed, 1);
    assert.deepEqual(summary.timings.totalMs, { sampleSize: 20, median: 10.5, p95: 19 });
    assert.deepEqual(summary.timings.startupMs, { sampleSize: 0, median: null, p95: null });
    assert.match(summary.note, /not a verified business outcome/);
    assert.equal(metricsSummary(store.db, 0).sampleSize, 0); assert.equal(metricsSummary(store.db, -2).sampleSize, 0);
    assert.equal(metricsSummary(store.db, 1).sampleSize, 1); assert.equal(metricsSummary(store.db, NaN).sampleSize, 22);
  } finally { store.db.close(); }
});

test('outcome acceptance needs a completed run and concrete operator evidence; unreviewed runs are excluded', () => {
  const store = new Store(':memory:'), outcomes = new Outcomes(store.db);
  try {
    run(store, 'complete'); run(store, 'unreviewed'); run(store, 'failed', 'failed'); run(store, 'live', 'running');
    assert.equal(outcomes.get('complete'), null);
    assert.throws(() => outcomes.review('missing', { accepted: true, evidence: 'Checked output' }), /Run not found/);
    assert.throws(() => outcomes.review('live', { accepted: false, evidence: 'Checked output' }), /Wait for this task/);
    assert.throws(() => outcomes.review('failed', { accepted: true, evidence: 'Checked output' }), /Only completed/);
    for (const evidence of ['', '   ', 'a'.repeat(12001)]) assert.throws(() => outcomes.review('complete', { accepted: true, evidence }), /Describe what you checked/);
    assert.throws(() => outcomes.review('complete', { accepted: 'yes', evidence: 'Checked output' }), /Describe what you checked/);
    const accepted = outcomes.review('complete', { accepted: true, evidence: '  Opened the destination and matched all expected rows.  ' });
    assert.equal(accepted?.evidence, 'Opened the destination and matched all expected rows.');
    outcomes.review('failed', { accepted: false, evidence: 'The destination file is missing.' });
    assert.deepEqual(outcomes.summary(), { reviewed: 2, accepted: 1, needsChanges: 1, source: 'Operator reviews; unreviewed tasks are excluded.' });
    outcomes.review('complete', { accepted: false, evidence: 'A second check found a missing row.' });
    assert.equal(outcomes.summary().reviewed, 2); assert.equal(outcomes.summary().accepted, 0);
  } finally { store.db.close(); }
});

test('actual model text, runner phases and immutable timing evidence survive raw event retention',()=>{
  const store=new Store(':memory:');try{run(store,'timed');event(store,'timed','run.admitted',10);event(store,'timed','run.acknowledged',5,{latencyMs:5});event(store,'timed','run.phase',20,{phase:'profile-ready',prewarmed:true,runnerElapsedMs:10});event(store,'timed','run.phase',30,{phase:'gateway-ready',runnerElapsedMs:20});event(store,'timed','run.phase',40,{phase:'prompt-dispatched',runnerElapsedMs:30});event(store,'timed','tool.start',45,{id:'call-a'});event(store,'timed','tool.start',46,{name:'ambiguous'});event(store,'timed','tool.end',55,{id:'call-a'});event(store,'timed','tool.end',56,{name:'ambiguous'});event(store,'timed','message.delta',60,{text:'Actual text'});event(store,'timed','run.completed',100);const measured=recordRunMetrics(store.db,'timed');assert.equal(measured.firstOutputMs,45);assert.equal(measured.firstTextMs,60);assert.equal(measured.modelFirstTextMs,20);assert.equal(measured.toolMs,10);assert.equal(measured.remotePreparationMs,10);assert.equal(measured.remoteGatewayMs,10);assert.equal(measured.context.temperature,'warm');store.db.prepare('DELETE FROM events WHERE run_id=?').run('timed');assert.deepEqual(runMetrics(store.db,'timed'),measured);}finally{store.db.close();}
});

test('real Hermes tool identities, prompt size and reply-only mode are measured separately',()=>{
  const store=new Store(':memory:');try{
    run(store,'chat');event(store,'chat','profile.applied',0,{replyOnly:true,allowedTools:[]});event(store,'chat','run.context',1,{turns:4,characters:210});
    event(store,'chat','tool.start',10,{tool_id:'real-tool'});event(store,'chat','tool.complete',30,{tool_id:'real-tool'});
    event(store,'chat','message.complete',40,{usage:{input:164,prompt:7844,output:7,calls:1}});
    const value=runMetrics(store.db,'chat');assert.equal(value.toolMs,20);assert.equal(value.historyTurns,4);assert.equal(value.historyCharacters,210);
    assert.equal(value.inputTokens,164);assert.equal(value.promptTokens,7844);assert.equal(value.cachedInputTokens,7680);assert.equal(value.outputTokens,7);assert.equal(value.modelCalls,1);assert.equal(value.grantedTools,0);assert.equal(value.context.replyOnly,true);
  }finally{store.db.close();}
});
