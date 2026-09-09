import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { ingestCapture } from '../../src/ingest/ingest.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { inbound } from '../../src/report/queries.js';
import { makeZip } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

const cap = (items: string[], extra: Record<string, unknown> = {}) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cap-')), 'ig-capture-post_likes-1.json');
  writeFileSync(p, JSON.stringify({
    v: 1, kind: 'post_likes', permalink: 'https://ig/p/A/', capturedAt: NOW,
    items: items.map((u) => ({ username: u })), ...extra,
  }));
  return p;
};

async function withFollowers(users: string[]) {
  const db = openDb(':memory:');
  await ingestAndDerive(db, makeZip({
    'connections/followers_and_following/followers_1.json':
      { relationships_followers: users.map((u, i) => f(u, 100 + i)) },
  }));
  return db;
}

describe('partial captures must not accuse people of being ghosts', () => {
  it('ignores an incomplete like list for ghost detection', async () => {
    const db = await withFollowers(['alice', 'bob', 'carol', 'dave']);
    // Scrolled only part way: 2 of a stated 210 likers.
    await ingestCapture(db, cap(['alice', 'bob'], { expected: 210, complete: false }));

    const r = inbound(db, NOW);
    // carol and dave may well have liked the post — we simply did not see far
    // enough to know. Naming them ghosts would be a fabrication.
    expect(r.ghosts).toEqual([]);
  });

  it('uses a complete capture normally', async () => {
    const db = await withFollowers(['alice', 'bob', 'carol']);
    await ingestCapture(db, cap(['alice', 'bob'], { expected: 2, complete: true }));

    const names = inbound(db, NOW).ghosts.map((g) => g.username);
    expect(names).toEqual(['carol']);
  });

  it('treats a capture with no completeness information as complete', async () => {
    // Older capture files predate the field; they were scrolled by hand.
    const db = await withFollowers(['alice', 'bob']);
    await ingestCapture(db, cap(['alice']));
    expect(inbound(db, NOW).ghosts.map((g) => g.username)).toEqual(['bob']);
  });

  it('still records the engagement from a partial capture', async () => {
    const db = await withFollowers(['alice', 'bob', 'carol']);
    await ingestCapture(db, cap(['alice'], { expected: 210, complete: false }));
    // The likes we did see are real; only the absence is untrustworthy.
    const sf = inbound(db, NOW).superfans;
    expect(sf.map((s) => s.username)).toContain('alice');
  });
});
