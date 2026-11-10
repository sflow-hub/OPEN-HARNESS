import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile.ts';
import { executeDesktopCommand } from '../runtime/desktop-control.ts';
import { ensureContainerAsync, runningAgentContainer, stopAgentContainers } from '../runtime/hermes.ts';
import { runningDesktopContainer } from '../runtime/computer-runtime.ts';
import { prepareProfile } from '../runtime/profile-runtime.ts';

assert.equal(process.env.OPEN_HARNESS_DESKTOP_CONTROL_SMOKE, '1', 'Set OPEN_HARNESS_DESKTOP_CONTROL_SMOKE=1 to exercise real private desktop input and shared browser persistence.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'This acceptance test must use the real Docker runtime.');
const root = mkdtempSync(join(process.env.OPEN_HARNESS_SMOKE_DIR || tmpdir(), 'harness-desktop-control-'));
const suffix = crypto.randomUUID().slice(0, 8), ids = [], profiles = [];
const profile = name => {
  const result = draftProfile({ id: `desktop-control-${suffix}-${name}`, name, role: 'Fixture', description: '', tone: 0, instructions: '', memory: [] });
  result.computer.desktop = 'virtual'; if (name !== 'private') result.computer.browserSessionTeamId = `fixture-${suffix}`;
  profiles.push(result); return result;
};
const first = profile('first'), second = profile('second'), isolated = profile('private');
for (const selected of profiles) prepareProfile(root, selected, selected.model, { environment: () => ({}) }, 'fixture-token', 'fixture-run');
mkdirSync(join(root, 'shared'), { recursive: true });
let failure;
const fixture = String.raw`
import http.server, json, urllib.parse
html = b'''<!doctype html><html><head><title>Desktop control acceptance</title></head><body>
<h1>Desktop control acceptance</h1><label>Acceptance text<input aria-label="Acceptance text" id="marker" autofocus style="font-size:24px"></label>
<script>const field=document.getElementById('marker');field.value=localStorage.getItem('harness-marker')||'';
fetch('/page?v='+crypto.randomUUID());
fetch('/observed?v='+encodeURIComponent(field.value));field.oninput=()=>{localStorage.setItem('harness-marker',field.value);fetch('/typed?v='+encodeURIComponent(field.value));};</script></body></html>'''
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        url=urllib.parse.urlparse(self.path)
        if url.path in ('/typed','/observed','/page'):
            with open('/tmp'+url.path+'.json','w') as out: json.dump(urllib.parse.parse_qs(url.query).get('v',[''])[0],out)
            self.send_response(200);self.end_headers();self.wfile.write(b'ok')
        else:
            self.send_response(200);self.send_header('Content-Type','text/html');self.end_headers();self.wfile.write(html)
    def log_message(self,*args):pass
http.server.HTTPServer(('127.0.0.1',8877),Handler).serve_forever()
`;
const fieldLocation = String.raw`
import contextlib,io,json,sys
sys.path.insert(0,'/opt/open-harness')
from cua_compat import install
install()
from tools.computer_use.cua_backend import CuaDriverBackend
b=CuaDriverBackend()
try:
    with contextlib.redirect_stdout(io.StringIO()):
        b.start();cap=b.capture(mode='som',app='chromium')
        field=next(e for e in cap.elements if e.label=='Acceptance text' and e.role not in ('label','static text'))
    print(json.dumps({'x':int(field.bounds[0]+field.bounds[2]/2),'y':int(field.bounds[1]+field.bounds[3]/2)}))
finally:b.stop()
`;
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 25_000, stdio: ['ignore', 'pipe', 'pipe'] });
async function open(selected) {
  await executeDesktopCommand(root, selected, { action: 'start' });
  const container = await runningDesktopContainer(selected.id, root, selected.computer); assert.ok(container); ids.push(container);
  docker(['exec', '-d', container, 'python', '-c', fixture]);
  await executeDesktopCommand(root, selected, { action: 'input', input: { type: 'key', key: 'Control+l' } });
  await executeDesktopCommand(root, selected, { action: 'input', input: { type: 'text', text: 'http://127.0.0.1:8877/' } });
  await executeDesktopCommand(root, selected, { action: 'input', input: { type: 'key', key: 'Enter' } });
  return container;
}
async function observed(container, file, expected) {
  const deadline = Date.now() + 20_000;
  do { try { if (JSON.parse(docker(['exec', container, 'cat', '/tmp/' + file])) === expected) return; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); } while (Date.now() < deadline);
  assert.fail(`Desktop fixture did not observe the expected ${file} value.`);
}
try {
  const container = await open(first);
  await observed(container, 'observed.json', '');
  const frame = await executeDesktopCommand(root, first, { action: 'frame' });
  assert.match(frame.image, /^data:image\/png;base64,/); assert.ok(frame.width > 100 && frame.height > 100);
  const point = JSON.parse(docker(['exec', container, 'timeout', '20s', 'python', '-c', fieldLocation]));
  await executeDesktopCommand(root, first, { action: 'input', input: { type: 'click', ...point, button: 'left' } });
  await executeDesktopCommand(root, first, { action: 'input', input: { type: 'text', text: 'DESKTOP_SHARED_ACCEPTANCE_729' } });
  await observed(container, 'typed.json', 'DESKTOP_SHARED_ACCEPTANCE_729');
  const pageIdentity = docker(['exec', container, 'cat', '/tmp/page.json']);
  const browserIdentity = (await executeDesktopCommand(root, first, { action: 'frame' })).browserSessionId;
  assert.ok(browserIdentity, 'The real helper must identify the live browser process.');
  await ensureContainerAsync(first.id, root, first.computer);
  const execution = await runningAgentContainer(first.id, root); assert.ok(execution); ids.push(execution);
  docker(['exec', execution, 'python', '-c', "from pathlib import Path; Path('/workspace/private/cli-install-proof').write_text('persistent-cli')"]);
  docker(['exec', '-d', execution, 'python', '-c', "import os,time; from pathlib import Path; child=os.fork(); os._exit(0) if child else None; os.setsid(); Path('/workspace/private/detached.pid').write_text(str(os.getpid())); time.sleep(300)"]);
  let detached = false;
  for (const deadline = Date.now() + 5000; Date.now() < deadline;) { try { docker(['exec', execution, 'python', '-c', "import os; from pathlib import Path; os.kill(int(Path('/workspace/private/detached.pid').read_text()),0)"]); detached = true; break; } catch {} await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.ok(detached, 'A detached task process must be alive before testing takeover cleanup.');
  await stopAgentContainers(first.id, root);
  assert.equal(await runningAgentContainer(first.id, root), null, 'Detached task processes must stop before human control.');
  assert.equal(await runningDesktopContainer(first.id, root, first.computer), container);
  assert.equal((await executeDesktopCommand(root, first, { action: 'frame' })).browserSessionId, browserIdentity);
  await executeDesktopCommand(root, first, { action: 'input', input: { type: 'text', text: '_HUMAN' } });
  await observed(container, 'typed.json', 'DESKTOP_SHARED_ACCEPTANCE_729_HUMAN');
  assert.equal(docker(['exec', container, 'cat', '/tmp/page.json']), pageIdentity, 'The page must not reload during takeover.');
  await ensureContainerAsync(first.id, root, first.computer);
  assert.equal(await runningAgentContainer(first.id, root), execution);
  assert.equal(docker(['exec', execution, 'cat', '/workspace/private/cli-install-proof']), 'persistent-cli');
  await stopAgentContainers(first.id, root);
  assert.equal((await executeDesktopCommand(root, first, { action: 'frame' })).browserSessionId, browserIdentity);
  assert.equal(docker(['exec', container, 'cat', '/tmp/page.json']), pageIdentity);
  await executeDesktopCommand(root, second, { action: 'start' });
  assert.equal(await runningDesktopContainer(second.id, root, second.computer), container, 'Opted-in teammates reuse one live desktop.');
  await executeDesktopCommand(root, second, { action: 'stop' });
  const privateContainer = await open(isolated); await observed(privateContainer, 'observed.json', '');
  assert.notEqual(privateContainer, container);
  console.log(JSON.stringify({ ok: true, fixture: 'real split private computer and CUA input; no paid inference', screenshot: true, clickAndType: true, unchangedBrowserAndPage: true, executionStopConfirmed: true, cliInstallPersists: true, sharedDesktopReused: true, unsharedBrowserIsolation: true }));
} catch (error) { failure = error; }
finally {
  for (const selected of profiles) await executeDesktopCommand(root, selected, { action: 'reset' }).catch(() => {});
  if (ids.length) try { docker(['rm', '-f', ...new Set(ids)]); } catch (error) { failure ||= error; }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ root, error: failure ? String(failure.stack || failure) : null }, null, 2));
}
if (failure) { console.error(`Desktop control acceptance failed; diagnostics: ${root}`); throw failure; }
