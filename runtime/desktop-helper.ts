// Kept inline so the standalone runner uses the same helper without a runtime image rebuild.
export const DESKTOP_HELPER = String.raw`
import base64, contextlib, ctypes, json, math, os, subprocess, sys, time
from urllib.parse import urlsplit

def check_deadline(spec):
    if 'expiresAt' in spec:
        deadline = spec['expiresAt']
        if type(deadline) not in (int, float) or not math.isfinite(deadline) or deadline <= time.time() * 1000:
            raise RuntimeError('Desktop request expired.')

def browser_processes():
    result = []
    for entry in os.listdir('/proc'):
        if entry.isdigit():
            try:
                cmd = open('/proc/' + entry + '/cmdline', 'rb').read()
                profile = os.environ.get('AGENT_BROWSER_PROFILE', '/workspace/private/.config/chromium')
                if b'chromium' in cmd and b'--type=' not in cmd and ('--user-data-dir=' + profile).encode() in cmd:
                    result.append(int(entry))
            except OSError:
                pass
    return result

def browser_identity():
    for pid in sorted(browser_processes()):
        try:
            fields = open('/proc/' + str(pid) + '/stat').read().rsplit(')', 1)[1].split()
            if fields[0] != 'Z': return {'browserPid': pid, 'browserSessionId': str(pid) + ':' + fields[19]}
        except (OSError, IndexError): pass
    return {'browserPid': None, 'browserSessionId': None}

def pointer_input(spec, action):
    # XTest is already in the pinned image. The fixed protocol never invokes a shell.
    x = ctypes.CDLL('libX11.so.6'); xt = ctypes.CDLL('libXtst.so.6')
    x.XOpenDisplay.argtypes = [ctypes.c_char_p]; x.XOpenDisplay.restype = ctypes.c_void_p
    x.XCloseDisplay.argtypes = [ctypes.c_void_p]
    x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    xt.XTestFakeMotionEvent.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_ulong]
    xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
    display = x.XOpenDisplay(b':99')
    if not display: raise RuntimeError('Private display is unavailable.')
    pressed = False
    def move(px, py):
        if type(px) is not int or type(py) is not int or not 0 <= px < 1440 or not 0 <= py < 900: raise RuntimeError('Pointer outside private display.')
        check_deadline(spec)
        if not xt.XTestFakeMotionEvent(display, -1, px, py, 0): raise RuntimeError('Pointer input failed.')
    def button(number, down):
        if down: check_deadline(spec)
        if not xt.XTestFakeButtonEvent(display, number, int(down), 0): raise RuntimeError('Button input failed.')
        x.XSync(display, 0)
    try:
        check_deadline(spec)
        if action['type'] == 'drag':
            move(action['fromX'], action['fromY']); button(1, True); pressed = True
            for index in range(1, 11):
                move(round(action['fromX'] + (action['toX'] - action['fromX']) * index / 10), round(action['fromY'] + (action['toY'] - action['fromY']) * index / 10))
                x.XSync(display, 0); time.sleep(.015)
        elif action['type'] == 'click':
            move(action['x'], action['y'])
            for index in range(action.get('clickCount', 1)):
                check_deadline(spec); button(2, True); button(2, False)
                if index == 0 and action.get('clickCount') == 2: time.sleep(.08)
        else:
            number = {'left': 6, 'right': 7}[action['direction']]
            for _ in range(action['amount']): check_deadline(spec); button(number, True); button(number, False)
    finally:
        try:
            if pressed: button(1, False)
        finally: x.XCloseDisplay(display)

def main(spec):
    check_deadline(spec)
    if spec['action'] == 'stop':
        sys.path.insert(0, '/opt/open-harness')
        from browser_shutdown import close_browser
        close_browser()
        return {'ok': True}
    if os.environ.get('OPEN_HARNESS_VIRTUAL_DESKTOP') != '1' or os.environ.get('DISPLAY') != ':99':
        raise RuntimeError('Only the private virtual desktop is available.')
    if spec['action'] == 'start':
        if not browser_processes():
            profile = os.environ.get('AGENT_BROWSER_PROFILE', '/workspace/private/.config/chromium')
            os.makedirs(profile, mode=0o700, exist_ok=True)
            # The previous container is confirmed stopped before reusing this profile.
            for name in ('SingletonLock', 'SingletonSocket', 'SingletonCookie'):
                try: os.unlink(os.path.join(profile, name))
                except FileNotFoundError: pass
            downloads = os.environ.get('OPEN_HARNESS_DOWNLOAD_DIR')
            if downloads or spec.get('freshPage'):
                default_profile = os.path.join(profile, 'Default')
                os.makedirs(default_profile, mode=0o700, exist_ok=True)
                preferences_path = os.path.join(default_profile, 'Preferences')
                try:
                    with open(preferences_path) as saved: preferences = json.load(saved)
                except FileNotFoundError: preferences = {}
                if downloads:
                    os.makedirs(downloads, mode=0o700, exist_ok=True)
                    preferences.setdefault('download', {}).update({'default_directory': downloads, 'prompt_for_download': False})
                if spec.get('freshPage'):
                    preferences.setdefault('session', {}).update({'restore_on_startup': 5, 'startup_urls': []})
                    preferences.setdefault('profile', {}).update({'exit_type': 'Normal', 'exited_cleanly': True})
                temporary = preferences_path + '.open-harness-' + str(os.getpid())
                with open(temporary, 'x') as saved: json.dump(preferences, saved)
                os.replace(temporary, preferences_path)
            subprocess.Popen(['chromium', '--no-sandbox', '--disable-dev-shm-usage',
                '--force-renderer-accessibility', '--password-store=basic',
                '--user-data-dir=' + profile, *([] if spec.get('freshPage') else ['--restore-last-session']), 'about:blank'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True)
            deadline = time.monotonic() + 8
            while not browser_identity()['browserSessionId']:
                check_deadline(spec)
                if time.monotonic() >= deadline: raise RuntimeError('Browser startup was not confirmed.')
                time.sleep(.1)
        return {'ok': True, **browser_identity()}
    sys.path.insert(0, '/opt/open-harness')
    from cua_compat import install
    install()
    from tools.computer_use.cua_backend import CuaDriverBackend
    backend = CuaDriverBackend()
    try:
        backend.start()
        if spec['action'] == 'frame':
            cap = backend.capture(mode='vision', app='screen')
            raw = base64.b64decode(cap.png_b64 or '', validate=True)
            if not raw.startswith(b'\x89PNG\r\n\x1a\n') or len(raw) > 6000000:
                raise RuntimeError('Invalid desktop image.')
            return {'ok': True, 'image': 'data:image/png;base64,' + cap.png_b64,
                    'width': cap.width, 'height': cap.height, **browser_identity()}
        if spec['action'] == 'navigate':
            url = spec.get('url', '')
            parsed = urlsplit(url)
            if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or any(ord(char) < 32 for char in url): raise RuntimeError('Invalid browser address.')
            backend.capture(mode='vision')
            for method, value in ((backend.key, 'Control+l'), (backend.type_text, url), (backend.key, 'Enter')):
                check_deadline(spec)
                if not method(value, delivery_mode='foreground').ok: raise RuntimeError('Browser navigation was not accepted.')
            return {'ok': True, **browser_identity()}
        action = spec['input']
        kind = action['type']
        cap = backend.capture(mode='som' if kind in ('click', 'scroll') else 'vision')
        # Setup and capture may outlast the remote request. Never apply delayed input.
        check_deadline(spec)
        if kind == 'drag' or kind == 'click' and action['button'] == 'middle' or kind == 'scroll' and action['direction'] in ('left', 'right'):
            pointer_input(spec, action)
            return {'ok': True}
        if kind == 'click':
            # Screenshots cover the desktop; CUA pointer input addresses the captured window.
            frame = next(element for element in cap.elements if element.role == 'frame')
            x, y = action['x'] - frame.bounds[0], action['y'] - frame.bounds[1]
            if not 0 <= x < frame.bounds[2] or not 0 <= y < frame.bounds[3]:
                raise RuntimeError('Click is outside the active window.')
            result = backend.click(x=int(x), y=int(y), button=action['button'], delivery_mode='foreground')
            if action.get('clickCount') == 2 and result.ok:
                time.sleep(.08); check_deadline(spec)
                result = backend.click(x=int(x), y=int(y), button=action['button'], delivery_mode='foreground')
        elif kind == 'scroll':
            result = backend.scroll(direction=action['direction'], amount=action['amount'], delivery_mode='foreground')
        elif kind == 'key':
            result = backend.key(action['key'], delivery_mode='foreground')
        elif kind == 'text':
            result = backend.type_text(action['text'], delivery_mode='foreground')
        else:
            raise RuntimeError('Unsupported desktop action.')
        if not result.ok:
            raise RuntimeError('Desktop input was not accepted.')
        return {'ok': True}
    finally:
        backend.stop()

try:
    spec = json.loads(sys.stdin.readline(25000))
    with open(os.devnull, 'w') as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        result = main(spec)
    print(json.dumps(result))
except Exception:
    # Input can contain passwords. Never expose driver errors, arguments or capture details.
    print(json.dumps({'error': 'The private desktop did not accept this request. Check its runtime and retry.'}))
    sys.exit(1)
`;
