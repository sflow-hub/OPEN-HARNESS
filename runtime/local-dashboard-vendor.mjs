import { build } from 'esbuild';

// Only dependencies from the installed distribution enter the compiler. Candidate
// package manifests, bundler plugins and npm scripts are never loaded.
export const dashboardPackages = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', 'lucide-react', 'react-markdown', 'remark-gfm', '@novnc/novnc', '@xterm/xterm', '@xterm/addon-fit'];
export async function buildDashboardVendor(projectRoot) {
  // Lazy getters keep desktop-only libraries out of the first render.
  const entries = dashboardPackages.map(name => {
    const load = name === '@novnc/novnc' ? 'import' : 'require';
    return `${JSON.stringify(name)}: () => ${load}(${JSON.stringify(name)})`;
  });
  const result = await build({
    absWorkingDir: projectRoot,
    stdin: { contents: `import '@xterm/xterm/css/xterm.css'; import 'tailwindcss/preflight.css'; globalThis.__openHarnessModules = {${entries.join(',')}};`, resolveDir: projectRoot },
    bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    define: { 'process.env.NODE_ENV': '"production"' }, write: false, outdir: 'assets', logLevel: 'silent',
  });
  return { js: result.outputFiles.find(file => file.path.endsWith('.js')).text, css: result.outputFiles.find(file => file.path.endsWith('.css')).text };
}
