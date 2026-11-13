import base64
import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit


def resource_snapshot(stage):
    counters = {}
    for name in ('pids.current', 'pids.max', 'pids.events', 'memory.current', 'memory.max', 'memory.events'):
        try:
            with open('/sys/fs/cgroup/' + name) as handle:
                counters[name] = handle.read(2048).strip()
        except OSError:
            counters[name] = 'unavailable'
    processes, threads, names = 0, 0, {}
    try:
        with os.scandir('/proc') as entries:
            for index, entry in enumerate(entries):
                if index >= 2048:
                    break
                if not entry.name.isdigit():
                    continue
                try:
                    with open(entry.path + '/status') as handle:
                        fields = dict(line.split(':', 1) for line in handle.read(8192).splitlines() if ':' in line)
                    name, count = fields.get('Name', 'unknown').strip(), int(fields.get('Threads', '0'))
                    processes += 1
                    threads += count
                    names[name] = names.get(name, 0) + count
                except (OSError, ValueError):
                    pass
    except OSError:
        pass
    result = {'stage': stage, 'cgroup': counters, 'processes': processes, 'threads': threads, 'threadsByName': names}
    print('Compose desktop resources: ' + json.dumps(result), file=sys.stderr, flush=True)
    return result


class FixtureServer(HTTPServer):
    # Chromium can preconnect without sending a request; bound that idle socket without creating request threads.
    def get_request(self):
        connection, address = super().get_request()
        connection.settimeout(1)
        return connection, address


def check():
    assert os.environ.get('AGENT_BROWSER_PROFILE') == '/workspace/desktop/.config/chromium', 'Use the canonical managed browser profile'
    sys.path.insert(0, '/opt/open-harness')
    from browser_shutdown import browser_processes
    from cua_compat import install
    install()
    from tools.computer_use.cua_backend import CuaDriverBackend

    browser_identity = browser_processes()
    assert len(browser_identity) == 1, 'The coordinator must already have one live managed browser'
    observed = {'clicked': [], 'typed': []}

    class Fixture(BaseHTTPRequestHandler):
        def do_GET(self):
            url = urlsplit(self.path)
            if url.path[1:] in observed:
                values = observed[url.path[1:]]
                values.append(parse_qs(url.query).get('value', [''])[0][:128])
                del values[:-64]
                content = b'ok'
            else:
                content = b'''<!doctype html><title>Compose private desktop proof</title>
<style>body{font:24px sans-serif;padding:40px}button,input{font:inherit;padding:12px}</style>
<button onclick="this.textContent='CLICK_CONFIRMED_729';fetch('/clicked?value='+encodeURIComponent(this.textContent))">Activate</button>
<input aria-label="Acceptance text" oninput="fetch('/typed?value='+encodeURIComponent(this.value))">'''
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.send_header('Content-Length', str(len(content)))
            self.end_headers()
            self.wfile.write(content)

        def log_message(self, *args):
            pass

    def readback(name, expected):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if expected in observed[name]:
                return next(value for value in observed[name] if value == expected)
            time.sleep(.1)
        raise AssertionError('The page did not report the expected ' + name + ' value')

    def screenshot(capture, name):
        raw = base64.b64decode(capture.png_b64, validate=True)
        assert raw.startswith(b'\x89PNG\r\n\x1a\n') and len(raw) > 1000
        Path('/workspace/shared/' + name).write_bytes(raw)
        return len(raw)

    server, worker, backend, serving = None, None, None, False
    try:
        server = FixtureServer(('127.0.0.1', 0), Fixture)
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=.1), daemon=True)
        worker.start()
        serving = True
        backend = CuaDriverBackend()
        backend.start()
        # The coordinator's browser remains the control target; the fixture must not launch a second Chromium.
        backend.capture(mode='vision', app='chromium')
        for method, value in ((backend.key, 'Control+l'), (backend.type_text, f'http://127.0.0.1:{server.server_port}/'), (backend.key, 'Enter')):
            assert method(value, delivery_mode='foreground').ok, 'Managed browser navigation was not accepted'
        for attempt in range(40):
            snapshot = backend.capture(mode='som', app='chromium')
            button = next((item for item in snapshot.elements if item.label == 'Activate'), None)
            if button is not None:
                break
            time.sleep(.25)
        else:
            raise AssertionError('The fixture page did not become accessible in the managed browser')
        screenshot(backend.capture(mode='vision', app='screen'), 'compose-browser.png')
        # Capture again so the element token belongs to the latest accessibility snapshot.
        snapshot = backend.capture(mode='som', app='chromium')
        button = next(item for item in snapshot.elements if item.label == 'Activate')
        assert button.element_token
        assert backend.click(element=button.index).ok
        clicked = readback('clicked', 'CLICK_CONFIRMED_729')
        snapshot = backend.capture(mode='som', app='chromium')
        field = next(item for item in snapshot.elements if item.label == 'Acceptance text')
        assert field.element_token
        assert backend.click(element=field.index).ok
        assert backend.type_text('COMPOSE_DESKTOP_729', delivery_mode='foreground').ok
        typed = readback('typed', 'COMPOSE_DESKTOP_729')
        size = screenshot(backend.capture(mode='vision', app='screen'), 'compose-desktop.png')
        assert browser_processes() == browser_identity, 'The managed browser must survive fixture input unchanged'
        return {'clickReadback': clicked, 'typeReadback': typed, 'screenshotBytes': size, 'browserProfile': os.environ['AGENT_BROWSER_PROFILE'], 'managedBrowserPreserved': True}
    finally:
        try:
            if backend is not None:
                backend.stop()
        finally:
            if server is not None:
                try:
                    if serving:
                        server.shutdown()
                finally:
                    server.server_close()
            if serving:
                worker.join(timeout=2)
                assert not worker.is_alive(), 'The fixture HTTP server did not stop'


if __name__ == '__main__':
    resources = [resource_snapshot('before')]
    try:
        result = check()
    except BaseException:
        resource_snapshot('failure')
        raise
    result['resources'] = resources + [resource_snapshot('after')]
    print(json.dumps(result))
