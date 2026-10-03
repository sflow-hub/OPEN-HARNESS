import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function supervise(entries, shutdownMs = 20_000) {
  return new Promise(resolveExit => {
    const children = new Set();
    let stopping = false, exitCode = 0, deadline;
    const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const finish = () => {
      clearTimeout(deadline);
      for (const signal of signals) process.off(signal, onSignal);
      resolveExit(exitCode);
    };
    const stop = (code = 0) => {
      if (code) exitCode ||= code;
      if (stopping) return;
      stopping = true;
      for (const child of children) child.kill('SIGTERM');
      if (!children.size) return finish();
      // Coordinator shutdown waits for agent cleanup. Keep the parent alive until
      // both services close, with room inside Compose's 30-second stop grace.
      deadline = setTimeout(() => {
        exitCode ||= 1;
        for (const child of children) child.kill('SIGKILL');
      }, shutdownMs);
    };
    const onSignal = () => stop();
    for (const signal of signals) process.on(signal, onSignal);
    for (const { entry, cwd, env = {} } of entries) {
      const child = spawn(process.execPath, [entry], { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
      children.add(child);
      child.once('error', error => { console.error(`${entry} failed: ${error.message}`); stop(1); });
      child.once('close', (code, signal) => {
        children.delete(child);
        if (!stopping) {
          console.error(`${entry} stopped with ${signal || `code ${code ?? 'unknown'}`}.`);
          stop(code || 1);
        } else if (code) exitCode ||= code;
        if (!children.size) finish();
      });
    }
    if (!children.size) finish();
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await supervise([
    { entry: '/opt/open-harness/runtime/service.mjs', cwd: '/opt/open-harness/runtime', env: { OPEN_HARNESS_PORT: '4317', OPEN_HARNESS_MOCK: '0' } },
    { entry: '/opt/open-harness/app/server.js', cwd: '/opt/open-harness/app', env: { PORT: '3000', HOST: '0.0.0.0' } },
  ]);
}
