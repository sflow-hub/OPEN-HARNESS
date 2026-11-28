import { copyFile, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editableSource } from '../runtime/capture-local-source.mjs';
import { buildDashboardVendor } from '../runtime/local-dashboard-vendor.mjs';

const root = await realpath(resolve(import.meta.dirname, '..'));
const manifestName = 'open-harness-source.json';

const esbuildTargets = {
  'aarch64-apple-darwin': 'darwin-arm64', 'x86_64-apple-darwin': 'darwin-x64',
  'aarch64-unknown-linux-gnu': 'linux-arm64', 'x86_64-unknown-linux-gnu': 'linux-x64',
  'aarch64-pc-windows-msvc': 'win32-arm64', 'x86_64-pc-windows-msvc': 'win32-x64',
};

export async function prepareLocalDashboard(bundle, desktopTarget = '') {
  const source = join(bundle, 'local-dashboard-source');
  const modules = join(bundle, 'node_modules');
  const runtime = join(bundle, 'runtime');
  await mkdir(bundle, { recursive: true });
  await mkdir(source);
  await mkdir(runtime, { recursive: true });

  const manifest = await readFile(join(root, manifestName), 'utf8');
  const { files } = JSON.parse(manifest);
  if (!Array.isArray(files) || !files.includes('app/page.tsx') || !files.includes('app/globals.css')) throw Error('Incomplete dashboard source manifest.');
  const seen = new Set();
  for (const path of files) {
    if (typeof path !== 'string' || !editableSource(path) || path === 'README.md' || seen.has(path.toLowerCase())) throw Error(`Invalid dashboard source path: ${path}`);
    seen.add(path.toLowerCase());
    const input = join(root, path);
    if (!(await lstat(input)).isFile() || await realpath(input) !== input) throw Error(`Dashboard source must be an ordinary file: ${path}`);
    await mkdir(dirname(join(source, path)), { recursive: true });
    await copyFile(input, join(source, path));
  }
  await writeFile(join(source, manifestName), manifest);
  const vendor = await buildDashboardVendor(root);
  await writeFile(join(source, 'vendor.js'), vendor.js);
  await writeFile(join(source, 'vendor.css'), vendor.css);
  for (const name of ['capture-local-source.mjs', 'local-dashboard-vendor.mjs']) {
    await copyFile(join(root, 'runtime', name), join(runtime, name));
  }

  // esbuild resolves its native program relative to its JS package. Ship the
  // lockfile-installed modules separately from agent-editable browser source.
  const require = createRequire(join(root, 'package.json'));
  const esbuildManifest = require.resolve('esbuild/package.json');
  const esbuildRoot = dirname(esbuildManifest);
  const esbuild = JSON.parse(await readFile(esbuildManifest, 'utf8'));
  const esbuildRequire = createRequire(esbuildManifest);
  const jsRoot = join(modules, 'esbuild');
  await mkdir(join(jsRoot, 'lib'), { recursive: true });
  for (const path of ['package.json', 'LICENSE.md', 'lib/main.js']) {
    await copyFile(join(esbuildRoot, path), join(jsRoot, path));
  }

  const native = `@esbuild/${process.platform}-${process.arch}`;
  const installed = new Set();
  for (const name of Object.keys(esbuild.optionalDependencies)) {
    let metadata;
    try { metadata = esbuildRequire.resolve(`${name}/package.json`); }
    catch (error) { if (error.code === 'MODULE_NOT_FOUND' && name !== native) continue; throw error; }
    const pkg = JSON.parse(await readFile(metadata, 'utf8'));
    if (pkg.name !== name || pkg.version !== esbuild.version) throw Error(`Reinstall the locked esbuild dependency for ${name}.`);
    const binary = name.startsWith('@esbuild/win32-') ? 'esbuild.exe' : 'bin/esbuild';
    const target = join(modules, name);
    await mkdir(dirname(join(target, binary)), { recursive: true });
    await copyFile(metadata, join(target, 'package.json'));
    await copyFile(join(dirname(metadata), binary), join(target, binary));
    installed.add(name);
  }
  if (desktopTarget && !installed.has(`@esbuild/${esbuildTargets[desktopTarget]}`)) {
    await writeFile(join(source, 'disabled'), `This desktop build cannot compile local dashboard changes. Build the installer on a native ${desktopTarget} machine to enable this feature.\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw Error(`Usage: node scripts/${basename(import.meta.filename)} OUTPUT_DIRECTORY`);
  await prepareLocalDashboard(resolve(process.argv[2]));
}
