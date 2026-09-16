import { spawn } from 'node:child_process';

const children = [];
function start(entry, cwd, env = {}) {
  const child = spawn(process.execPath, [entry], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  child.once('exit', code => { if (!stopping) { console.error(`${entry} stopped with code ${code ?? 'unknown'}.`); stop(code || 1); } });
}
let stopping = false;
function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(code), 1000).unref();
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
start('/opt/open-harness/runtime/service.mjs', '/opt/open-harness/runtime', { OPEN_HARNESS_PORT: '4317' });
start('/opt/open-harness/app/server.js', '/opt/open-harness/app', { PORT: '3000', HOST: '0.0.0.0' });
