import { spawnSync } from 'node:child_process';
import { stopNativeTree } from './hermes';

// PID alone can refer to an unrelated process after a restart. Save the operating
// system's process creation identity before issuing any gateway requests.
export function processIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('Invalid saved native runtime process identity.');
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().ToString("o")`], { encoding: 'utf8', timeout: 5000 })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 5000, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } });
  if (result.error) throw new Error('Could not identify the native runtime process.');
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}
export async function recoverNativeProcess(pid: number, identity: string) {
  const current = processIdentity(pid);
  if (current && current !== identity) return; // This PID has been reused; never signal it.
  if (!current && process.platform === 'win32') throw new Error('The old native runtime exited before its child processes could be checked. Restart this computer before resuming its agents.');
  // On Unix an orphaned process group retains its ID while descendants remain.
  // stopNativeTree also checks that group when its original leader has exited.
  await stopNativeTree(pid);
}
