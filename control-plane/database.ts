import { readFile } from 'node:fs/promises';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';

export type Sql = { query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount?: number | null }> };
export type Database = Sql & { transaction<T>(work: (sql: Sql) => Promise<T>): Promise<T> };
export class Postgres implements Database {
  readonly pool: Pool;
  constructor(connectionString: string) { this.pool = new Pool({ connectionString, max: 12, connectionTimeoutMillis: 5000, statement_timeout: 15000 }); }
  query<T extends QueryResultRow = QueryResultRow>(sql: string, values?: unknown[]) { return this.pool.query<T>(sql, values); }
  async transaction<T>(work: (sql: Sql) => Promise<T>) { const client: PoolClient = await this.pool.connect(); try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async migrate() { await this.transaction(async sql => { await sql.query('SELECT pg_advisory_xact_lock(7849123)'); const exists = await sql.query("SELECT to_regclass('public.schema_version') AS name"); if (exists.rows[0].name) { const version = await sql.query('SELECT max(version) AS version FROM schema_version'); if (Number(version.rows[0].version) > 1) throw new Error('This control-plane database requires a newer Open Harness release.'); } await sql.query(await readFile(new URL('./schema.sql', import.meta.url), 'utf8')); }); }
}
