import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DESKTOP_HELPER } from '../runtime/desktop-helper';

const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : '';
const shim = String.raw`
import ctypes, json, os, sys, time, types
events, clock, motions = [], [1000], [0]
time.time = lambda: clock[0]
time.sleep = lambda _: None
os.environ['OPEN_HARNESS_VIRTUAL_DESKTOP'], os.environ['DISPLAY'] = '1', ':99'
listdir = os.listdir
os.listdir = lambda path: [] if path == '/proc' else listdir(path)
class Backend:
    captured = False
    def start(self): events.append('start')
    def stop(self): events.append('stop')
    def capture(self, **kwargs): self.captured=True; return types.SimpleNamespace(elements=[types.SimpleNamespace(role='frame', bounds=(0, 0, 1440, 900))])
    def click(self, **kwargs): events.append('click'); return types.SimpleNamespace(ok=True)
    def key(self, *args, **kwargs):
        if not self.captured: raise RuntimeError('Capture must establish the foreground target first.')
        events.append('key'); return types.SimpleNamespace(ok=True)
    def type_text(self, *args, **kwargs): events.append('text'); return types.SimpleNamespace(ok=True)
class Function:
    def __init__(self, name): self.name=name
    def __call__(self, *args):
        if self.name == 'XTestFakeMotionEvent':
            events.append(['move', args[2], args[3]])
            motions[0] += 1
            if sys.argv[2] == 'expire' and motions[0] == 2: clock[0] += 2
        if self.name == 'XTestFakeButtonEvent': events.append(['button', args[1], args[2]])
        if self.name == 'XCloseDisplay': events.append('close')
        return 1
class Library:
    def __getattr__(self, name):
        value=Function(name); setattr(self,name,value); return value
ctypes.CDLL = lambda _: Library()
for name in ('cua_compat','tools','tools.computer_use','tools.computer_use.cua_backend'): sys.modules[name]=types.ModuleType(name)
sys.modules['cua_compat'].install=lambda:None
sys.modules['tools.computer_use.cua_backend'].CuaDriverBackend=Backend
code=0
try:exec(compile(sys.argv[1],'DESKTOP_HELPER','exec'),{})
except SystemExit as error:code=error.code
print(json.dumps({'events':events,'exitCode':code}))
`;
function run(command: object, expire = false) {
  const result = spawnSync(python, ['-I', '-S', '-c', shim, DESKTOP_HELPER, expire ? 'expire' : ''], { input: JSON.stringify(command) + '\n', encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /private-input-value/);
  return JSON.parse(result.stdout.trim().split('\n').at(-1)!) as { events: Array<string | number[]>; exitCode: number };
}

test('managed desktop helper supports double-click, middle click and horizontal wheel', { skip: !python }, () => {
  const twice = run({ action: 'input', input: { type: 'click', x: 50, y: 60, button: 'left', clickCount: 2 } });
  assert.equal(twice.exitCode, 0); assert.deepEqual(twice.events, ['start','click','click','stop']);
  const middle = run({ action: 'input', input: { type: 'click', x: 50, y: 60, button: 'middle' } });
  assert.equal(middle.exitCode, 0); assert.ok(middle.events.some(item => JSON.stringify(item) === JSON.stringify(['button',2,1])));
  const wheel = run({ action: 'input', input: { type: 'scroll', direction: 'left', amount: 2 } });
  assert.equal(wheel.exitCode, 0); assert.equal(wheel.events.filter(item => JSON.stringify(item) === JSON.stringify(['button',6,1])).length, 2);
});

test('drag releases its pressed button even when the command expires mid-drag', { skip: !python }, () => {
  const value = run({ action: 'input', expiresAt: 1_001_000, input: { type: 'drag', fromX: 10, fromY: 20, toX: 50, toY: 60 } }, true);
  assert.equal(value.exitCode, 1);
  assert.deepEqual(value.events.slice(-3), [['button',1,0], 'close', 'stop']);
  const valid = run({ action: 'input', input: { type: 'drag', fromX: 10, fromY: 20, toX: 50, toY: 60 } });
  assert.equal(valid.exitCode, 0); assert.ok(valid.events.some(item => JSON.stringify(item) === JSON.stringify(['move',50,60])));
});

test('navigation accepts web addresses only and sends no input for rejected addresses', { skip: !python }, () => {
  const valid = run({ action: 'navigate', url: 'https://example.test/private-input-value' });
  assert.equal(valid.exitCode, 0); assert.deepEqual(valid.events, ['start','key','text','key','stop']);
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:secret@example.test', 'https://example.test/\n']) {
    const rejected = run({ action: 'navigate', url }); assert.equal(rejected.exitCode, 1); assert.deepEqual(rejected.events, ['start','stop']);
  }
});

test('fresh browser claim preserves cookies but starts blank and sets the actual profile download folder', { skip: !python }, t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-browser-start-')), profile = join(root, 'profile'), downloads = join(root, 'downloads');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(profile, 'Default'), { recursive: true }); writeFileSync(join(profile, 'Default', 'Cookies'), 'preserved');
  writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ session: { restore_on_startup: 1 }, custom: 'kept' }));
  const startShim = String.raw`
import json,os,subprocess,sys
scope={}; exec(compile(sys.argv[1].split('\ntry:\n    spec =')[0],'helper','exec'),scope)
started=[]
scope['browser_processes']=lambda:[]
scope['browser_identity']=lambda:{'browserPid':42,'browserSessionId':'42:100'}
subprocess.Popen=lambda args,**kwargs:started.append(args)
os.environ.update({'OPEN_HARNESS_VIRTUAL_DESKTOP':'1','DISPLAY':':99','AGENT_BROWSER_PROFILE':sys.argv[2],'OPEN_HARNESS_DOWNLOAD_DIR':sys.argv[3]})
result=scope['main']({'action':'start','freshPage':sys.argv[4]=='fresh'})
print(json.dumps({'args':started[0],'result':result}))
`;
  const invoke = (mode: string) => {
    const result = spawnSync(python, ['-I', '-S', '-c', startShim, DESKTOP_HELPER, profile, downloads, mode], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout) as { args: string[]; result: { browserSessionId: string } };
  };
  const fresh = invoke('fresh'); assert.equal(fresh.args.at(-1), 'about:blank'); assert.ok(!fresh.args.includes('--restore-last-session')); assert.equal(fresh.result.browserSessionId, '42:100');
  const preferences = JSON.parse(readFileSync(join(profile, 'Default', 'Preferences'), 'utf8'));
  assert.equal(preferences.download.default_directory, downloads); assert.equal(preferences.session.restore_on_startup, 5); assert.equal(preferences.custom, 'kept');
  assert.equal(readFileSync(join(profile, 'Default', 'Cookies'), 'utf8'), 'preserved');
  assert.ok(invoke('resume').args.includes('--restore-last-session'));
});
