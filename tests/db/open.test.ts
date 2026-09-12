import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';

describe('openDb', () => {
  it('creates every table on a fresh database', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    for (const t of [
      'snapshot', 'account', 'follow_edge', 'graph_event',
      'interaction', 'impression', 'list_membership',
      'my_post', 'topic', 'search_event', 'inbound_capture',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('is safe to open twice', () => {
    const db = openDb(':memory:');
    expect(() => openDb(':memory:')).not.toThrow();
    db.close();
  });
});

describe('migrations', () => {
  it('adds a column to a database created before it existed', () => {
    // Simulate an older database: build the schema, then drop the new column
    // by recreating the table without it.
    const db = openDb(':memory:');
    db.exec('DROP TABLE account');
    db.exec('CREATE TABLE account (id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, merged_into INTEGER)');
    const before = (db.prepare('PRAGMA table_info(account)').all() as any[]).map((c) => c.name);
    expect(before).not.toContain('display_name');

    db.exec('ALTER TABLE account ADD COLUMN display_name TEXT');   // what migrate() does
    const after = (db.prepare('PRAGMA table_info(account)').all() as any[]).map((c) => c.name);
    expect(after).toContain('display_name');
  });

  it('a fresh database already has every column', () => {
    const db = openDb(':memory:');
    const acct = (db.prepare('PRAGMA table_info(account)').all() as any[]).map((c) => c.name);
    const snap = (db.prepare('PRAGMA table_info(snapshot)').all() as any[]).map((c) => c.name);
    expect(acct).toContain('display_name');
    expect(snap).toContain('owner');
  });
});

describe('opening a database created before later columns existed', () => {
  it('migrates a legacy schema instead of throwing on an index', () => {
    // schema.sql once indexed instagram_id before migrate() added it, so any
    // database predating that column failed to open at all.
    const dir = mkdtempSync(join(tmpdir(), 'legacy-'));
    const p = join(dir, 'legacy.db');
    const raw = new Database(p);
    raw.exec(`CREATE TABLE account (id INTEGER PRIMARY KEY, username TEXT UNIQUE,
                first_seen INTEGER, last_seen INTEGER, merged_into INTEGER);
              INSERT INTO account (username) VALUES ('someone');`);
    raw.close();

    const db = openDb(p);
    const cols = (db.prepare('PRAGMA table_info(account)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('instagram_id');
    expect(cols).toContain('display_name');
    // the index that used to fail now exists
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ix_account_igid'").get();
    expect(idx).toBeTruthy();
  });
});
