import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

const source = resolve(process.argv[2]);
const destination = resolve(process.argv[3] || 'release-stage');
const prefix = process.argv[4];
if (!source || !prefix) throw new Error('Usage: node desktop/stage-release.mjs SOURCE DESTINATION PREFIX');
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
async function visit(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (/\.(AppImage|deb|rpm|dmg|msi|exe|zip|gz|sig)$/i.test(entry.name)) await cp(path, join(destination, `${prefix}-${basename(path)}`));
  }
}
await visit(source);
