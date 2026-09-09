import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

/**
 * Columns added after a database already existed. CREATE TABLE IF NOT EXISTS
 * silently does nothing to an existing table, so a new column would be missing
 * on every database but a fresh one — and queries against it fail at runtime,
 * long after the change looked fine in tests.
 */
const ADDED_COLUMNS: { table: string; column: string; ddl: string }[] = [
  { table: 'account', column: 'display_name', ddl: 'ALTER TABLE account ADD COLUMN display_name TEXT' },
  { table: 'snapshot', column: 'owner', ddl: 'ALTER TABLE snapshot ADD COLUMN owner TEXT' },
];

function migrate(db: Db): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length && !cols.some((c) => c.name === column)) db.exec(ddl);
  }
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}
