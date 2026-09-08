import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { unfollowers, lurkGap } from '../../src/report/reports.js';
import { makeZip } from '../helpers/makeZip.js';

const follower = (name: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: name, timestamp: ts }] });

describe('unfollowers report', () => {
  it('is empty after the first snapshot, which is only a baseline', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [follower('alice', 100), follower('bob', 200)] },
    }));
    expect(unfollowers(db, 1_800_000_000)).toEqual([]);
  });

  it('names who left, when they had followed, and whether I still follow them', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [follower('alice', 100), follower('bob', 200)] },
      'connections/followers_and_following/following.json':
        { relationships_following: [follower('bob', 50)] },
    }));
    const r = await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [follower('alice', 100)] },
      'connections/followers_and_following/following.json':
        { relationships_following: [follower('bob', 50)] },
    }));

    expect(r.lost).toEqual(['bob']);
    const rows = unfollowers(db, 1_800_000_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].username).toBe('bob');
    expect(rows[0].followedSince).toBe(200);
    expect(rows[0].iStillFollow).toBe(true);
  });

  it('does not report a rename as an unfollow', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [follower('oldname', 777), follower('stable', 100)] },
    }));
    const r = await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [follower('newname', 777), follower('stable', 100)] },
    }));
    expect(r.lost).toEqual([]);
    expect(unfollowers(db, 1_800_000_000)).toEqual([]);
  });
});

describe('lurkGap', () => {
  it('surfaces accounts I view heavily and never engage with', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeZip({
      'ads_information/posts_viewed.json': {
        impressions_history_posts_seen: Array.from({ length: 5 }, (_, i) =>
          ({ title: '', string_list_data: [{ href: '', value: 'lurkee', timestamp: 1000 + i }] })),
      },
      'your_instagram_activity/likes/liked_posts.json': {
        likes_media_likes: [
          { title: 'friend', string_list_data: [{ href: 'p', value: '❤️', timestamp: 500 }] },
        ],
      },
    }));
    const rows = lurkGap(db, 10);
    const lurkee = rows.find((r) => r.username === 'lurkee')!;
    expect(lurkee.views).toBe(5);
    expect(lurkee.engagements).toBe(0);
  });
});
