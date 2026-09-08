import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

export type Db = Database.Database;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
  return db;
}
