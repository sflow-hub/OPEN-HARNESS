import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const lifecycle = new Set(['kill', 'die', 'start', 'restart', 'oom', 'destroy']);
const plannedActions = ['kill', 'die', 'start', 'restart'];

export function soakContainerEvents(containers, record) {
  const services = new Map(Object.entries(containers).map(([service, state]) => [state.id, service]));
  assert.equal(services.size, 3, 'The soak must observe three distinct service containers.');
  const events = [];
  let phase = 'before';
  return {
    add(event) {
      if (!lifecycle.has(event.Action)) return;
      const service = services.get(event.Actor?.ID);
      assert.ok(service && event.Type === 'container', 'Unexpected container lifecycle source.');
      const entry = { service, action: event.Action, containerId: event.Actor.ID, time: event.time, timeNano: String(event.timeNano), exitCode: event.Actor.Attributes?.exitCode, signal: event.Actor.Attributes?.signal };
      events.push(entry); record({ type: 'container-event', event: entry });
      assert.ok(phase === 'restart' && service === 'open-harness', `${service} emitted ${event.Action} outside the planned coordinator restart.`);
      assert.deepEqual(events.map(item => item.action), plannedActions.slice(0, events.length), 'The planned restart included an unexpected lifecycle event.');
      if (entry.action === 'kill') assert.equal(entry.signal, '15', 'The planned coordinator stop must use SIGTERM.');
      if (entry.action === 'die') assert.equal(entry.exitCode, '0', 'The planned coordinator stop did not exit successfully.');
    },
    beforeRestart() { assert.equal(phase, 'before'); assert.equal(events.length, 0); phase = 'restart'; },
    afterRestart() { assert.equal(phase, 'restart'); assert.deepEqual(events.map(item => item.action), plannedActions, 'The planned coordinator restart was not fully observed.'); phase = 'after'; },
    finish() { assert.equal(phase, 'after', 'The planned restart was not observed.'); assert.deepEqual(events.map(item => item.action), plannedActions); return { observed: true, events: [...events] }; },
  };
}

// RestartCount resets on a manual restart. A continuous stream preserves an automatic
// restart on either side of it; an exec marker proves earlier events have been consumed.
export async function monitorSoakContainers({ docker, env, containers, since, record }) {
  const tracker = soakContainerEvents(containers, record), execute = promisify(execFile);
  const filters = Object.values(containers).flatMap(state => ['--filter', `container=${state.id}`]);
  const child = spawn(docker, ['events', '--since', since, '--filter', 'type=container', ...filters, '--format', '{{json .}}'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure, buffer = '', stderr = '', stopping = false, closed = false, stopPromise, marker;
  const reject = error => { failure ||= error; marker?.reject(failure); };
  const healthy = () => { if (failure) throw failure; assert.ok(!closed && child.exitCode === null && child.signalCode === null, 'The container lifecycle stream stopped.'); };
  const ended = new Promise(resolve => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      closed = true;
      if (!stopping) reject(new Error(`The container lifecycle stream stopped (${code ?? signal}): ${stderr}`));
      if (buffer.trim()) reject(new Error('The container lifecycle stream ended with a partial event.'));
      resolve();
    });
  });
  child.stderr.on('data', data => { stderr = (stderr + data).slice(-4096); });
  child.stdout.on('data', data => {
    try {
      buffer += data.toString();
      assert.ok(buffer.length < 1024 * 1024, 'Container lifecycle event exceeded its size limit.');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        tracker.add(event);
        if (marker && event.Actor?.ID === containers['open-harness'].id) {
          if (event.Action === `exec_create: /bin/true ${marker.name}`) marker.execId = event.Actor.Attributes?.execID;
          if (event.Action === 'exec_die' && marker.execId && event.Actor.Attributes?.execID === marker.execId) {
            assert.equal(event.Actor.Attributes.exitCode, '0', 'Container lifecycle synchronization failed.');
            marker.resolve();
          }
        }
      }
    } catch (error) { reject(error); }
  });
  const synchronize = async () => {
    healthy();
    assert.ok(!marker, 'Container lifecycle synchronization is already running.');
    let timer;
    const observed = new Promise((resolve, reject) => {
      marker = { name: `open-harness-soak-sync-${randomUUID()}`, resolve, reject };
      timer = setTimeout(() => reject(new Error('Container lifecycle synchronization timed out.')), 15_000);
    });
    observed.catch(() => {});
    try {
      await execute(docker, ['exec', containers['open-harness'].id, '/bin/true', marker.name], { env, timeout: 15_000, maxBuffer: 4096 });
      await observed; healthy();
    } finally { clearTimeout(timer); marker = null; }
  };
  const close = () => stopPromise ||= (async () => {
    stopping = true;
    if (!closed) child.kill('SIGTERM');
    const timer = setTimeout(() => { reject(new Error('Container lifecycle stream did not stop.')); child.kill('SIGKILL'); }, 5000);
    try { await ended; } finally { clearTimeout(timer); }
  })();
  try { await synchronize(); } catch (error) { await close(); throw error; }
  return {
    pid: child.pid,
    assertHealthy: healthy,
    async beforeRestart() { await synchronize(); tracker.beforeRestart(); },
    async afterRestart() { await synchronize(); tracker.afterRestart(); },
    async finish() { await synchronize(); await close(); if (failure) throw failure; return tracker.finish(); },
    close,
  };
}
