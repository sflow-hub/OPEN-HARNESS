import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { draftProfile } from '../lib/agent-profile';
import { executeDesktopCommand } from '../runtime/desktop-control';
import { DESKTOP_HELPER } from '../runtime/desktop-helper';

const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : '';
// Execute the shipped helper with a clock that advances while the driver captures, after
// its initial deadline check. Record only which operations ran, never their arguments.
const SHIM = String.raw`
import json, os, sys, time, types
events, clock = [], [1000]
time.time = lambda: clock[0]
os.environ['OPEN_HARNESS_VIRTUAL_DESKTOP'], os.environ['DISPLAY'] = '1', ':99'
class Backend:
    def start(self):
        os.fstat(sys.stdout.fileno())
        os.fstat(sys.stderr.fileno())
        events.append('start')
    def capture(self, **kwargs):
        events.append('capture')
        clock[0] += 2
        return types.SimpleNamespace(elements=[types.SimpleNamespace(role='frame', bounds=(100, 200, 300, 400))])
    def click(self, **kwargs):
        assert kwargs['x'] == 50 and kwargs['y'] == 60
        events.append('click')
        return types.SimpleNamespace(ok=True)
    def scroll(self, **kwargs):
        events.append('scroll')
        return types.SimpleNamespace(ok=True)
    def key(self, *args, **kwargs):
        events.append('key')
        return types.SimpleNamespace(ok=True)
    def type_text(self, *args, **kwargs):
        events.append('text')
        return types.SimpleNamespace(ok=True)
    def stop(self): events.append('stop')
for name in ('cua_compat', 'tools', 'tools.computer_use', 'tools.computer_use.cua_backend'):
    sys.modules[name] = types.ModuleType(name)
sys.modules['cua_compat'].install = lambda: None
sys.modules['tools.computer_use.cua_backend'].CuaDriverBackend = Backend
code = 0
try: exec(compile(sys.argv[1], 'DESKTOP_HELPER', 'exec'), {})
except SystemExit as error: code = error.code
print(json.dumps({'events': events, 'exitCode': code}))
`;
function helper(input: object, expiresAt?: unknown) {
  const result = spawnSync(python, ['-I', '-S', '-c', SHIM, DESKTOP_HELPER], { encoding: 'utf8', input: JSON.stringify({ action: 'input', input, ...(expiresAt !== undefined ? { expiresAt } : {}) }) + '\n', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /private-desktop-value/);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { events: string[]; exitCode: number };
}
const inputs = [{ type: 'click', x: 10, y: 20, button: 'left' }, { type: 'scroll', direction: 'up', amount: 1 }, { type: 'key', key: 'Enter' }, { type: 'text', text: 'private-desktop-value' }];

test('desktop helper refuses input that expires during capture and always stops its driver', { skip: !python }, () => {
  for (const input of inputs) assert.deepEqual(helper(input, 1_001_000), { events: ['start', 'capture', 'stop'], exitCode: 1 });
});

test('desktop helper accepts current remote and local input, and rejects invalid deadlines before setup', { skip: !python }, () => {
  assert.deepEqual(helper(inputs[3], 1_003_000), { events: ['start', 'capture', 'text', 'stop'], exitCode: 0 });
  assert.deepEqual(helper(inputs[3]), { events: ['start', 'capture', 'text', 'stop'], exitCode: 0 });
  for (const deadline of [null, true, '1003000', 999_000]) assert.deepEqual(helper(inputs[3], deadline), { events: [], exitCode: 1 });
});

test('desktop clicks use window coordinates and reject points outside the captured window', { skip: !python }, () => {
  assert.deepEqual(helper({ type: 'click', x: 150, y: 260, button: 'left' }), { events: ['start', 'capture', 'click', 'stop'], exitCode: 0 });
  assert.deepEqual(helper(inputs[0]), { events: ['start', 'capture', 'stop'], exitCode: 1 });
});

test('desktop adapter rejects expired and non-finite deadlines before touching the runtime', async () => {
  const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
  profile.computer.desktop = 'virtual';
  for (const expiresAt of [Date.now() - 1, NaN, Infinity]) await assert.rejects(executeDesktopCommand('/unused', profile, { action: 'input', input: { type: 'key', key: 'Enter' }, expiresAt }), /request expired/);
});
