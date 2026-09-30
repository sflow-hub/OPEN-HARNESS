import base64
import json
import os
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, '/opt/open-harness')
from cua_compat import install
install()
from tools.computer_use.cua_backend import CuaDriverBackend

class Fixture(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'''<!doctype html><title>Compose private desktop proof</title>
<style>body{font:24px sans-serif;padding:40px}button,input{font:inherit;padding:12px}</style>
<button onclick="this.textContent='CLICK_CONFIRMED_729'">Activate</button>
<input aria-label="Acceptance text">''')
    def log_message(self, *args): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
threading.Thread(target=server.serve_forever, daemon=True).start()
def browser(*args):
    return subprocess.check_output(['agent-browser', '--session', 'compose-desktop', *args], text=True, timeout=30).strip()

backend = CuaDriverBackend()
try:
    # Apps may open through a terminal/browser tool before the first desktop tool.
    emulated = (os.environ.get('AGENT_BROWSER_EXECUTABLE_PATH') == '/usr/lib/chromium/chromium' and
                os.environ.get('AGENT_BROWSER_ARGS') == '--force-renderer-accessibility,--disable-gpu,--no-zygote,--disable-dev-shm-usage')
    browser('--headed', *([] if emulated else ['--args', '--force-renderer-accessibility']), 'open', f'http://127.0.0.1:{server.server_port}/')
    assert browser('get', 'text', 'button') == 'Activate'
    browser('screenshot', '/workspace/shared/compose-browser.png')
    backend.start()
    for attempt in range(30):
        snapshot = backend.capture(mode='som', app='chromium')
        button = next((item for item in snapshot.elements if item.label == 'Activate'), None)
        if button is not None: break
        time.sleep(.25)
    else: raise AssertionError(f'Chromium accessibility did not become ready: {[(item.role,item.label) for item in snapshot.elements]}')
    assert button.element_token
    assert backend.click(element=button.index).ok
    assert browser('get', 'text', 'button') == 'CLICK_CONFIRMED_729'
    snapshot = backend.capture(mode='som', app='chromium')
    field = next(item for item in snapshot.elements if item.label == 'Acceptance text')
    assert backend.click(element=field.index).ok
    assert backend.type_text('COMPOSE_DESKTOP_729', delivery_mode='foreground').ok
    assert browser('get', 'value', 'input') == 'COMPOSE_DESKTOP_729'
    screenshot = backend.capture(mode='vision', app='screen')
    raw = base64.b64decode(screenshot.png_b64)
    assert raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw) > 1000
    Path('/workspace/shared/compose-desktop.png').write_bytes(raw)
    print(json.dumps({'clickReadback': 'CLICK_CONFIRMED_729', 'typeReadback': 'COMPOSE_DESKTOP_729', 'screenshotBytes': len(raw)}))
finally:
    backend.stop()
    server.shutdown()
    server.server_close()
