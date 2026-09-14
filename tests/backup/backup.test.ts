import { describe, it, expect } from 'vitest';
import { mkdtempSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../../src/db/open.js';
import { backupDb, prune, listBackups } from '../../src/backup/backup.js';

const populated = () => {
  const dir = mkdtempSync(join(tmpdir(), 'bk-'));
  const db = openDb(join(dir, 'live.db'));
  db.prepare('INSERT INTO account (username) VALUES (?)').run('someone');
  return db;
};

describe('backupDb', () => {
  it('writes a snapshot that opens as a real database', () => {
    const out = mkdtempSync(join(tmpdir(), 'bkout-'));
    const r = backupDb(populated(), out);
    expect(r.reason).toBe('ok');
    expect(existsSync(r.path as string)).toBe(true);
    // A torn copy opens and then fails; prove this one is queryable.
    const copy = new Database(r.path as string, { readonly: true });
    const row = copy.prepare('SELECT username FROM account').get() as { username: string };
    expect(row.username).toBe('someone');
  });

  it('keeps only the newest few', () => {
    const out = mkdtempSync(join(tmpdir(), 'bkout-'));
    const db = populated();
    for (let i = 0; i < 8; i++) {
      backupDb(db, out, 3, new Date(Date.UTC(2026, 0, 1, 0, 0, i)));
    }
    const left = readdirSync(out).filter((n) => n.endsWith('.db'));
    expect(left).toHaveLength(3);
    expect(left.sort().reverse()[0]).toContain('00-07');
  });

  it('reports instead of throwing when the directory is unusable', () => {
    // A failed backup must not fail the ingest that requested it.
    const r = backupDb(populated(), '/dev/null/nope');
    expect(r.path).toBeNull();
    expect(r.reason).not.toBe('ok');
  });

  it('lists what it has, newest first', () => {
    const out = mkdtempSync(join(tmpdir(), 'bkout-'));
    const db = populated();
    backupDb(db, out, 5, new Date(Date.UTC(2026, 0, 1)));
    backupDb(db, out, 5, new Date(Date.UTC(2026, 5, 1)));
    const l = listBackups(out);
    expect(l).toHaveLength(2);
    expect(l[0].name).toContain('2026-06-01');
    expect(l[0].size).toBeGreaterThan(0);
  });

  it('ignores unrelated files in the folder', () => {
    const out = mkdtempSync(join(tmpdir(), 'bkout-'));
    writeFileSync(join(out, 'notes.txt'), 'keep me');
    writeFileSync(join(out, 'other.db'), 'not ours');
    backupDb(populated(), out, 1);
    expect(prune(out, 1)).toEqual([]);
    expect(existsSync(join(out, 'notes.txt'))).toBe(true);
    expect(existsSync(join(out, 'other.db'))).toBe(true);
  });
});
