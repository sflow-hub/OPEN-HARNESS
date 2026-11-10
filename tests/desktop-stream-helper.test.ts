import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { DESKTOP_STREAM_HELPER } from '../runtime/desktop-stream-helper';

const python = spawnSync('python3', ['--version'], { timeout: 5000, stdio: 'ignore' }).status === 0;
const backend = String.raw`
import sys, types, base64
compat = types.ModuleType('cua_compat')
compat.install = lambda: None
sys.modules['cua_compat'] = compat
module = types.ModuleType('tools.computer_use.cua_backend')
class Backend:
    def start(self):
        assert sys.stdout.fileno() >= 0
        assert sys.stderr.fileno() >= 0
        print('private backend startup output')
    def capture(self, **kwargs):
        assert sys.stdout.fileno() >= 0
        return types.SimpleNamespace(width=1440, height=900, png_b64=base64.b64encode(b'fixture PNG').decode())
    def stop(self):
        assert sys.stdout.fileno() >= 0
        print('private backend shutdown output')
module.CuaDriverBackend = Backend
sys.modules['tools.computer_use.cua_backend'] = module
`;
test('RFB helper preserves real descriptors for CUA and ignores remote keyboard, mouse and clipboard input', { skip: !python }, () => {
  const encoding = Buffer.alloc(8); encoding[0] = 2; encoding.writeUInt16BE(1, 2); encoding.writeInt32BE(-260, 4);
  const clipboard = Buffer.from([6, 0, 0, 0, 0, 0, 0, 6, ...Buffer.from('secret')]);
  const update = Buffer.from([3, 0, 0, 0, 0, 0, 5, 160, 3, 132]);
  const input = Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1]), encoding, Buffer.from([4, 1, 0, 0, 0, 0, 0, 65]), Buffer.from([5, 1, 0, 1, 0, 1]), clipboard, update]);
  const child = spawnSync('python3', ['-c', backend + DESKTOP_STREAM_HELPER], { input, env: { ...process.env, OPEN_HARNESS_VIRTUAL_DESKTOP: '1', DISPLAY: ':99' }, timeout: 5000 });
  assert.equal(child.status, 0, String(child.stderr)); assert.equal(child.stderr.length, 0);
  assert.equal(child.stdout.subarray(0, 12).toString(), 'RFB 003.008\n');
  assert.ok(child.stdout.includes(Buffer.from('fixture PNG'))); assert.ok(!child.stdout.includes(Buffer.from('private backend'))); assert.ok(!child.stdout.includes(Buffer.from('secret')));
});
test('RFB startup failure emits a generic diagnostic without exception details', { skip: !python }, () => {
  const child = spawnSync('python3', ['-c', backend.replace("assert sys.stdout.fileno() >= 0", "raise RuntimeError('private credential detail')") + DESKTOP_STREAM_HELPER], { input: '', env: { ...process.env, OPEN_HARNESS_VIRTUAL_DESKTOP: '1', DISPLAY: ':99' }, timeout: 5000 });
  assert.equal(child.status, 1); assert.equal(child.stdout.length, 0); assert.equal(child.stderr.toString().trim(), 'The private desktop stream could not continue.');
});
