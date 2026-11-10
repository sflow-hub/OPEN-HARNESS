import './docker-path.mjs';
import { spawn } from 'node:child_process';

export type CommandResult = { status: number | null; stdout: string; stderr: string; error?: Error };
export function commandAsync(name: string, args: string[], timeout = 10_000, options: { cwd?: string; input?: string; maxBytes?: number } = {}): Promise<CommandResult> {
  return new Promise(resolve => {
    const child = spawn(name, args, { cwd: options.cwd, stdio: ['pipe', 'pipe', 'pipe'], timeout, killSignal: 'SIGKILL', windowsHide: true });
    let stdout = '', stderr = '', error: Error | undefined, settled = false;
    const limit = options.maxBytes ?? 2_000_000;
    const done = (status: number | null) => { if (!settled) { settled = true; resolve({ status, stdout, stderr, error }); } };
    const append = (chunk: Buffer, stream: 'stdout' | 'stderr') => {
      if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > limit) { error = new Error(`${name} returned too much output.`); stdout = ''; stderr = ''; child.kill('SIGKILL'); }
    };
    child.stdout.on('data', chunk => append(chunk, 'stdout')); child.stderr.on('data', chunk => append(chunk, 'stderr'));
    child.once('error', value => { error = value; done(null); }); child.once('close', done);
    child.stdin.on('error', () => {}); child.stdin.end(options.input);
  });
}
