import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { isExportArchive } from '../../src/auto/discover.js';
import { looksIncomplete } from '../../src/derive/sanity.js';
import { unfollowers } from '../../src/report/reports.js';
import { makeZip } from '../helpers/makeZip.js';

const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });
const followersZip = (users: string[]) => makeZip({
  'connections/followers_and_following/followers_1.json':
    { relationships_followers: users.map((u, i) => f(u, 100 + i)) },
});

describe('the watcher must not ingest unrelated archives', () => {
  it('rejects the zips that were actually sitting in Downloads', () => {
    // Every one of these was ingested as an Instagram export and produced a
    // report of 1,115 unfollowers, because the watcher accepted any .zip.
    for (const n of ['KeeperImport.zip', 'Sands Residence.zip', 'SANDS Family Photos.zip',
                     'feed-main.zip', 'supplemental_roll_tc2_2027.zip']) {
      expect(isExportArchive(n), n).toBe(false);
    }
  });

  it('still accepts a real export', () => {
    expect(isExportArchive('instagram-jasper_sands-2026-09-08-jBKMGcaq.zip')).toBe(true);
  });
});

describe('looksIncomplete', () => {
  it('flags a snapshot that lost almost everyone', () => {
    expect(looksIncomplete(1115, 0)).toBe(true);
    expect(looksIncomplete(1115, 12)).toBe(true);
  });

  it('accepts ordinary churn', () => {
    expect(looksIncomplete(1115, 1112)).toBe(false);
    expect(looksIncomplete(1115, 1050)).toBe(false);
  });

  it('never flags growth or a first snapshot', () => {
    expect(looksIncomplete(0, 1115)).toBe(false);
    expect(looksIncomplete(100, 200)).toBe(false);
  });

  it('does not flag a genuinely tiny account losing one of three', () => {
    expect(looksIncomplete(3, 2)).toBe(false);
    expect(looksIncomplete(3, 0)).toBe(false);
  });
});

describe('mass-unfollow guard', () => {
  it('refuses to report everyone as an unfollower when a snapshot arrives empty', async () => {
    const db = openDb(':memory:');
    const many = Array.from({ length: 200 }, (_, i) => `user${i}`);
    await ingestAndDerive(db, followersZip(many));

    const r = await ingestAndDerive(db, makeZip({
      'your_instagram_activity/likes/liked_posts.json': { likes_media_likes: [] },
    }));

    expect(r.lost).toEqual([]);
    expect(r.suspicious).toBe(true);
    expect(unfollowers(db, 1_800_000_000)).toEqual([]);
  });

  it('still reports a normal handful of unfollowers', async () => {
    const db = openDb(':memory:');
    const many = Array.from({ length: 200 }, (_, i) => `user${i}`);
    await ingestAndDerive(db, followersZip(many));
    const r = await ingestAndDerive(db, followersZip(many.slice(0, 197)));

    expect(r.suspicious).toBe(false);
    expect(r.lost.sort()).toEqual(['user197', 'user198', 'user199']);
  });
});
