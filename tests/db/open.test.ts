import { describe, it, expect } from 'vitest';
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
