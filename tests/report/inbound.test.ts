import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { ingestCapture } from '../../src/ingest/ingest.js';
import { inbound } from '../../src/report/queries.js';
import { makeZip } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const sld = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

const followers = () => makeZip({
  'connections/followers_and_following/followers_1.json': {
    relationships_followers: [sld('alice', 100), sld('bob', 200), sld('ghosty', 300)],
  },
});

const cap = (items: unknown[], permalink = 'https://www.instagram.com/p/AAA/') => {
  const p = join(mkdtempSync(join(tmpdir(), 'cap-')), 'ig-capture-post_likes-1.json');
  writeFileSync(p, JSON.stringify({ v: 1, kind: 'post_likes', permalink, capturedAt: NOW, items }));
  return p;
};

describe('inbound', () => {
  it('accuses nobody of being a ghost before anything is captured', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, followers());
    const r = inbound(db, NOW);
    expect(r.captures).toEqual([]);
    // Critical: with no capture data, "never engaged" is unknown, not true.
    expect(r.ghosts).toEqual([]);
  });

  it('names a follower absent from every capture, and spares the ones present', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, followers());
    await ingestCapture(db, cap([{ username: 'alice' }, { username: 'bob' }]));

    const r = inbound(db, NOW);
    const names = r.ghosts.map((g) => g.username);
    expect(names).toContain('ghosty');
    expect(names).not.toContain('alice');
    expect(names).not.toContain('bob');
  });

  it('ranks superfans by inbound engagement', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, followers());
    await ingestCapture(db, cap([{ username: 'alice' }, { username: 'bob' }], 'https://ig/p/A/'));
    await ingestCapture(db, cap([{ username: 'alice' }], 'https://ig/p/B/'));
    await ingestCapture(db, cap([{ username: 'alice' }], 'https://ig/p/C/'));

    const sf = inbound(db, NOW).superfans;
    expect(sf[0].username).toBe('alice');
    expect(sf[0].likesReceived).toBe(3);
    expect(sf.find((s) => s.username === 'bob')!.likesReceived).toBe(1);
  });

  it('counts captures with their row totals', async () => {
    const db = openDb(':memory:');
    await ingestCapture(db, cap([{ username: 'alice' }, { username: 'bob' }]));
    const r = inbound(db, NOW);
    expect(r.captures).toHaveLength(1);
    expect(r.captures[0].kind).toBe('post_likes');
    expect(r.captures[0].people).toBe(2);
  });
});
