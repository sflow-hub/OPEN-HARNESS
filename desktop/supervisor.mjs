import { spawn } from 'node:child_process';

const children = [];
function start(entry, cwd, env = {}) {
  const child = spawn(process.execPath, [entry], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
  children.push(child);
  child.once('exit', code => { if (!stopping) { console.error(`${entry} stopped with code ${code ?? 'unknown'}.`); stop(code || 1); } });
  return child;
}
let stopping = false;
async function stop(code = 0) {
  if (stopping) return; stopping = true;
  for (const child of children) child.kill('SIGTERM');
  const exited = Promise.all(children.map(child => child.exitCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve))));
  const deadline = new Promise(resolve => setTimeout(resolve, 20_000));
  await Promise.race([exited, deadline]);
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  process.exit(code);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
start('/opt/open-harness/runtime/service.mjs', '/opt/open-harness/runtime', { OPEN_HARNESS_PORT: '4317' });
start('/opt/open-harness/app/server.js', '/opt/open-harness/app', { PORT: '3000', HOST: '0.0.0.0' });
