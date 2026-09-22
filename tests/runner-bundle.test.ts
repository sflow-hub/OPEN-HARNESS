import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');

// runtime/runner.mjs is a committed build artifact of runtime/runner.ts, and the
// coordinator serves it verbatim to newly paired machines from /v1/install/file.
// Nothing else checks the two agree, so editing runner.ts (or anything it imports,
// such as runtime/hermes.ts) and forgetting `npm run runner:bundle` silently ships
// stale code to every remote runner. Rebuild in memory and compare.
test('the committed runner bundle matches its sources', async () => {
  const result = await build({
    entryPoints: [resolve(root, 'runtime', 'runner.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'external',
    sourcemap: false,
    banner: { js: "import { createRequire as __openHarnessCreateRequire } from 'node:module'; const require = __openHarnessCreateRequire(import.meta.url);" },
    write: false,
  });
  const rebuilt = result.outputFiles[0].text;
  const committed = readFileSync(resolve(root, 'runtime', 'runner.mjs'), 'utf8');
  assert.equal(
    rebuilt,
    committed,
    'runtime/runner.mjs is out of date with runtime/runner.ts — run "npm run runner:bundle" and commit the result.',
  );
});
