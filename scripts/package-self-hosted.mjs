import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { browserCompose, validateImageLock } from './release-images.mjs';

function command(binary, args, cwd, env) {
  const result = spawnSync(binary, args, { cwd, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || `${binary} failed`);
  return result.stdout.trim();
}
const requiredSource = ['package-lock.json', 'compose.yaml', 'Dockerfile.coordinator', '.env.example', 'docs/SELF_HOSTING.md', 'runtime/hermes/Dockerfile'];
const browserFiles = ['runtime/dind-entrypoint.sh', 'compose.host-folders.example.yaml', 'docs/LOCAL_BROWSER.md', 'docs/SELF_HOSTING.md', 'LICENSE', 'Start Open Harness.command', 'Start Open Harness.cmd'];
const privateFile = path => /(^|\/)\.env(?:\.|$)/.test(path) && path !== '.env.example' || /(^|\/)(?:\.open-harness[^/]*|node_modules|dist|test-results|playwright-report)(?:\/|$)/.test(path);
const collaborationFile = path => path === 'COORDINATION.md' || path.startsWith('Claude outputs/') || path.startsWith('work/') || path.endsWith('.bundle') || /(?:^|\/)\.DS_Store$/.test(path) || / 2\.[^/]+$/.test(path);

export function releaseSourcePaths(paths) {
  const forbidden = paths.find(privateFile);
  assert.equal(forbidden, undefined, `Release source contains forbidden local state: ${forbidden}`);
  for (const required of requiredSource) assert.ok(paths.includes(required), `Release archive is missing ${required}.`);
  return paths.filter(path => !collaborationFile(path));
}

function regularFiles(directory, prefix = '') {
  return readdirSync(join(directory, prefix)).flatMap(name => {
    const relative = prefix ? `${prefix}/${name}` : name, stat = lstatSync(join(directory, relative));
    assert.ok(!stat.isSymbolicLink(), `Browser package must not contain symlinks: ${relative}`);
    return stat.isDirectory() ? regularFiles(directory, relative) : [relative];
  });
}

export function packageBrowser({ sourceRoot, destination, version, lock, compose }) {
  validateImageLock(lock, version, lock.revision);
  const temporary = mkdtempSync(join(tmpdir(), 'open-harness-browser-package-'));
  const prefix = `open-harness-browser-${version}`, staging = join(temporary, prefix);
  mkdirSync(staging);
  try {
    for (const path of browserFiles) {
      assert.ok(existsSync(join(sourceRoot, path)), `Browser release is missing ${path}.`);
      mkdirSync(join(staging, path, '..'), { recursive: true });
      cpSync(join(sourceRoot, path), join(staging, path));
    }
    assert.ok(existsSync(join(sourceRoot, 'launchers/start.sh')), 'Browser release needs launchers/start.sh.');
    assert.ok(existsSync(join(sourceRoot, 'launchers/start.ps1')), 'Browser release needs launchers/start.ps1.');
    cpSync(join(sourceRoot, 'launchers'), join(staging, 'launchers'), { recursive: true });
    writeFileSync(join(staging, 'compose.yaml'), `${JSON.stringify(browserCompose(compose, lock), null, 2)}\n`);
    writeFileSync(join(staging, 'image-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
    // ZIP extractors on macOS retain these modes; tar does too.
    chmodSync(join(staging, 'Start Open Harness.command'), 0o755);
    for (const file of regularFiles(staging)) {
      assert.ok(!privateFile(file) && !collaborationFile(file), `Unexpected private file in browser release: ${file}`);
      if (file.endsWith('.sh')) chmodSync(join(staging, file), 0o755);
    }
    mkdirSync(destination, { recursive: true });
    command('tar', ['-czf', join(destination, `${prefix}.tar.gz`), prefix], temporary);
    rmSync(join(destination, `${prefix}.zip`), { force: true });
    command('zip', ['-qr', join(destination, `${prefix}.zip`), prefix], temporary);
    return [`${prefix}.tar.gz`, `${prefix}.zip`];
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

function main() {
  const root = resolve(import.meta.dirname, '..');
  const destination = resolve(process.argv[2] || join(root, 'release-assets'));
  const imageLockFile = process.argv[3] && resolve(process.argv[3]);
  const revision = command('git', ['rev-parse', 'HEAD'], root);
  const version = JSON.parse(command('git', ['show', 'HEAD:package.json'], root)).version;
  assert.match(version, /^\d+\.\d+\.\d+-beta\.\d+$/);
  const paths = releaseSourcePaths(command('git', ['ls-tree', '-r', '--name-only', 'HEAD'], root).split('\n'));
  const archive = join(destination, `open-harness-self-hosted-${version}.tar.gz`), prefix = `open-harness-${version}/`;
  mkdirSync(destination, { recursive: true });
  command('git', ['archive', '--format=tar.gz', `--prefix=${prefix}`, `--output=${archive}`, 'HEAD', '--', ...paths], root);
  console.log(basename(archive));
  if (!imageLockFile) return;
  const lock = validateImageLock(JSON.parse(readFileSync(imageLockFile, 'utf8')), version, revision);
  const temporary = mkdtempSync(join(tmpdir(), 'open-harness-release-source-'));
  try {
    command('tar', ['-xzf', archive, '-C', temporary], root);
    const sourceRoot = join(temporary, prefix);
    const emptyEnv = join(temporary, 'compose.env'); writeFileSync(emptyEnv, '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('OPEN_HARNESS_') && !name.startsWith('COMPOSE_')));
    const compose = JSON.parse(command('docker', ['compose', '--env-file', emptyEnv, '-f', join(sourceRoot, 'compose.yaml'), 'config', '--no-interpolate', '--no-path-resolution', '--format', 'json'], sourceRoot, env));
    for (const name of packageBrowser({ sourceRoot, destination, version, lock, compose })) console.log(name);
    writeFileSync(join(destination, 'image-lock.json'), `${JSON.stringify(lock, null, 2)}\n`);
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
