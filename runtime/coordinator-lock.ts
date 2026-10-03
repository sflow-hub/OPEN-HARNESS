import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function acquireCoordinatorLock(stateDirectory: string): () => void {
  const path = join(stateDirectory, 'coordinator.lock.db');
  const db = new DatabaseSync(path);
  try {
    // Keep this separate from state.db: recovery must never touch another live
    // coordinator's state. The OS releases this lock even after a forced exit.
    db.exec('PRAGMA busy_timeout=0; PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE;');
    chmodSync(path, 0o600);
  } catch (error) {
    db.close();
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6) {
      throw new Error(`Another coordinator already owns this state directory: ${stateDirectory}`, { cause: error });
    }
    throw error;
  }
  let closed = false;
  return () => {
    if (closed) return;
    db.close();
    closed = true;
  };
}
