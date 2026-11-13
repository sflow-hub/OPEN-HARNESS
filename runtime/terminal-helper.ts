// The host only transports bytes. The PTY and fixed shell are created inside the execution container.
export const TERMINAL_HELPER = String.raw`
import base64, errno, fcntl, json, os, pty, select, signal, struct, sys, termios, time
pid, master = pty.fork()
if pid == 0:
    os.chdir('/workspace/shared')
    os.environ.update(TERM='xterm-256color', HISTFILE='/dev/null')
    os.execv('/bin/bash', ['bash', '--noprofile', '--norc', '-i'])
def emit(value):
    sys.stdout.write(json.dumps(value, separators=(',', ':')) + '\n')
    sys.stdout.flush()
pending = bytearray()
def terminate(_signal, _frame):
    raise SystemExit()
signal.signal(signal.SIGTERM, terminate)
try:
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
    while True:
        ready, _, _ = select.select([0, master], [], [], 1)
        if 0 in ready:
            chunk = os.read(0, 8192)
            if not chunk: break
            pending.extend(chunk)
            if len(pending) > 65536: raise ValueError()
            while b'\n' in pending:
                line, _, rest = pending.partition(b'\n')
                pending = bytearray(rest)
                item = json.loads(line)
                if item.get('type') == 'input':
                    value = base64.b64decode(item['data'], validate=True)
                    if len(value) > 16384: raise ValueError()
                    while value:
                        written = os.write(master, value)
                        value = value[written:]
                elif item.get('type') == 'resize':
                    rows, cols = item['rows'], item['cols']
                    if type(rows) is not int or type(cols) is not int or not 1 <= rows <= 200 or not 1 <= cols <= 500: raise ValueError()
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', rows, cols, 0, 0))
                else: raise ValueError()
        if master in ready:
            try: chunk = os.read(master, 4096)
            except OSError as error:
                if error.errno != errno.EIO: raise
                chunk = b''
            if not chunk: break
            emit({'type': 'output', 'data': base64.b64encode(chunk).decode('ascii')})
except (BrokenPipeError, EOFError, OSError, ValueError, KeyError, TypeError):
    pass
finally:
    os.close(master)
    try: os.killpg(pid, signal.SIGHUP)
    except ProcessLookupError: pass
    deadline = time.monotonic() + 1
    while time.monotonic() < deadline:
        # Keep the child unreaped until group signaling ends, so its PID cannot be reused.
        if os.waitid(os.P_PID, pid, os.WEXITED | os.WNOHANG | os.WNOWAIT): break
        time.sleep(.02)
    try: os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError: pass
    _, status = os.waitpid(pid, 0)
    try: emit({'type': 'exit', 'code': os.waitstatus_to_exitcode(status)})
    except (BrokenPipeError, OSError): pass
`;
