import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('creates a signed cross-platform desktop update manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-harness-release-'));
  const artifacts = [
    'open-harness-linux-x64-app.AppImage.tar.gz',
    'open-harness-macos-x64-app.app.tar.gz',
    'open-harness-macos-arm64-app.app.tar.gz',
    'open-harness-windows-x64-app.nsis.zip',
  ];
  for (const artifact of artifacts) { writeFileSync(join(directory, artifact), 'artifact'); writeFileSync(join(directory, `${artifact}.sig`), `signature-${artifact}`); }
  const result = spawnSync(process.execPath, ['desktop/create-update-manifest.mjs', directory, 'v0.3.0', 'example/open-harness'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']);
  assert.match(manifest.platforms['windows-x86_64'].url, /releases\/download\/v0\.3\.0/);
  assert.match(manifest.platforms['darwin-aarch64'].signature, /macos-arm64/);
});
