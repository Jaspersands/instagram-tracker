import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { openDb } from '../../src/db/open.js';
import { buildPublicPayload } from '../../src/publish/payload.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { makeDir } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const sld = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

/**
 * The published payload is permanently world-readable, and it is written by an
 * unattended monthly job. These tests are the reason that is safe: they assert
 * that no name can reach it, so a future query gaining a column cannot quietly
 * start leaking people.
 */
async function populated() {
  const db = openDb(':memory:');
  await ingestAndDerive(db, makeDir({
    'connections/followers_and_following/followers_1.json': {
      relationships_followers: [sld('zartheticpanther', 100), sld('quibblesnort_vex', 200)],
    },
    'connections/followers_and_following/following.json': {
      relationships_following: [sld('zartheticpanther', 100), sld('mxyzptlk_grondle', 300)],
    },
    'your_instagram_activity/likes/liked_posts.json': {
      likes_media_likes: [
        { title: 'quibblesnort_vex', string_list_data: [{ href: 'p1', value: '❤', timestamp: NOW - 500 }] },
      ],
    },
    'your_instagram_activity/messages/inbox/grimbledorf_1000000000123/message_1.json': {
      participants: [{ name: 'Grimbledorf' }, { name: 'Jasper Sands' }],
      title: 'Grimbledorf', thread_path: 'inbox/grimbledorf_1000000000123',
      messages: [{ sender_name: 'Grimbledorf', timestamp_ms: (NOW - 400) * 1000,
                   content: 'a secret sentence nobody should publish' }],
    },
    'logged_information/recent_searches/profile_searches.json': {
      searches_user: [{ string_map_data: { Search: { value: 'zartheticpanther' }, Time: { timestamp: NOW - 9 } } }],
    },
  }));
  return db;
}

describe('public payload', () => {
  it('contains no username from the database', async () => {
    const db = await populated();
    const names = (db.prepare('SELECT username FROM account').all() as { username: string }[])
      .map((r) => r.username);
    expect(names.length).toBeGreaterThan(2);

    const json = JSON.stringify(buildPublicPayload(db, NOW));
    for (const n of names) {
      expect(json, `leaked username: ${n}`).not.toContain(n);
    }
  });

  it('contains no display name', async () => {
    const db = await populated();
    const json = JSON.stringify(buildPublicPayload(db, NOW));
    expect(json).not.toContain('Grimbledorf');
    expect(json.toLowerCase()).not.toContain('grimbledorf');
  });

  it('contains no DM text', async () => {
    const db = await populated();
    const json = JSON.stringify(buildPublicPayload(db, NOW));
    // Message bodies are written by other people and are the single worst thing
    // that could end up on a public URL.
    expect(json).not.toContain('a secret sentence');
  });

  it('contains no search terms, because those hold usernames', async () => {
    const db = await populated();
    const json = JSON.stringify(buildPublicPayload(db, NOW));
    expect(json).not.toContain('zartheticpanther');
  });

  it('still reports the real numbers', async () => {
    const db = await populated();
    const p = buildPublicPayload(db, NOW);
    expect(p.totals.followers).toBe(2);
    expect(p.totals.following).toBe(2);
    expect(p.totals.mutuals).toBe(1);
    expect(p.byKind.find((k) => k.kind === 'dm')?.n).toBe(1);
    expect(p.exports).toHaveLength(1);
    expect(p.heatmap).toHaveLength(7);
    expect(p.relationships.mutual).toBe(1);
  });

  it('emits only counts, dates and a fixed vocabulary', async () => {
    const db = await populated();
    const p = buildPublicPayload(db, NOW);
    // Every string in the payload must come from a known set, not from data.
    const KINDS = new Set(p.byKind.map((k) => k.kind));
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(p);
    for (const s of strings) {
      const ok = KINDS.has(s)
        || /^\d{4}-\d{2}$/.test(s)                     // month label
        || /^(\d+–\d+|\d+)$/.test(s)                   // closeness bucket
        || p.interests.includes(s) || p.hashtags.includes(s);
      expect(ok, `unexpected free-text string in payload: ${s}`).toBe(true);
    }
  });
});

describe('the real database', () => {
  it.skipIf(!existsSync('data/instagram.db'))(
    'publishes nothing that names any of the real accounts', () => {
      // The actual check that matters before anything is pushed.
      const db = openDb('data/instagram.db');
      const names = (db.prepare(
        'SELECT username FROM account WHERE LENGTH(username) >= 6',
      ).all() as { username: string }[]).map((r) => r.username);
      const json = JSON.stringify(buildPublicPayload(db, Math.floor(Date.now() / 1000)));
      const leaked = names.filter((n) => json.includes(n));
      expect(leaked, `leaked: ${leaked.slice(0, 5).join(', ')}`).toEqual([]);
    });
});
