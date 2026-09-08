import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { isCaptureFile, parseCapture } from '../../src/parse/capture.js';
import { ingestCapture } from '../../src/ingest/ingest.js';

const write = (name: string, obj: unknown) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cap-')), name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
};
const capture = (kind: string, items: unknown[], permalink = 'https://www.instagram.com/p/XYZ/') =>
  ({ v: 1, kind, permalink, capturedAt: 1757000000, items });

const count = (db: any, sql: string) => db.prepare(sql).get().c as number;

describe('isCaptureFile', () => {
  it('matches capture files and not archives', () => {
    expect(isCaptureFile('/x/ig-capture-post_likes-1757000000.json')).toBe(true);
    expect(isCaptureFile('/x/instagram-jasper-2026-09-08-a.zip')).toBe(false);
    expect(isCaptureFile('/x/random.json')).toBe(false);
  });
});

describe('parseCapture', () => {
  it('rejects junk and unknown versions rather than half-importing', () => {
    expect(parseCapture(null)).toBeNull();
    expect(parseCapture({})).toBeNull();
    expect(parseCapture({ ...capture('post_likes', []), v: 99 })).toBeNull();
    expect(parseCapture({ ...capture('nonsense', []) })).toBeNull();
  });

  it('lowercases usernames and keeps comment text', () => {
    const p = parseCapture(capture('post_comments', [{ username: 'Bob', text: 'nice' }]))!;
    expect(p.items).toEqual([{ username: 'bob', text: 'nice' }]);
  });

  it('drops items with no usable username', () => {
    const p = parseCapture(capture('post_likes', [{ username: '' }, { nope: 1 }, { username: 'ok' }]))!;
    expect(p.items).toEqual([{ username: 'ok', text: null }]);
  });
});

describe('ingestCapture', () => {
  it('maps each kind to the right inbound interaction', async () => {
    const db = openDb(':memory:');
    await ingestCapture(db, write('ig-capture-post_likes-1.json',
      capture('post_likes', [{ username: 'alice' }, { username: 'bob' }])));
    await ingestCapture(db, write('ig-capture-post_comments-2.json',
      capture('post_comments', [{ username: 'carol', text: 'love this' }])));
    await ingestCapture(db, write('ig-capture-story_viewers-3.json',
      capture('story_viewers', [{ username: 'dave' }], 'https://www.instagram.com/stories/me/1/')));

    expect(count(db, "SELECT COUNT(*) c FROM interaction WHERE kind='like_received'")).toBe(2);
    expect(count(db, "SELECT COUNT(*) c FROM interaction WHERE kind='comment_received'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM interaction WHERE kind='story_view'")).toBe(1);
    expect(count(db, "SELECT COUNT(*) c FROM interaction WHERE direction='in'")).toBe(4);
    expect(count(db, 'SELECT COUNT(*) c FROM inbound_capture')).toBe(3);

    const t = db.prepare("SELECT text FROM interaction WHERE kind='comment_received'").get() as any;
    expect(t.text).toBe('love this');
  });

  it('is idempotent when the same post is captured twice', async () => {
    const db = openDb(':memory:');
    const c = capture('post_likes', [{ username: 'alice' }, { username: 'bob' }]);
    await ingestCapture(db, write('ig-capture-post_likes-1.json', c));
    await ingestCapture(db, write('ig-capture-post_likes-2.json', c));
    expect(count(db, "SELECT COUNT(*) c FROM interaction WHERE kind='like_received'")).toBe(2);
  });

  it('treats the same person on two different posts as two likes', async () => {
    const db = openDb(':memory:');
    await ingestCapture(db, write('ig-capture-a.json',
      capture('post_likes', [{ username: 'alice' }], 'https://www.instagram.com/p/AAA/')));
    await ingestCapture(db, write('ig-capture-b.json',
      capture('post_likes', [{ username: 'alice' }], 'https://www.instagram.com/p/BBB/')));
    expect(count(db, "SELECT COUNT(*) c FROM interaction WHERE kind='like_received'")).toBe(2);
  });

  it('reports skipped for an unparseable file instead of throwing', async () => {
    const db = openDb(':memory:');
    const r = await ingestCapture(db, write('ig-capture-bad.json', { garbage: true }));
    expect(r.skipped).toBe(true);
    expect(r.rows).toBe(0);
  });
});
