import { mkdirSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
const destination = resolve(process.argv[2] || resolve(root, 'release-assets'));
const archive = resolve(destination, `open-harness-self-hosted-${version}.tar.gz`);
const prefix = `open-harness-${version}/`;
mkdirSync(destination, { recursive: true });

const packaged = spawnSync('git', ['archive', '--format=tar.gz', `--prefix=${prefix}`, `--output=${archive}`, 'HEAD'], { cwd: root, encoding: 'utf8' });
if (packaged.status !== 0) throw new Error(packaged.stderr || 'Could not create the self-hosted source archive.');

const listed = spawnSync('tar', ['-tzf', archive], { cwd: root, encoding: 'utf8' });
if (listed.status !== 0) throw new Error(listed.stderr || 'Could not inspect the self-hosted source archive.');
const files = listed.stdout.trim().split('\n').filter(Boolean).map(name => name.startsWith(prefix) ? name.slice(prefix.length) : name);
for (const required of ['package-lock.json', 'compose.yaml', 'Dockerfile.coordinator', '.env.example', 'docs/SELF_HOSTING.md', 'runtime/hermes/Dockerfile']) {
  if (!files.includes(required)) throw new Error(`Release archive is missing ${required}.`);
}
const forbidden = files.find(name => name === '.env' || (name.startsWith('.env.') && name !== '.env.example') || name.startsWith('.open-harness') || name.includes('/.open-harness') || name.startsWith('node_modules/') || name.startsWith('dist/') || name.startsWith('test-results/'));
if (forbidden) throw new Error(`Release archive contains forbidden local state: ${forbidden}`);
console.log(basename(archive));
