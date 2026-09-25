import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] || 'release-assets');
// An explicit argument wins over the ambient environment. The release workflow passes only
// the directory and relies on the variables, so this changes nothing there — but with the
// old precedence any CI job that set GITHUB_REF_NAME overrode what a caller asked for, so
// tests/release-packaging.test.ts saw its "v0.3.0" become the branch name and failed on
// every push to a branch.
const tag = process.argv[3] || process.env.GITHUB_REF_NAME;
const repository = process.argv[4] || process.env.GITHUB_REPOSITORY;
if (!tag || !repository) throw new Error('Release tag and GitHub repository are required.');

async function files(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else result.push(path);
  }
  return result;
}
const all = await files(directory);
const specs = {
  'linux-x86_64': file => file.endsWith('.AppImage.tar.gz'),
  'darwin-x86_64': file => file.endsWith('.app.tar.gz') && file.toLowerCase().includes('macos-x64'),
  'darwin-aarch64': file => file.endsWith('.app.tar.gz') && file.toLowerCase().includes('macos-arm64'),
  'windows-x86_64': file => file.endsWith('.nsis.zip'),
};
const platforms = {};
for (const [platform, matches] of Object.entries(specs)) {
  const artifact = all.find(matches);
  if (!artifact) throw new Error(`Missing updater artifact for ${platform}.`);
  const signaturePath = `${artifact}.sig`;
  if (!all.includes(signaturePath)) throw new Error(`Missing signature for ${artifact}.`);
  const name = artifact.split(/[\\/]/).pop();
  platforms[platform] = { signature: (await readFile(signaturePath, 'utf8')).trim(), url: `https://github.com/${repository}/releases/download/${tag}/${encodeURIComponent(name)}` };
}
await writeFile(join(directory, 'latest.json'), JSON.stringify({ version: tag.replace(/^v/, ''), notes: `Open Harness ${tag}`, pub_date: new Date().toISOString(), platforms }, null, 2) + '\n');
console.log('Created signed latest.json update manifest.');
