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
  { table: 'inbound_capture', column: 'complete',
    ddl: 'ALTER TABLE inbound_capture ADD COLUMN complete INTEGER NOT NULL DEFAULT 1' },
  { table: 'inbound_capture', column: 'expected',
    ddl: 'ALTER TABLE inbound_capture ADD COLUMN expected INTEGER' },
  { table: 'account', column: 'instagram_id',
    ddl: 'ALTER TABLE account ADD COLUMN instagram_id TEXT' },
  { table: 'my_post', column: 'like_count',
    ddl: 'ALTER TABLE my_post ADD COLUMN like_count INTEGER' },
  { table: 'inbound_capture', column: 'dedupe_key',
    ddl: 'ALTER TABLE inbound_capture ADD COLUMN dedupe_key TEXT' },
];

function migrate(db: Db): void {
  for (const { table, column, ddl } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (cols.length && !cols.some((c) => c.name === column)) db.exec(ddl);
  }

  // Give existing per-post captures the key their re-imports will collide with,
  // so the first pull after this upgrade updates them instead of duplicating.
  // Only the newest row per post is keyed: if a database somehow already holds
  // duplicates, keying them all would make the unique index below fail.
  db.exec(
    `UPDATE inbound_capture
        SET dedupe_key = kind || '|' || permalink
      WHERE dedupe_key IS NULL AND permalink IS NOT NULL AND kind = 'post_likes'
        AND id = (SELECT MAX(c2.id) FROM inbound_capture c2
                   WHERE c2.kind = inbound_capture.kind
                     AND c2.permalink = inbound_capture.permalink)`);

  // This index cannot live in schema.sql: that runs before the ALTER above, so
  // on an existing database it would reference a column that does not exist yet.
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_capture_key ON inbound_capture(dedupe_key)');
}

export function openDb(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  migrate(db);
  return db;
}
