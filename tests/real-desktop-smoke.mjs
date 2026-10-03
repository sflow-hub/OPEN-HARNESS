// Opt in after harness:setup: OPEN_HARNESS_DESKTOP_SMOKE=1
// node --import tsx tests/real-desktop-smoke.mjs
// Real Chromium and Hermes computer-use backend against an isolated local page;
// no model/provider credentials, host desktop access, or published ports.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { draftProfile } from '../lib/agent-profile.ts';
import { ensureContainer } from '../runtime/hermes.ts';
import { prepareProfile } from '../runtime/profile-runtime.ts';
import { HERMES_IMAGE } from '../runtime/readiness.ts';

assert.equal(process.env.OPEN_HARNESS_DESKTOP_SMOKE, '1', 'Set OPEN_HARNESS_DESKTOP_SMOKE=1 to run real browser/desktop acceptance.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const root = mkdtempSync(join(tmpdir(), 'open-harness-desktop-smoke-'));
const agentId = `desktop-smoke-${randomUUID().slice(0, 8)}`;
let name;
const createdIds = new Set();
const agent = id => { const profile = draftProfile({ id, name: id, role: 'Desktop fixture', description: '', tone: 0, instructions: '', memory: [] }); profile.computer.desktop = 'virtual'; profile.allowedTools = ['computer_use']; return profile; };
const profile = agent(agentId), other = agent(`${agentId}-other`);
const hostSentinel = join(root, 'host-only.txt');
writeFileSync(hostSentinel, 'host-private');
const runFile = promisify(execFile);
const logs = [];
const command = async (args, timeout = 30_000) => {
  try {
    const result = await runFile('docker', args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 });
    logs.push({ args, stdout: result.stdout, stderr: result.stderr });
    return result.stdout.trim();
  } catch (error) {
    logs.push({ args, error: String(error), stdout: error.stdout, stderr: error.stderr });
    throw error;
  }
};
const run = (args, timeout) => command(['exec', name, ...args], timeout);
mkdirSync(join(root, 'shared'));
for (const selected of [profile, other]) prepareProfile(root, selected, { provider: 'mock', model: 'unused', baseUrl: '', credentialRef: 'MODEL_KEY' }, { environment: () => ({ MODEL_KEY: `credential-${selected.id}` }) }, 'fixture-token', 'fixture-run');
const configPath = join(root, 'agents', agentId, 'profile/config.yaml');
writeFileSync(configPath, JSON.stringify({ ...JSON.parse(readFileSync(configPath, 'utf8')), browser: { cloud_provider: 'local' } }));
writeFileSync(join(root, 'shared', 'check.py'), String.raw`
import base64, contextlib, io, json, os, subprocess, sys, threading, time
from dataclasses import asdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tools.browser_tool import browser_navigate, browser_snapshot
from tools.computer_use.cua_backend import CuaDriverBackend
from tools.computer_use.doctor import run_doctor

sys.path.insert(0, '/opt/open-harness')
from cua_compat import install
install()
root = Path('/workspace/shared')
html = b"""<!doctype html><html><head><title>Open Harness desktop fixture</title>
<style>body{font:24px sans-serif;padding:32px}button,input{font:inherit;padding:12px}</style></head>
<body><h1>Desktop acceptance</h1><button id="activate" onclick="document.getElementById('result').textContent='CLICK_CONFIRMED_729'">Activate</button>
<p id="result">Waiting</p><input id="input" aria-label="Acceptance text"></body></html>"""
class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(html)
    def log_message(self, *args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f'http://127.0.0.1:{server.server_port}/'
def browser(*args):
    return subprocess.check_output(['agent-browser', '--session', 'desktop-smoke', *args], text=True, timeout=30).strip()
def image(cap, filename):
    raw = base64.b64decode(cap.png_b64 or '')
    assert raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw) > 1000, f'{filename}: missing screenshot'
    assert cap.width > 100 and cap.height > 100
    (root / filename).write_bytes(raw)
    return {'file': filename, 'width': cap.width, 'height': cap.height, 'bytes': len(raw)}
backend = CuaDriverBackend()
try:
    output = io.StringIO()
    with contextlib.redirect_stdout(output): status = run_doctor(json_output=True)
    doctor = json.loads(output.getvalue())
    assert status == 0 and doctor['overall'] == 'ok', doctor
    (root / 'doctor.json').write_text(json.dumps(doctor, indent=2))
    navigate = json.loads(browser_navigate(url, task_id='browser-smoke'))
    assert navigate.get('success') and navigate.get('title') == 'Open Harness desktop fixture', navigate
    snapshot = json.loads(browser_snapshot(task_id='browser-smoke'))
    assert snapshot.get('success') and 'Activate' in snapshot.get('snapshot', ''), snapshot
    # An accessible visible Chromium window exercises real X11/AT-SPI control.
    emulated = (os.environ.get('AGENT_BROWSER_EXECUTABLE_PATH') == '/usr/lib/chromium/chromium' and
                os.environ.get('AGENT_BROWSER_ARGS') == '--force-renderer-accessibility,--disable-gpu,--no-zygote,--disable-dev-shm-usage')
    browser('--headed', *([] if emulated else ['--args', '--force-renderer-accessibility']), 'open', url)
    browser('screenshot', '/workspace/shared/browser.png')
    backend.start()
    desktop = image(backend.capture(mode='vision', app='screen'), 'desktop.png')
    cap = backend.capture(mode='som', app='chromium')
    window = image(cap, 'window.png')
    frame = next(e for e in cap.elements if e.role == 'frame')
    button = next(e for e in cap.elements if e.label == 'Activate')
    def click(element, frame):
        # AT-SPI bounds use desktop coordinates; pixel input uses window pixels.
        x = element.bounds[0] + element.bounds[2] // 2 - frame.bounds[0]
        y = element.bounds[1] + element.bounds[3] // 2 - frame.bounds[1]
        result = backend.click(x=x, y=y, delivery_mode='foreground')
        assert result.ok, result
        return asdict(result)
    clicked = click(button, frame)
    for attempt in range(30):
        if browser('get', 'text', '#result') == 'CLICK_CONFIRMED_729': break
        time.sleep(.1)
    else: raise AssertionError('Desktop click reported success but did not affect the page.')
    browser('eval', "document.getElementById('result').textContent='Waiting'")
    cap = backend.capture(mode='som', app='chromium')
    button = next(e for e in cap.elements if e.label == 'Activate')
    assert button.element_token, 'Accessibility actions need a snapshot-bound token.'
    calls = []
    call_tool = backend._session.call_tool
    def observe(name, args):
        calls.append((name, dict(args)))
        return call_tool(name, args)
    backend._session.call_tool = observe
    try: ax_clicked = backend.click(element=button.index)
    finally: backend._session.call_tool = call_tool
    assert ax_clicked.ok, ax_clicked
    assert any(name == 'click' and args.get('element_token') == button.element_token for name, args in calls), calls
    assert browser('get', 'text', '#result') == 'CLICK_CONFIRMED_729', 'Accessibility click must change the actual page.'
    cap = backend.capture(mode='som', app='chromium')
    old_click = next(args for name, args in calls if name == 'click')
    stale = call_tool('click', old_click)
    assert stale.get('isError') and stale.get('structuredContent', {}).get('refusal', {}).get('code') == 'stale_element_token', stale
    field = next(e for e in cap.elements if e.label == 'Acceptance text')
    click(field, next(e for e in cap.elements if e.role == 'frame'))
    typed = backend.type_text('DESKTOP_TYPED_729', delivery_mode='foreground')
    assert typed.ok, typed
    assert browser('get', 'value', '#input') == 'DESKTOP_TYPED_729', 'Desktop typing must change the actual input.'
    after = image(backend.capture(mode='som', app='chromium'), 'window-after.png')
    evidence = {'browserNavigate': navigate, 'browserSnapshot': snapshot, 'desktop': desktop, 'window': window,
        'after': after, 'desktopClick': clicked, 'desktopAXClick': asdict(ax_clicked), 'elementTokenForwarded': True, 'staleElementTokenRefused': True,
        'desktopType': asdict(typed), 'doctor': doctor['overall'],
        'clickReadback': 'CLICK_CONFIRMED_729', 'typeReadback': 'DESKTOP_TYPED_729'}
    (root / 'capabilities.json').write_text(json.dumps(evidence, indent=2))
finally:
    backend.stop()
    server.shutdown(); server.server_close()
`);

