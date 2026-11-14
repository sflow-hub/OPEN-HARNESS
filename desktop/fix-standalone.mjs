import assert from 'node:assert/strict';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

// vinext's standalone tracer currently omits React peer dependencies. They can
// appear to work in a source checkout because Node walks up to the repository's
// node_modules, then fail after the app is copied into an installer or image.
const root = resolve(import.meta.dirname, '..');
// Compose explicitly selects 0.0.0.0; ordinary native startup stays loopback.
const serverFile = join(root, 'dist', 'standalone', 'server.js');
const serverSource = await readFile(serverFile, 'utf8');
assert.ok(serverSource.includes('process.env.HOST ?? "0.0.0.0"') || serverSource.includes('process.env.HOST ?? "127.0.0.1"'), 'Review the standalone listener default before packaging this vinext version.');
await writeFile(serverFile, serverSource.replace('process.env.HOST ?? "0.0.0.0"', 'process.env.HOST ?? "127.0.0.1"'));
const modules = resolve(root, 'dist', 'standalone', 'node_modules');
await mkdir(modules, { recursive: true });
for (const name of ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler']) {
  await cp(resolve(root, 'node_modules', name), resolve(modules, name), { recursive: true, force: true, dereference: true });
}
console.log('Added standalone React runtime dependencies.');

// vinext copies its build-plugin dependencies into standalone output too. Prove
// these glob build tools are absent from the production import graph before
// removing them; a future runtime import must fail the build instead of shipping
// a server with a missing dependency.
const buildOnly = ['vite-plugin-commonjs', 'vite-plugin-dynamic-import', 'fast-glob', 'micromatch', 'braces', 'fill-range', 'to-regex-range'];
const files = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(item => item.isDirectory() ? files(join(directory, item.name)) : /\.(?:js|mjs)$/.test(item.name) ? [join(directory, item.name)] : []))).flat();
const standalone = resolve(root, 'dist', 'standalone');
const graph = await build({ entryPoints: [join(standalone, 'server.js'), ...await files(join(standalone, 'dist', 'server'))], bundle: true, platform: 'node', format: 'esm', target: 'node22', metafile: true, write: false, outdir: join(standalone, '.dependency-check'), logLevel: 'silent', external: ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler'] });
const imports = Object.keys(graph.metafile.inputs).map(path => path.replaceAll('\\', '/'));
for (const name of buildOnly) {
  assert.ok(!imports.some(path => path.includes(`/node_modules/${name}/`)), `${name} is now a production dependency; review standalone packaging before removing it.`);
  await rm(join(modules, name), { recursive: true, force: true });
}
console.log('Removed unused standalone build-plugin dependencies.');
