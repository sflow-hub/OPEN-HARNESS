import { build, type Loader, type Plugin } from 'esbuild';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix, resolve } from 'node:path';
import { buildDashboardVendor, dashboardPackages } from './local-dashboard-vendor.mjs';
import { ProductError } from './product-error';

const packageRoot = resolve(import.meta.dirname, '../local-dashboard-source');
export const dashboardSourceRoot = existsSync(join(packageRoot, 'open-harness-source.json')) ? packageRoot : resolve(import.meta.dirname, '..');
const rootModule = 'app/page.tsx';
const entry = `import {createRoot} from 'react-dom/client'; import {createElement} from 'react'; import Dashboard from './app/page.tsx'; import './app/globals.css'; createRoot(document.getElementById('local-dashboard')).render(createElement(Dashboard));`;

let vendor: Promise<{js:string;css:string}> | undefined;
function libraries() {
  if (dashboardSourceRoot === packageRoot) {
    return { js: readFileSync(join(packageRoot, 'vendor.js'), 'utf8'), css: readFileSync(join(packageRoot, 'vendor.css'), 'utf8') };
  }
  vendor ||= buildDashboardVendor(dashboardSourceRoot).catch((error: Error) => { vendor = undefined; throw error; });
  return vendor!;
}

// Inputs come exclusively from a frozen revision. Never follow candidate aliases,
// tsconfig plugins, package exports, absolute paths or imports into the coordinator.
function sources(root: string, included: Set<string>): Plugin {
  return { name: 'dashboard-source', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      const name = args.path;
      if (dashboardPackages.includes(name)) return { path: name, namespace: 'vendor' };
      if (name === 'tailwindcss' || name === '@xterm/xterm/css/xterm.css') return { path: name, namespace: 'vendor-style' };
      if (!name.startsWith('./') && !name.startsWith('../') && !name.startsWith('@/')) throw new Error(`This dashboard cannot import ${name}.`);
      const base = name.startsWith('@/') ? name.slice(2) : posix.join(posix.dirname(args.importer), name);
      const path = [base, base + '.tsx', base + '.ts', posix.join(base, 'index.tsx'), posix.join(base, 'index.ts')].find(candidate =>
        /^(?:app\/(?:page\.tsx|globals\.css)$|(?:components|lib)\/[a-zA-Z0-9_./-]+\.(?:ts|tsx|css)$)/.test(candidate) &&
        !candidate.split('/').some(part => part === '.' || part === '..' || part.startsWith('.')) && existsSync(join(root, candidate)));
      if (!path) throw new Error(`No dashboard source found for ${name} in ${args.importer}.`);
      return { path, namespace: 'source' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'vendor' }, ({path}) => {
      const load = `globalThis.__openHarnessModules[${JSON.stringify(path)}]()`;
      return { contents: path === '@novnc/novnc' ? `export default (await ${load}).default;` : `module.exports = ${load};`, loader: 'js' };
    });
    builder.onLoad({ filter: /.*/, namespace: 'vendor-style' }, () => ({ contents: '', loader: 'css' }));
    builder.onLoad({ filter: /.*/, namespace: 'source' }, ({path}) => {
      included.add(path);
      const loader: Loader = path.endsWith('.module.css') ? 'local-css' : path.split('.').pop() as Loader;
      return { contents: readFileSync(join(root, path), 'utf8'), loader };
    });
  }};
}
export type DashboardAssets = { js: string; css: string; check: string };
export async function compileDashboard(root: string, changed: string[], removed: string[] = [], base?: string): Promise<DashboardAssets> {
  const graph = async (directory: string) => {
    const included = new Set<string>();
    const output = await build({ stdin: { contents: entry, sourcefile: 'entry.ts' }, bundle: true, platform: 'browser', target: 'es2022', minify: true, jsx: 'automatic', format: 'esm',
      plugins: [sources(directory, included)], tsconfigRaw: {}, logLevel: 'silent', outdir: 'bundle', write: false, legalComments:'none',
      define: { 'process.env.NODE_ENV': '"production"', 'process.env.NEXT_PUBLIC_OPEN_HARNESS_CLOUD': '"0"', 'process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED': JSON.stringify(process.env.OPEN_HARNESS_DEPLOYMENT === 'compose' ? '1' : '0') } });
    return { included, output };
  };
  const { included, output } = await graph(root);
  const original = removed.length && base ? (await graph(base)).included : new Set<string>();
  const outside = changed.find(path => !included.has(path) && !(removed.includes(path) && original.has(path)));
  if (outside) throw new ProductError(`The dashboard build does not use ${outside}. Ask for a change to a visible dashboard feature.`, 409);
  if (!included.has(rootModule)) throw new Error('The dashboard entry is missing.');
  return { js: output.outputFiles.find(file => file.path.endsWith('.js'))!.text, css: output.outputFiles.find(file => file.path.endsWith('.css'))!.text, check: `Dashboard build passed. Compiled ${included.size} source files and checked the changed files against the running interface.` };
}
export async function dashboardDocument(assets: DashboardAssets, preview: boolean) {
  const deps = await libraries();
  const script = (source: string) => source.replace(/<\/script/gi, '<\\/script');
  // The surrounding review dialog explains the offline workspace. A live
  // reconnect alert inside the isolated preview would tell the owner to repair it.
  const previewStyle = preview ? '\n#local-dashboard .offline-banner { display: none !important; }' : '';
  const css = (deps.css + '\n' + assets.css + previewStyle).replace(/<\/style/gi, '<\\/style');
  const offline = preview ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none';"><script>
    for(const key of ['localStorage','sessionStorage']) { const values=new Map([['open-harness.onboarding.v1','done'],['open-harness.assistant-home','1']]);Object.defineProperty(window,key,{value:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,String(v)),removeItem:k=>values.delete(k),clear:()=>values.clear(),key:i=>[...values.keys()][i]??null,get length(){return values.size;}}}); }
    </script>` : '';
  const recovery = preview ? '' : `<a href="/?original=1" id="edition-recovery">Open original dashboard</a><script>const original=new URL(location.href);original.pathname='/';original.searchParams.set('original','1');document.getElementById('edition-recovery').href=original.href;</script>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">${offline}<meta name="viewport" content="width=device-width,initial-scale=1"><title>Open Harness</title><style>${css}\n#edition-recovery{position:fixed;right:8px;bottom:6px;z-index:2147483647;background:#191a1d;color:white;font:12px system-ui;padding:5px 8px;border-radius:4px}</style></head><body><div id="local-dashboard"></div>${recovery}<script type="module">${script(deps.js)}</script><script type="module">${script(assets.js)}</script></body></html>`;
}
