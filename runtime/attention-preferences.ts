import type { DatabaseSync } from 'node:sqlite';
import type { AttentionPreference } from '../lib/attention-preferences';
import { integer, ProductError, text } from './product-error';

export class AttentionPreferences {
  constructor(private db: DatabaseSync) {
    db.exec('CREATE TABLE IF NOT EXISTS attention_preferences(actor_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,completion_notifications INTEGER NOT NULL CHECK(completion_notifications IN (0,1)))');
  }
  get(actorId: string): AttentionPreference {
    const row = this.db.prepare('SELECT revision,completion_notifications FROM attention_preferences WHERE actor_id=?').get(text(actorId, 'Account identity', 255)) as { revision: number; completion_notifications: number } | undefined;
    return row ? { revision: row.revision, completionNotifications: Boolean(row.completion_notifications) } : { revision: 0, completionNotifications: true };
  }
  update(actorId: string, input: { revision?: unknown; completionNotifications?: unknown }): AttentionPreference {
    const id = text(actorId, 'Account identity', 255), revision = integer(input.revision, 'Preference revision', 0, Number.MAX_SAFE_INTEGER - 1);
    if (typeof input.completionNotifications !== 'boolean') throw new ProductError('Choose whether to receive completion notifications.');
    const result = revision === 0
      ? this.db.prepare('INSERT OR IGNORE INTO attention_preferences VALUES(?,1,?)').run(id, Number(input.completionNotifications))
      : this.db.prepare('UPDATE attention_preferences SET revision=revision+1,completion_notifications=? WHERE actor_id=? AND revision=?').run(Number(input.completionNotifications), id, revision);
    if (!result.changes) throw new ProductError(`Notification preferences are now at revision ${this.get(id).revision}. Your draft was kept; reload and review the changes before saving.`, 409);
    return this.get(id);
  }
  allows(kind: string, actorId: string) { return kind !== 'completed' || this.get(actorId).completionNotifications; }
}
