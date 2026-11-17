import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import lock from './model-lock.json' with { type: 'json' };

const architecture = process.argv[2] || ({ x64: 'amd64', arm64: 'arm64' })[process.arch];
const archive = lock.runtime[architecture];
if (!archive?.sha256) throw new Error('The Atlas CPU runtime supports Linux AMD64 and ARM64.');
const url = lock.runtime.repository + '/releases/download/' + lock.runtime.tag + '/' + archive.file;
const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
if (!response.ok) throw new Error('Could not download the pinned llama.cpp runtime (HTTP ' + response.status + ').');
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(bytes).digest('hex') !== archive.sha256) throw new Error('The llama.cpp archive checksum did not match.');
await writeFile('runtime.tgz', bytes);
await mkdir('/opt/llama', { recursive: true });
const prefix = 'llama-' + lock.runtime.tag + '/';
const files = execFileSync('tar', ['-tzf', 'runtime.tgz'], { encoding: 'utf8' }).split('\n')
  .filter(path => path.startsWith(prefix))
  .filter(path => /^(llama-server|LICENSE[^/]*|lib(?:ggml[^/]*|llama|llama-common|llama-server-impl|mtmd)\.so(?:\.[\d.]+)?)$/.test(path.slice(prefix.length)));
if (!files.includes(prefix + 'llama-server') || !files.includes(prefix + 'LICENSE')) throw new Error('Unexpected llama.cpp archive layout.');
execFileSync('tar', ['-xzf', 'runtime.tgz', '-C', '/opt/llama', '--strip-components=1', ...files]);
