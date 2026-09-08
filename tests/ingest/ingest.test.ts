import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestArchive } from '../../src/ingest/ingest.js';
import { makeZip } from '../helpers/makeZip.js';

const archive = () => makeZip({
  'connections/followers_and_following/followers_1.json': {
    relationships_followers: [
      { title: '', string_list_data: [{ href: 'h', value: 'alice', timestamp: 100 }] },
    ],
  },
  'your_instagram_activity/likes/liked_posts.json': {
    likes_media_likes: [
      { title: 'bob', string_list_data: [{ href: 'https://ig/p/1/', value: '❤️', timestamp: 300 }] },
    ],
  },
});

const count = (db: any, t: string) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;

describe('ingestArchive', () => {
  it('loads accounts, edges and interactions', async () => {
    const db = openDb(':memory:');
    const { skipped } = await ingestArchive(db, archive());
    expect(skipped).toBe(false);
    expect(count(db, 'account')).toBe(2);      // alice, bob
    expect(count(db, 'follow_edge')).toBe(1);
    expect(count(db, 'interaction')).toBe(1);
  });

  it('skips an archive it has already ingested', async () => {
    const db = openDb(':memory:');
    const zip = archive();
    await ingestArchive(db, zip);
    const second = await ingestArchive(db, zip);
    expect(second.skipped).toBe(true);
    expect(count(db, 'snapshot')).toBe(1);
  });

  it('does not double-count interactions across two distinct but overlapping archives', async () => {
    const db = openDb(':memory:');
    await ingestArchive(db, archive());
    // A later export re-reports the same all-time like, plus one new one.
    await ingestArchive(db, makeZip({
      'your_instagram_activity/likes/liked_posts.json': {
        likes_media_likes: [
          { title: 'bob', string_list_data: [{ href: 'https://ig/p/1/', value: '❤️', timestamp: 300 }] },
          { title: 'bob', string_list_data: [{ href: 'https://ig/p/2/', value: '❤️', timestamp: 900 }] },
        ],
      },
    }));
    expect(count(db, 'interaction')).toBe(2);  // not 3
    expect(count(db, 'snapshot')).toBe(2);     // both archives recorded
  });
});
