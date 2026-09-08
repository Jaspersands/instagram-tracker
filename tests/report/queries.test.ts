import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { people, overview, decay, habits, taste, person } from '../../src/report/queries.js';
import { makeZip } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const sld = (v: string, ts: number, href = 'h') =>
  ({ title: '', string_list_data: [{ href, value: v, timestamp: ts }] });

const rich = () => makeZip({
  'connections/followers_and_following/followers_1.json': {
    relationships_followers: [sld('alice', 100), sld('bob', 200)],
  },
  'connections/followers_and_following/following.json': {
    relationships_following: [sld('bob', 50), sld('carol', 60)],
  },
  'your_instagram_activity/likes/liked_posts.json': {
    likes_media_likes: [
      { title: 'bob', string_list_data: [{ href: 'p1', value: '❤️', timestamp: NOW - 86400 }] },
      { title: 'bob', string_list_data: [{ href: 'p2', value: '❤️', timestamp: NOW - 172800 }] },
    ],
  },
  'your_instagram_activity/comments/post_comments_1.json': {
    comments_media_comments: [{ string_map_data: {
      Comment: { value: 'hi bob' }, 'Media Owner': { value: 'bob' }, Time: { timestamp: NOW - 3600 } } }],
  },
  'your_instagram_activity/messages/inbox/alice_1784/message_1.json': {
    participants: [{ name: 'Alice' }, { name: 'Me' }], title: 'Alice',
    thread_path: 'inbox/alice_1784',
    messages: [
      { sender_name: 'Alice', timestamp_ms: (NOW - 7200) * 1000, content: 'yo' },
      { sender_name: 'Me', timestamp_ms: (NOW - 7100) * 1000, content: 'hey' },
    ],
  },
  'ads_information/posts_viewed.json': {
    impressions_history_posts_seen: Array.from({ length: 7 }, (_, i) => sld('carol', NOW - i * 60, '')),
  },
  'personal_information/your_topics/your_topics.json': {
    topics_your_topics: [{ string_map_data: { Name: { value: 'Cats' } } }],
  },
});

describe('people', () => {
  it('returns an empty array on an empty database rather than throwing', () => {
    expect(people(openDb(':memory:'), NOW)).toEqual([]);
  });

  it('breaks interactions out into the right columns', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    const rows = people(db, NOW);
    const bob = rows.find((r) => r.username === 'bob')!;
    const alice = rows.find((r) => r.username === 'alice')!;
    const carol = rows.find((r) => r.username === 'carol')!;

    expect(bob.likes).toBe(2);
    expect(bob.comments).toBe(1);
    expect(bob.followsMe).toBe(true);
    expect(bob.iFollow).toBe(true);
    expect(bob.followedSince).toBe(200);

    expect(alice.dmIn).toBe(1);
    expect(alice.dmOut).toBe(1);
    expect(alice.followsMe).toBe(true);
    expect(alice.iFollow).toBe(false);

    expect(carol.views).toBe(7);
    expect(carol.likes).toBe(0);
    expect(carol.followsMe).toBe(false);
    expect(carol.iFollow).toBe(true);
  });

  it('scores a commenter above a pure lurker', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    const rows = people(db, NOW);
    const bob = rows.find((r) => r.username === 'bob')!;
    const carol = rows.find((r) => r.username === 'carol')!;
    expect(bob.score).toBeGreaterThan(carol.score);
  });

  it('reflects only the latest snapshot for follow state', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [sld('alice', 100)],   // bob left
      },
    }));
    const bob = people(db, NOW).find((r) => r.username === 'bob')!;
    expect(bob.followsMe).toBe(false);
  });
});

describe('overview', () => {
  it('is empty-safe', () => {
    const o = overview(openDb(':memory:'));
    expect(o.snapshots).toEqual([]);
    expect(o.gained).toBe(0);
  });

  it('counts followers and following per snapshot', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    const o = overview(db);
    expect(o.snapshots).toHaveLength(1);
    expect(o.snapshots[0].followers).toBe(2);
    expect(o.snapshots[0].following).toBe(2);
  });
});

describe('habits', () => {
  it('is empty-safe and shaped 7x24', () => {
    const h = habits(openDb(':memory:'));
    expect(h.heatmap).toHaveLength(7);
    expect(h.heatmap[0]).toHaveLength(24);
    expect(h.heatmap.flat().every((n) => n === 0)).toBe(true);
  });

  it('places every interaction in exactly one heatmap cell', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    const total = (db.prepare('SELECT COUNT(*) c FROM interaction WHERE occurred_at IS NOT NULL')
      .get() as any).c;
    expect(habits(db).heatmap.flat().reduce((a, b) => a + b, 0)).toBe(total);
  });
});

describe('decay / taste / person', () => {
  it('all handle an empty database', () => {
    const db = openDb(':memory:');
    expect(decay(db, NOW, 90)).toEqual([]);
    expect(taste(db).topics).toEqual([]);
    expect(person(db, 'nobody', NOW).row).toBeNull();
  });

  it('person returns a timeline newest-first', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    const p = person(db, 'bob', NOW);
    expect(p.row!.username).toBe('bob');
    expect(p.timeline.length).toBeGreaterThan(0);
    const times = p.timeline.map((t) => t.occurredAt ?? 0);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('taste surfaces topics', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, rich());
    expect(taste(db).topics.map((t) => t.value)).toContain('Cats');
  });
});
