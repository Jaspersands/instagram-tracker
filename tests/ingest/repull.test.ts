import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { importLikersCsv } from '../../src/ingest/likers.js';

const HEAD = 'post_number,post_date,post_url,post_shortcode,like_count,username,full_name,user_id';
const write = (lines: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'repull-')), 'likers.csv');
  writeFileSync(p, [HEAD, ...lines].join('\n') + '\n');
  return p;
};
const row = (shortcode: string, likeCount: number, user: string) =>
  `1,2026-09-01 10:00:00,https://www.instagram.com/p/${shortcode}/,${shortcode},${likeCount},${user},${user} R,${user.length}00`;

const captures = (db: ReturnType<typeof openDb>) =>
  (db.prepare("SELECT COUNT(*) AS c FROM inbound_capture WHERE kind='post_likes'").get() as { c: number }).c;

/**
 * Pulling only your most recent posts means the same post is imported over and
 * over. That has to be a no-op, not an accumulation.
 */
describe('re-pulling the same posts', () => {
  it('updates the capture instead of adding another', () => {
    const db = openDb(':memory:');
    importLikersCsv(db, write([row('AAA', 2, 'ann'), row('AAA', 2, 'bob')]));
    expect(captures(db)).toBe(1);
    importLikersCsv(db, write([row('AAA', 2, 'ann'), row('AAA', 2, 'bob')]));
    expect(captures(db)).toBe(1);
  });

  it('does not double-count the likes', () => {
    const db = openDb(':memory:');
    const csv = write([row('AAA', 2, 'ann'), row('AAA', 2, 'bob')]);
    importLikersCsv(db, csv);
    const second = importLikersCsv(db, csv);
    expect(second.likeEvents).toBe(0);
    const n = (db.prepare("SELECT COUNT(*) AS c FROM interaction WHERE kind='like_received'")
      .get() as { c: number }).c;
    expect(n).toBe(2);
  });

  it('picks up people who liked since the last pull', () => {
    // The whole point of a small recent window: catch what changed.
    const db = openDb(':memory:');
    importLikersCsv(db, write([row('AAA', 2, 'ann'), row('AAA', 2, 'bob')]));
    const later = importLikersCsv(db, write([
      row('AAA', 3, 'ann'), row('AAA', 3, 'bob'), row('AAA', 3, 'cleo'),
    ]));
    expect(later.likeEvents).toBe(1);
    expect(captures(db)).toBe(1);
  });

  it('refreshes completeness when a fuller list arrives', () => {
    const db = openDb(':memory:');
    // Instagram claimed 4 likes, we got 1: partial, so its absences prove nothing.
    importLikersCsv(db, write([row('AAA', 4, 'ann')]));
    expect((db.prepare('SELECT complete FROM inbound_capture').get() as { complete: number }).complete).toBe(0);
    importLikersCsv(db, write([
      row('AAA', 4, 'ann'), row('AAA', 4, 'bob'), row('AAA', 4, 'cleo'), row('AAA', 4, 'dev'),
    ]));
    expect((db.prepare('SELECT complete FROM inbound_capture').get() as { complete: number }).complete).toBe(1);
    expect(captures(db)).toBe(1);
  });

  it('keeps each post its own capture', () => {
    const db = openDb(':memory:');
    importLikersCsv(db, write([row('AAA', 1, 'ann'), row('BBB', 1, 'bob'), row('CCC', 1, 'cleo')]));
    expect(captures(db)).toBe(3);
    importLikersCsv(db, write([row('AAA', 1, 'ann')]));
    expect(captures(db)).toBe(3);
  });

  it('leaves bookmarklet captures alone, which are genuinely separate events', () => {
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO inbound_capture (captured_at, kind, permalink, complete, expected, raw_json)
       VALUES (?, 'post_likes', 'https://ig/p/Z/', 1, 1, '{}')`);
    ins.run(1000);
    ins.run(2000);
    // Two scrolls of the same list days apart really are two captures, so the
    // bookmarklet path sets no key and must keep inserting.
    expect(captures(db)).toBe(2);
  });
});
