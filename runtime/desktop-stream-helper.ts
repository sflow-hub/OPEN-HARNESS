// The RFB process only observes the isolated display. All input uses the coordinator's human lease.
export const DESKTOP_STREAM_HELPER=String.raw`
import base64, contextlib, hashlib, io, os, struct, sys, time
wire = sys.stdout.buffer
source = sys.stdin.buffer
def read(size):
    value = bytearray()
    while len(value) < size:
        chunk = source.read(size - len(value))
        if not chunk: raise EOFError()
        value.extend(chunk)
    return bytes(value)
def send(value):
    wire.write(value)
    wire.flush()
def length(value):
    output = bytearray()
    for index in range(3):
        part = value & 127 if index < 2 else value & 255
        value >>= 7 if index < 2 else 8
        output.append(part | (128 if value and index < 2 else 0))
        if not value: break
    return bytes(output)
backend = None
quiet = open(os.devnull, 'w')
failed = False
try:
    if os.environ.get('OPEN_HARNESS_VIRTUAL_DESKTOP') != '1' or os.environ.get('DISPLAY') != ':99': raise RuntimeError()
    sys.path.insert(0, '/opt/open-harness')
    with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
        from cua_compat import install
        install()
        from tools.computer_use.cua_backend import CuaDriverBackend
        backend = CuaDriverBackend()
        backend.start()
    send(b'RFB 003.008\n')
    if read(12) != b'RFB 003.008\n': raise RuntimeError()
    send(b'\x01\x01')
    if read(1) != b'\x01': raise RuntimeError()
    send(struct.pack('>I', 0))
    read(1)
    name = b'Open Harness private desktop (input through human control)'
    send(struct.pack('>HHBBBBHHHBBBxxxI',1440,900,32,24,0,1,255,255,255,0,8,16,len(name))+name)
    encodings = set()
    previous = None
    last = 0
    while True:
        kind = read(1)[0]
        if kind == 0:
            value = read(19)
            if value[3] != 32 or value[6] != 1: raise RuntimeError()
        elif kind == 2:
            _, count = struct.unpack('>BH',read(3))
            if count > 256: raise RuntimeError()
            encodings = set(struct.unpack('>'+'i'*count,read(count*4)))
        elif kind == 3:
            incremental,x,y,width,height = struct.unpack('>BHHHH',read(9))
            # Always send a complete frame; coordinates and clipboard content never enter recordings.
            delay = .2 - (time.monotonic()-last)
            if delay > 0: time.sleep(delay)
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                cap = backend.capture(mode='vision',app='screen')
            raw = base64.b64decode(cap.png_b64 or '',validate=True)
            if cap.width != 1440 or cap.height != 900 or len(raw)>6000000: raise RuntimeError()
            fingerprint = hashlib.sha256(raw).digest()
            last = time.monotonic()
            if incremental and fingerprint == previous:
                send(b'\x00\x00\x00\x00')
                continue
            previous = fingerprint
            if -260 in encodings:
                payload = b'\xa0'+length(len(raw))+raw
                encoding = -260
            else:
                from PIL import Image
                payload = Image.open(io.BytesIO(raw)).convert('RGBA').tobytes()
                encoding = 0
            send(b'\x00\x00\x00\x01'+struct.pack('>HHHHi',0,0,1440,900,encoding)+payload)
        elif kind == 4: read(7)
        elif kind == 5: read(5)
        elif kind == 6:
            value = read(7)
            size = struct.unpack('>I',value[3:])[0]
            if size>65536: raise RuntimeError()
            read(size)
        else: raise RuntimeError()
except (EOFError,BrokenPipeError):
    pass
except Exception:
    failed = True
    print('The private desktop stream could not continue.', file=sys.stderr)
finally:
    if backend:
        try:
            with contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
                backend.stop()
        except Exception:
            if not failed: print('The private desktop stream could not continue.', file=sys.stderr)
            failed = True
    quiet.close()
if failed: raise SystemExit(1)
`;
