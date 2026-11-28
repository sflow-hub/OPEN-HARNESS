import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareLocalDashboard } from '../scripts/prepare-local-dashboard.mjs';

test('the installed dashboard carries its reviewed source and compiles offline from the coordinator module directory', async t => {
  const bundle = mkdtempSync(join(tmpdir(), 'oh-dashboard-package-'));
  t.after(() => rmSync(bundle, { recursive: true, force: true }));
  await prepareLocalDashboard(bundle);
  const source = join(bundle, 'local-dashboard-source');
  const manifest = readFileSync(join(source, 'open-harness-source.json'), 'utf8');
  assert.equal(manifest, readFileSync(resolve(import.meta.dirname, '../open-harness-source.json'), 'utf8'));
  const expected = [...JSON.parse(manifest).files, 'open-harness-source.json', 'vendor.css', 'vendor.js'].sort();
  const files = readdirSync(source, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name).slice(source.length + 1).replaceAll('\\', '/')).sort();
  assert.deepEqual(files, expected);
  for (const path of ['app/page.tsx','app/globals.css','components/local-improvements.tsx','components/local-improvements.css','lib/local-improvements.ts']) assert.ok(expected.includes(path), path);
  const runtime = join(bundle, 'runtime');
  assert.ok(existsSync(join(runtime, 'capture-local-source.mjs')));
  assert.ok(readFileSync(join(source, 'vendor.css'), 'utf8').length > 0);
  assert.ok(readFileSync(join(source, 'vendor.js'), 'utf8').includes('__openHarnessModules'));
  // Mirror the coordinator's bundle location and external dependency policy.
  await build({ entryPoints: [resolve(import.meta.dirname, '../runtime/local-dashboard-build.ts')], outfile: join(runtime, 'build.mjs'), bundle: true, format: 'esm', platform: 'node', external: ['esbuild'] });
  const check = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { compileDashboard, dashboardDocument, dashboardSourceRoot } from './build.mjs';
    import { resolve } from 'node:path';
    if (dashboardSourceRoot !== resolve('../local-dashboard-source')) throw Error('Unexpected dashboard source location.');
    const assets = await compileDashboard(dashboardSourceRoot, ['app/page.tsx']);
    const html = await dashboardDocument(assets, true);
    if (!html.includes('__openHarnessModules') || !html.includes(assets.css)) throw Error('Missing preview assets.');
    console.log(assets.check);
  `], { cwd: runtime, encoding: 'utf8', env: { NODE_ENV: 'test', PATH: '', SystemRoot: process.env.SystemRoot } });
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Dashboard build passed/);
});

test('a desktop target without a packaged compiler keeps its dashboard and reports that local compilation is unavailable', async t => {
  const bundle = mkdtempSync(join(tmpdir(), 'oh-dashboard-target-'));
  t.after(() => rmSync(bundle, { recursive: true, force: true }));
  await prepareLocalDashboard(bundle, 'unsupported-target');
  assert.match(readFileSync(join(bundle, 'local-dashboard-source', 'disabled'), 'utf8'), /native unsupported-target/);
  assert.ok(existsSync(join(bundle, 'local-dashboard-source', 'app', 'page.tsx')));
});
