import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { ingestCapture } from '../../src/ingest/ingest.js';
import { people, inbound } from '../../src/report/queries.js';
import { makeZip } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

const cap = (items: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'cap-')), 'ig-capture-post_likes-1.json');
  writeFileSync(p, JSON.stringify({
    v: 1, kind: 'post_likes', permalink: 'https://ig/p/A/', capturedAt: NOW,
    items: items.map((u) => ({ username: u })),
  }));
  return p;
};

/** A rename must not orphan the person's history onto the dead username. */
async function renamed() {
  const db = openDb(':memory:');
  await ingestAndDerive(db, makeZip({
    'connections/followers_and_following/followers_1.json':
      { relationships_followers: [f('oldname', 777), f('stable', 100)] },
    'your_instagram_activity/likes/liked_posts.json': {
      likes_media_likes: [
        { title: 'oldname', string_list_data: [{ href: 'p1', value: '❤', timestamp: NOW - 3600 }] },
      ],
    },
  }));
  await ingestCapture(db, cap(['oldname']));
  await ingestAndDerive(db, makeZip({
    'connections/followers_and_following/followers_1.json':
      { relationships_followers: [f('newname', 777), f('stable', 100)] },
  }));
  return db;
}

describe('merged (renamed) accounts', () => {
  it('carries outbound history onto the new username', async () => {
    const rows = people(await renamed(), NOW);
    const newname = rows.find((r) => r.username === 'newname')!;
    expect(newname).toBeDefined();
    expect(newname.likes).toBe(1);
    // The dead username must not linger as a second person.
    expect(rows.find((r) => r.username === 'oldname')).toBeUndefined();
  });

  it('does not accuse a renamed follower of being a ghost', async () => {
    const r = inbound(await renamed(), NOW);
    const names = r.ghosts.map((g) => g.username);
    expect(names).not.toContain('newname');
    expect(names).toContain('stable');   // stable really did not engage
  });
});

describe('superfans', () => {
  it('counts only content engagement, so the total reconciles with its columns', async () => {
    const db = openDb(':memory:');
    // A DM-only contact is not a superfan of your posts.
    await ingestAndDerive(db, makeZip({
      'your_instagram_activity/messages/inbox/dmpal_1/message_1.json': {
        participants: [{ name: 'Dmpal' }, { name: 'Me' }], title: 'Dmpal',
        thread_path: 'inbox/dmpal_1',
        messages: Array.from({ length: 40 }, (_, i) =>
          ({ sender_name: 'Dmpal', timestamp_ms: (NOW - i * 60) * 1000, content: 'hi' })),
      },
    }));
    await ingestCapture(db, cap(['liker']));

    const sf = inbound(db, NOW).superfans;
    for (const s of sf) {
      expect(s.likesReceived + s.commentsReceived + s.storyViews,
        `${s.username} total must equal its parts`).toBe(s.total);
    }
    expect(sf.map((s) => s.username)).not.toContain('dmpal');
    expect(sf[0].username).toBe('liker');
  });
});
