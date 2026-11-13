import { resolve } from 'node:path';

type Admission = { closed: boolean; pending: Set<Promise<unknown>> };
const workspaces = new Map<string, Admission>();
function workspace(root: string) { const key = resolve(root); let value = workspaces.get(key); if (!value) { value = { closed: false, pending: new Set() }; workspaces.set(key, value); } return value; }
export function assertContainerAdmission(root: string) { if (workspace(root).closed) throw new Error('This workspace is stopping. Its computers cannot start until it restarts.'); }
export function withContainerAdmission<T>(root: string, start: () => Promise<T>): Promise<T> {
  try { assertContainerAdmission(root); } catch (error) { return Promise.reject(error); }
  const value = workspace(root), operation = Promise.resolve().then(start).finally(() => value.pending.delete(operation));
  value.pending.add(operation); return operation;
}
// Fence before yielding: a Docker startup already sent to the daemon must settle before final cleanup lists containers.
export async function closeContainerAdmissions(root: string) { const value = workspace(root); value.closed = true; await Promise.allSettled([...value.pending]); }
