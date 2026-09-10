import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { importLikersCsv, isLikersCsv } from '../../src/ingest/likers.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { inbound } from '../../src/report/queries.js';
import { makeZip } from '../helpers/makeZip.js';

const HEADER = 'post_number,post_date,post_url,post_shortcode,like_count,username,full_name,user_id';
const csv = (lines: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'lk-')), 'all_instagram_likers.csv');
  writeFileSync(p, [HEADER, ...lines].join('\n') + '\n');
  return p;
};
const NOW = 1_800_000_000;
const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

describe('isLikersCsv', () => {
  it('recognises the file likers.py writes', () => {
    expect(isLikersCsv(HEADER + '\n1,x,y,z,5,bob,Bob,123')).toBe(true);
  });
  it('rejects anything else', () => {
    expect(isLikersCsv('a,b,c\n1,2,3')).toBe(false);
  });
});

describe('importLikersCsv', () => {
  it('imports likes, display names and Instagram ids', () => {
    const db = openDb(':memory:');
    const p = csv([
      '1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,2,alice,Alice Adams,111',
      '1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,2,bob,Bob Brown,222',
    ]);
    const s = importLikersCsv(db, p);

    expect(s.posts).toBe(1);
    expect(s.people).toBe(2);
    expect(s.likeEvents).toBe(2);
    expect(s.completePosts).toBe(1);

    const rows = db.prepare(
      'SELECT username, display_name, instagram_id FROM account ORDER BY username').all() as any[];
    expect(rows).toEqual([
      { username: 'alice', display_name: 'Alice Adams', instagram_id: '111' },
      { username: 'bob', display_name: 'Bob Brown', instagram_id: '222' },
    ]);
  });

  it('marks a post partial when fewer likers came back than Instagram claimed', () => {
    const db = openDb(':memory:');
    // 331 stated, 2 retrieved: deactivated accounts, or a truncated fetch.
    importLikersCsv(db, csv([
      '1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,331,alice,Alice,111',
      '1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,331,bob,Bob,222',
    ]));
    const cap = db.prepare('SELECT complete, expected FROM inbound_capture').get() as any;
    expect(cap.complete).toBe(0);
    expect(cap.expected).toBe(331);
  });

  it('records the like count on my own post, which no export provides', () => {
    const db = openDb(':memory:');
    importLikersCsv(db, csv(['1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,184,alice,Alice,111']));
    const post = db.prepare('SELECT like_count, permalink FROM my_post').get() as any;
    expect(post.like_count).toBe(184);
    expect(post.permalink).toBe('https://ig/p/AAA/');
  });

  it('is idempotent — re-importing adds no duplicate likes', () => {
    const db = openDb(':memory:');
    const p = csv(['1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,1,alice,Alice,111']);
    importLikersCsv(db, p);
    const second = importLikersCsv(db, p);
    expect(second.likeEvents).toBe(0);
    expect((db.prepare("SELECT COUNT(*) c FROM interaction WHERE kind='like_received'")
      .get() as any).c).toBe(1);
  });

  it('shares its dedupe key with the bookmarklet, so the two never double-count', () => {
    const db = openDb(':memory:');
    importLikersCsv(db, csv(['1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,1,alice,Alice,111']));
    const key = (db.prepare('SELECT dedupe_key FROM interaction').get() as any).dedupe_key;
    expect(key).toBe('like_received|alice|https://ig/p/AAA/');
  });

  it('enables real ghost detection, because the lists are complete', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [f('alice', 100), f('bob', 200), f('ghosty', 300)] },
    }));
    importLikersCsv(db, csv([
      '1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,2,alice,Alice,111',
      '1,2026-09-06 21:35:26,https://ig/p/AAA/,AAA,2,bob,Bob,222',
    ]));

    const r = inbound(db, NOW);
    expect(r.ghosts.map((g) => g.username)).toEqual(['ghosty']);
    expect(r.superfans.find((s) => s.username === 'alice')!.likesReceived).toBe(1);
  });
});
