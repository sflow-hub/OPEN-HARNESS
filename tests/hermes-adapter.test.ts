import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeModels } from '../runtime/profile-runtime';
import { HermesGateway, lastWords } from '../runtime/hermes';

class StreamingGateway extends HermesGateway {
  constructor(readonly submit: () => Promise<unknown> = async () => ({ status: 'streaming' })) { super('test'); }
  override request() { return this.submit(); }
}
test('streaming acknowledgement does not finish a run; session completion does', async () => {
  const gateway = new StreamingGateway(); let settled = false;
  const result = gateway.submitPrompt('session-a', 'work').then(value => { settled = true; return value; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gateway.emit('event', { type: 'message.complete', session_id: 'child-session', payload: { text: 'child' } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  gateway.emit('event', { type: 'message.complete', session_id: 'session-a', payload: { status: 'complete', text: 'saved artifact' } });
  assert.equal((await result).text, 'saved artifact'); assert.equal(gateway.listenerCount('event'), 0);
});
test('completion arriving before the submit acknowledgement is preserved', async () => {
  const gateway = new StreamingGateway(async () => {
    gateway.emit('event', { type: 'message.complete', session_id: 'a', payload: { status: 'complete', text: 'early' } });
    return { status: 'streaming' };
  });
  assert.equal((await gateway.submitPrompt('a', 'work')).text, 'early');
});
test('provider errors and gateway crashes cannot become successful empty results', async () => {
  const gateway = new StreamingGateway();
  const result = gateway.submitPrompt('a', 'work');
  gateway.emit('event', { type: 'message.complete', session_id: 'a', payload: { status: 'error', error: 'Provider unavailable' } });
  await assert.rejects(result, /Provider unavailable/);
  const crashed = gateway.submitPrompt('b', 'work');
  gateway.emit('exit', Object.assign(new Error('container crashed'), { interrupted: true }));
  await assert.rejects(crashed, { interrupted: true });
  assert.equal(gateway.listenerCount('event'), 0); assert.equal(gateway.listenerCount('exit'), 0);
});

test('normalizes Hermes provider rows with string model IDs and custom providers', () => {
  const catalog = normalizeModels({ providers: [{ slug: 'openrouter', name: 'OpenRouter', models: ['vendor/fast', 'vendor/large'] }, { provider_id: 'custom-local', models: [{ id: 'local-model', name: 'Local model' }] }] });
  assert.deepEqual(catalog.models.map(m => [m.provider, m.id]), [['openrouter', 'vendor/fast'], ['openrouter', 'vendor/large'], ['custom-local', 'local-model']]);
});

test('a crashed gateway reports the agent\'s own last output, not just an exit code', () => {
  const traceback = ['Traceback (most recent call last):', '  File "/opt/open-harness/managed_entry.py", line 12', 'ModuleNotFoundError: No module named \'hermes_cli\''];
  const summary = lastWords(traceback);
  assert.match(summary, /ModuleNotFoundError/);
  assert.match(summary, /Last output:/);
  // Blank lines are noise, and the tail must stay short enough to read in an error bubble.
  assert.equal(lastWords([]), '');
  assert.equal(lastWords(['', '   ']), '');
  assert.ok(lastWords([`x${'y'.repeat(900)}`]).length < 460);
  // Newest last: the final line is the one that explains the crash.
  assert.ok(summary.endsWith("No module named 'hermes_cli'"));
});
