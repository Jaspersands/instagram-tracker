import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { importThreadsCsv, isThreadsCsv } from '../../src/ingest/threads.js';
import { importCommentsCsv, isCommentsCsv } from '../../src/ingest/comments.js';
import { people, inbound } from '../../src/report/queries.js';
import { makeDir } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const write = (name: string, lines: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'api-')), name);
  writeFileSync(p, lines.join('\n') + '\n');
  return p;
};

const TH = 'thread_id,thread_title,is_group,username,full_name,user_id';
const CO = 'post_shortcode,post_url,post_date,comment_id,created_at,username,full_name,user_id,text';

/** An export whose DM folder is named after a display name, as Instagram does. */
async function withThread() {
  const db = openDb(':memory:');
  await ingestAndDerive(db, makeDir({
    'your_instagram_activity/messages/inbox/marcus_612189326440592/message_1.json': {
      participants: [{ name: 'Marcus' }, { name: 'Jasper Sands' }],
      title: 'Marcus', thread_path: 'inbox/marcus_612189326440592',
      messages: [
        { sender_name: 'Marcus', timestamp_ms: (NOW - 3600) * 1000, content: 'hey' },
        { sender_name: 'Jasper Sands', timestamp_ms: (NOW - 3000) * 1000, content: 'hi' },
      ],
    },
  }));
  return db;
}

describe('file detection', () => {
  it('tells the three CSV shapes apart', () => {
    expect(isThreadsCsv(TH)).toBe(true);
    expect(isCommentsCsv(CO)).toBe(true);
    expect(isThreadsCsv(CO)).toBe(false);
    expect(isCommentsCsv(TH)).toBe(false);
  });
});

describe('importThreadsCsv', () => {
  it('records the thread id from the export folder', async () => {
    const db = await withThread();
    const row = db.prepare('SELECT thread_id, placeholder FROM dm_thread').get() as any;
    expect(row.thread_id).toBe('612189326440592');
    expect(row.placeholder).toBe('marcus');
  });

  it('links a thread to the real account by id, not by name', async () => {
    const db = await withThread();
    const s = importThreadsCsv(db, write('threads.csv', [TH,
      '612189326440592,Marcus,False,marcus_penrose,Marcus Penrose,999']));

    expect(s.linked).toBe(1);
    expect(s.unmatched).toBe(0);

    const names = people(db, NOW).map((p) => p.username);
    expect(names).toContain('marcus_penrose');
    expect(names).not.toContain('marcus');

    // The conversation moved with the identity.
    const real = people(db, NOW).find((p) => p.username === 'marcus_penrose')!;
    expect(real.dmIn + real.dmOut).toBe(2);
  });

  it('refuses to merge a group thread into one participant', async () => {
    const db = await withThread();
    const s = importThreadsCsv(db, write('threads.csv', [TH,
      '612189326440592,Trip,True,alice,Alice,1',
      '612189326440592,Trip,True,bob,Bob,2']));
    expect(s.groupsSkipped).toBe(1);
    expect(s.linked).toBe(0);
    // The placeholder survives rather than being attributed to Alice or Bob.
    expect(people(db, NOW).map((p) => p.username)).toContain('marcus');
  });

  it('counts a thread the export never contained as unmatched', async () => {
    const db = await withThread();
    const s = importThreadsCsv(db, write('threads.csv', [TH,
      '111111111111,Someone,False,newperson,New Person,5']));
    expect(s.unmatched).toBe(1);
    expect(s.linked).toBe(0);
  });

  it('stores display names and Instagram ids', async () => {
    const db = await withThread();
    importThreadsCsv(db, write('threads.csv', [TH,
      '612189326440592,Marcus,False,marcus_penrose,Marcus Penrose,999']));
    const a = db.prepare('SELECT display_name, instagram_id FROM account WHERE username=?')
      .get('marcus_penrose') as any;
    expect(a).toEqual({ display_name: 'Marcus Penrose', instagram_id: '999' });
  });
});

describe('importCommentsCsv', () => {
  it('imports comments received, which no export contains', () => {
    const db = openDb(':memory:');
    const s = importCommentsCsv(db, write('comments.csv', [CO,
      'AAA,https://ig/p/AAA/,2026-09-06 21:35:26,c1,1788918521,alice,Alice,111,nice shot',
      'AAA,https://ig/p/AAA/,2026-09-06 21:35:26,c2,1788918600,bob,Bob,222,🔥']));

    expect(s.comments).toBe(2);
    expect(s.people).toBe(2);
    expect(s.withTimestamps).toBe(2);

    const row = db.prepare(
      "SELECT text, occurred_at FROM interaction WHERE kind='comment_received' ORDER BY occurred_at").get() as any;
    expect(row.text).toBe('nice shot');
    // Unlike likes, comments carry their own timestamp.
    expect(row.occurred_at).toBe(1788918521);
  });

  it('keeps two identical comments from the same person apart', () => {
    const db = openDb(':memory:');
    const s = importCommentsCsv(db, write('comments.csv', [CO,
      'AAA,u,2026-09-06 21:35:26,c1,1788918521,alice,Alice,111,🔥',
      'AAA,u,2026-09-06 21:35:26,c2,1788918521,alice,Alice,111,🔥']));
    expect(s.comments).toBe(2);   // distinct comment_id
  });

  it('is idempotent', () => {
    const db = openDb(':memory:');
    const p = write('comments.csv', [CO,
      'AAA,u,2026-09-06 21:35:26,c1,1788918521,alice,Alice,111,hi']);
    importCommentsCsv(db, p);
    expect(importCommentsCsv(db, p).comments).toBe(0);
  });

  it('feeds superfans with real comment counts', () => {
    const db = openDb(':memory:');
    importCommentsCsv(db, write('comments.csv', [CO,
      'AAA,u,2026-09-06 21:35:26,c1,1788918521,alice,Alice,111,one',
      'AAA,u,2026-09-06 21:35:26,c2,1788918522,alice,Alice,111,two']));
    const sf = inbound(db, NOW).superfans.find((s) => s.username === 'alice')!;
    expect(sf.commentsReceived).toBe(2);
  });

  it('falls back to the post date when a comment has no timestamp', () => {
    const db = openDb(':memory:');
    importCommentsCsv(db, write('comments.csv', [CO,
      'AAA,u,2026-09-06 21:35:26,c1,,alice,Alice,111,hi']));
    const row = db.prepare("SELECT occurred_at FROM interaction").get() as any;
    expect(row.occurred_at).toBe(Math.floor(Date.parse('2026-09-06T21:35:26Z') / 1000));
  });
});