let failure, evidence;
try {
  await command(['image', 'inspect', HERMES_IMAGE]);
  name = ensureContainer(profile.id, root, profile.computer);
  const primary = JSON.parse(await command(['inspect', '-f', '{{json .}}', name])); createdIds.add(primary.Id);
  const second = ensureContainer(other.id, root, other.computer);
  const secondary = JSON.parse(await command(['inspect', '-f', '{{json .}}', second])); createdIds.add(secondary.Id);
  for (const [container, selected, ungranted] of [[name, profile, other], [second, other, profile]]) {
    await command(['exec', container, 'python', '-c', `import os
from pathlib import Path
for path in ${JSON.stringify([hostSentinel, join(root, 'agents', ungranted.id), '/var/run/docker.sock', '/run/user/1000/bus', '/tmp/.X11-unix/X0'])}:
 assert not Path(path).exists(), path
assert os.environ['DISPLAY'] == ':99'
assert os.environ['DBUS_SESSION_BUS_ADDRESS'] == 'unix:path=/tmp/open-harness-session-bus'
assert 'credential-${selected.id}' in Path('/home/hermes/.hermes/.env').read_text()
Path('/workspace/private/owner').write_text('${selected.id}')
`]);
  }
  assert.notEqual(primary.Id, secondary.Id);
  for (const current of [primary, secondary]) {
    assert.equal(current.HostConfig.Privileged, false);
    assert.deepEqual(current.HostConfig.CapDrop, ['ALL']);
    assert.ok(current.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(current.Mounts.length, 4);
    assert.equal(current.HostConfig.PidMode, '');
    assert.notEqual(current.HostConfig.IpcMode, 'host');
    assert.equal(Object.keys(current.HostConfig.PortBindings || {}).length, 0);
  }
  await run(['sh', '-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do test -S /tmp/open-harness-session-bus && exit 0; sleep 1; done; exit 1']);
  await run(['python3', '/workspace/shared/check.py'], 180_000);
  const capabilities = JSON.parse(readFileSync(join(root, 'shared', 'capabilities.json'), 'utf8'));
  assert.match(await run(['xwininfo', '-root', '-tree']), /Open Harness desktop fixture/);
  assert.doesNotMatch(await command(['exec', second, 'xwininfo', '-root', '-tree']), /Open Harness desktop fixture/);
  await run(['sh', '-c', 'printf desktop-one > /workspace/shared/shared-desktop-proof']);
  assert.equal(await command(['exec', second, 'cat', '/workspace/shared/shared-desktop-proof']), 'desktop-one');
  await command(['restart', '--timeout', '10', name]);
  await run(['sh', '-c', 'for i in 1 2 3 4 5 6 7 8 9 10; do xdpyinfo -display :99 >/dev/null 2>&1 && test -S /tmp/open-harness-session-bus && exit 0; sleep 1; done; exit 1']);
  const afterRestart = JSON.parse(await run(['hermes', 'computer-use', 'doctor', '--json']));
  assert.equal(afterRestart.overall, 'ok', 'The virtual desktop must recover after restarting its container.');
  const replacement = ensureContainer(profile.id, root, { ...profile.computer, desktop: 'none' });
  const revoked = JSON.parse(await command(['inspect', '-f', '{{json .}}', replacement])); createdIds.add(revoked.Id);
  assert.notEqual(revoked.Id, primary.Id);
  assert.equal(await command(['exec', replacement, 'sh', '-c', 'test ! -S /tmp/.X11-unix/X99 && test -z "$DISPLAY" && cat /workspace/private/owner']), agentId);
  evidence = { ok: true, mode: 'production per-agent containers, real Chromium and Hermes virtual-desktop integration; no model inference', root, image: HERMES_IMAGE, capabilities, restartReady: true, hostAndOtherAgentFilesIsolated: true, desktopWindowsIsolated: true, sharedFilesPreserved: true, desktopRevocationReplacesContainer: true };
} catch (error) { failure = error; }
finally {
  if (name && createdIds.size) {
    try { writeFileSync(join(root, 'container.log'), await command(['logs', name])); } catch { /* preserve the original failure */ }
    for (const file of ['xvfb.log', 'openbox.log']) {
      try { await command(['cp', `${name}:/tmp/${file}`, join(root, file)]); } catch { /* startup may not have reached this component */ }
    }
    for (const id of createdIds) { try { await command(['rm', '-f', id]); } catch (error) { if (!String(error.stderr).includes('No such container')) failure ||= error; } }
  }
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ error: failure ? String(failure.stack || failure) : null, logs }, null, 2));
}
if (failure) { console.error(`Desktop acceptance failed; diagnostics: ${root}`); throw failure; }
evidence.containerRemoved = true;
writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
