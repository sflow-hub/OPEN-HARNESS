import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

// D1 batches are ordered SQLite transactions, not Promise.all. Execute the real
// SQL so conditional claims, changes(), uniqueness and rollback stay observable.
export class HostedD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  constructor() { this.sqlite.exec('PRAGMA foreign_keys=ON'); }
  prepare(sql: string) { return new HostedStatement(this, sql); }
  async batch(statements: HostedStatement[]) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map(statement => statement.execute());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}
class HostedStatement {
  constructor(private db: HostedD1, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new HostedStatement(this.db, this.sql, values); }
  execute() {
    const result = this.db.sqlite.prepare(this.sql).run(...this.values);
    return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) }, results: [] };
  }
  async run() { return this.execute(); }
  async first<T>() { return this.db.sqlite.prepare(this.sql).get(...this.values) as T | undefined || null; }
  async all<T>() { return { results: this.db.sqlite.prepare(this.sql).all(...this.values) as T[] }; }
}
