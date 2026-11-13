import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pythonProbe = spawnSync('python3', ['--version'], { timeout: 30_000 });
assert.ok(!pythonProbe.error || (pythonProbe.error as NodeJS.ErrnoException).code === 'ENOENT', pythonProbe.error?.message);
const python = pythonProbe.status === 0 ? 'python3' : '';
const source = readFileSync(new URL('../runtime/hermes/browser_shutdown.py', import.meta.url), 'utf8');
function check(script: string) {
  const result = spawnSync(python, ['-I', '-S', '-c', `import sys\nscope={'__name__':'browser_shutdown_test'}\nexec(compile(sys.argv[1],'browser_shutdown','exec'),scope)\n${script}`, source], { encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, `Python exited with ${result.status ?? result.signal}: ${result.stderr}`);
}

test('browser shutdown matches the exact managed profile and excludes workers and zombies', { skip: !python }, () => check(String.raw`
import io
scope['os'].environ['AGENT_BROWSER_PROFILE']='/managed/browser'
commands={1:b'/usr/lib/chromium/chromium\0--user-data-dir=/managed/browser\0',2:b'/usr/lib/chromium/chromium\0--user-data-dir=/managed/browser-other\0',3:b'/usr/lib/chromium/chromium\0--user-data-dir=/managed/browser\0--type=renderer\0',4:b'/usr/bin/python\0--user-data-dir=/managed/browser\0',5:b'/usr/lib/chromium/chromium\0--user-data-dir=/managed/browser\0',6:b'/usr/lib/chromium/chromium --user-data-dir=/managed/browser --restore-last-session about:blank\0',7:b'/usr/lib/chromium/chromium --type=renderer --user-data-dir=/managed/browser\0',8:b'/usr/lib/chromium/chromium --user-data-dir=/managed/browser-other\0'}
scope['os'].listdir=lambda _:list(map(str,commands))
scope['os'].readlink=lambda path:'/usr/bin/python' if path.split('/')[2]=='4' else '/usr/lib/chromium/chromium'
def opened(path,mode='r'):
 pid=int(path.split('/')[2])
 if path.endswith('/cmdline'):return io.BytesIO(commands[pid])
 return io.StringIO(str(pid)+' (chromium) '+' '.join(['Z' if pid==5 else 'S']+['0']*18+['start-'+str(pid)]))
scope['open']=opened
assert scope['browser_processes']()=={1:'start-1',6:'start-6'}
commands.clear();commands[9]=b'/usr/lib/chromium/chromium --unrecognized-title\0'
try:scope['browser_processes']()
except RuntimeError as error:assert 'identified safely' in str(error)
else:raise AssertionError('An unknown main browser must fail closed')
`));

test('browser shutdown recognizes a browser exiting during the post-close identity scan', { skip: !python }, () => check(String.raw`
import io
from types import SimpleNamespace
original_os=scope['os']
for final_state,final_command in [('Z',b''),(None,b''),('gone',b''),('Z',b"chromium '--unfinished\0")]:
 phase=[0];closed=[]
 def readlink(path):
  if phase[0]==1:phase[0]=2
  return '/usr/lib/chromium/chromium'
 def opened(path,mode='r'):
  if path.endswith('/cmdline'):
   return io.BytesIO(final_command if phase[0]==2 else b'chromium\0--user-data-dir=/managed/browser\0')
  assert path.endswith('/stat'),path
  if phase[0]==2 and final_state is None:raise FileNotFoundError(path)
  if phase[0]==2 and final_state=='gone':raise ProcessLookupError(path)
  state=final_state if phase[0]==2 else 'S'
  return io.StringIO('41 (chromium) '+' '.join([state]+['0']*18+['same']))
 def request_close(identities):
  closed.append(identities);phase[0]=1;return 1
 scope['os']=SimpleNamespace(environ={'AGENT_BROWSER_PROFILE':'/managed/browser'},fsencode=original_os.fsencode,fsdecode=original_os.fsdecode,path=original_os.path,listdir=lambda _:['41'],readlink=readlink)
 scope['open']=opened;scope['request_window_close']=request_close
 scope['close_browser'](.3)
 assert closed==[{41:'same'}],closed
`));

test('browser shutdown rejects live empty or malformed identities and mid-scan PID reuse', { skip: !python }, () => check(String.raw`
import io
from types import SimpleNamespace
original_os=scope['os']
cases=[(b'','S','same','identified safely'),(b'chromium\0--unknown\0','S','same','identified safely'),(b"chromium '--unfinished\0",'S','same','identified safely'),(b'','T','same','identified safely'),(b'chromium\0--user-data-dir=/managed/browser\0','S','replacement','changed'),(b'chromium\0--unknown\0','S','replacement','changed')]
for command,state,start,message in cases:
 sampled=[False]
 def opened(path,mode='r'):
  if path.endswith('/cmdline'):
   sampled[0]=True;return io.BytesIO(command)
  assert path.endswith('/stat'),path
  return io.StringIO('41 (chromium) '+' '.join([state if sampled[0] else 'S']+['0']*18+[start if sampled[0] else 'same']))
 scope['os']=SimpleNamespace(environ={'AGENT_BROWSER_PROFILE':'/managed/browser'},fsencode=original_os.fsencode,fsdecode=original_os.fsdecode,path=original_os.path,listdir=lambda _:['41'],readlink=lambda _:'/usr/lib/chromium/chromium')
 scope['open']=opened
 try:scope['browser_processes']()
 except RuntimeError as error:assert message in str(error),error
 else:raise AssertionError('An unidentified live browser or reused PID must fail closed')
`));

test('browser shutdown fails closed when an identified browser state cannot be rechecked', { skip: !python }, () => check(String.raw`
import io
from types import SimpleNamespace
original_os=scope['os']
for failure in [PermissionError('denied'),OSError('unreadable'),None]:
 sampled=[False]
 def opened(path,mode='r'):
  if path.endswith('/cmdline'):
   sampled[0]=True;return io.BytesIO(b'chromium\0--user-data-dir=/managed/browser\0')
  assert path.endswith('/stat'),path
  if sampled[0]:
   if failure is not None:raise failure
   return io.StringIO('malformed')
  return io.StringIO('41 (chromium) '+' '.join(['S']+['0']*18+['same']))
 scope['os']=SimpleNamespace(environ={'AGENT_BROWSER_PROFILE':'/managed/browser'},fsencode=original_os.fsencode,fsdecode=original_os.fsdecode,path=original_os.path,listdir=lambda _:['41'],readlink=lambda _:'/usr/lib/chromium/chromium')
 scope['open']=opened
 try:scope['browser_processes']()
 except RuntimeError as error:assert 'state could not be identified safely' in str(error),error
 else:raise AssertionError('Unreadable browser state must fail closed')
`));

test('normal close sends WM_DELETE_WINDOW only to unchanged managed browser PIDs', { skip: !python }, () => check(String.raw`
import ctypes
events=[]; atoms={b'_NET_CLIENT_LIST':1,b'_NET_WM_PID':2,b'WM_PROTOCOLS':3,b'WM_DELETE_WINDOW':4}
class Function:
 def __init__(self,name):self.name=name
 def __call__(self,*args):
  if self.name=='XOpenDisplay':return 11
  if self.name=='XDefaultRootWindow':return 12
  if self.name=='XInternAtom':return atoms[args[1]]
  if self.name=='XSendEvent':
   event=ctypes.cast(args[4],ctypes.POINTER(scope['Event'])).contents.client
   events.append((args[1],event.type,event.message_type,event.format,event.data.l[0],event.data.l[1]))
  return 1
class Library:
 def __getattr__(self,name):
  result=Function(name);setattr(self,name,result);return result
scope['ctypes'].CDLL=lambda _:Library()
scope['property_values']=lambda x,d,w,a:[101,102,103] if a==1 else {101:[41],102:[42],103:[43]}[w]
scope['browser_processes']=lambda:{41:'same',42:'reused',43:'unrelated'}
assert scope['request_window_close']({41:'same',42:'old'})==1
assert events==[(101,33,3,32,4,0)],events
try:scope['request_window_close']({})
except RuntimeError as error:assert 'could not be identified safely' in str(error)
else:raise AssertionError('An unknown visible window must fail closed')
`));

test('browser shutdown waits for exit and leaves unanswered close confirmations running', { skip: !python }, () => check(String.raw`
closed=[];clock=[0];state=[{41:'same'},{41:'same'},{}]
scope['browser_processes']=lambda:state.pop(0) if state else {}
scope['request_window_close']=lambda identities:closed.append(identities) or 1
scope['time'].monotonic=lambda:clock[0]
scope['time'].sleep=lambda _:clock.__setitem__(0,clock[0]+.1)
scope['close_browser'](.3)
assert closed==[{41:'same'}]
scope['browser_processes']=lambda:{41:'same'}
try:scope['close_browser'](.3)
except RuntimeError as error:assert 'confirmation' in str(error)
else:raise AssertionError('A live browser must fail closed')
assert scope['browser_processes']()=={41:'same'}
scope['request_window_close']=lambda _:0
try:scope['close_browser'](.3)
except RuntimeError as error:assert 'not been transferred' in str(error)
else:raise AssertionError('No managed window must fail closed')
`));
