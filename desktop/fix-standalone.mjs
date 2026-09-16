import { cp, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

// vinext's standalone tracer currently omits React peer dependencies. They can
// appear to work in a source checkout because Node walks up to the repository's
// node_modules, then fail after the app is copied into an installer or image.
const root = resolve(import.meta.dirname, '..');
const modules = resolve(root, 'dist', 'standalone', 'node_modules');
await mkdir(modules, { recursive: true });
for (const name of ['react', 'react-dom', 'react-server-dom-webpack', 'scheduler']) {
  await cp(resolve(root, 'node_modules', name), resolve(modules, name), { recursive: true, force: true, dereference: true });
}
console.log('Added standalone React runtime dependencies.');
