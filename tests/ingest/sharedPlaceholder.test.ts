import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, type Db } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { importThreadsCsv } from '../../src/ingest/threads.js';
import { backfillThreads, needsThreadBackfill } from '../../src/ingest/backfill.js';
import { people } from '../../src/report/queries.js';
import { resolveIdentities } from '../../src/derive/identity.js';
import { makeDir } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const TH = 'thread_id,thread_title,is_group,username,full_name,user_id';
const csv = (lines: string[]) => {
  const p = join(mkdtempSync(join(tmpdir(), 'shared-')), 'threads.csv');
  writeFileSync(p, [TH, ...lines].join('\n') + '\n');
  return p;
};
const thread = (folder: string, title: string, texts: string[]) => ({
  [`your_instagram_activity/messages/inbox/${folder}/message_1.json`]: {
    participants: [{ name: title }, { name: 'Jasper Sands' }],
    title, thread_path: `inbox/${folder}`,
    messages: texts.map((content, i) => ({
      sender_name: title, timestamp_ms: (NOW - 10_000 + i) * 1000, content,
    })),
  },
});
const dmsOf = (db: Db, username: string) =>
  (db.prepare(
    `SELECT i.text FROM interaction i JOIN account a ON a.id = i.account_id
      WHERE a.username = ? AND i.kind = 'dm'`).all(username) as { text: string }[])
    .map((r) => r.text).sort();

/**
 * Instagram names DM folders after display names. Two people who both display
 * as "Sophie" become one placeholder account, and their private messages are
 * blended. The export cannot tell them apart; only the thread id can.
 */
async function twoSophies(): Promise<Db> {
  const db = openDb(':memory:');
  await ingestAndDerive(db, makeDir({
    ...thread('sophie_100000000000111', 'Sophie', ['hi from A', 'more from A']),
    ...thread('sophie_100000000000222', 'Sophie', ['hello from B']),
  }));
  return db;
}

describe('two people sharing one DM display name', () => {
  it('start out blended on one placeholder', async () => {
    const db = await twoSophies();
    expect(dmsOf(db, 'sophie')).toEqual(['hello from B', 'hi from A', 'more from A']);
  });

  it('are split exactly by thread id once the pull names them', async () => {
    const db = await twoSophies();
    importThreadsCsv(db, csv([
      '100000000000111,Sophie,False,sophie.a,Sophie Anders,1001',
      '100000000000222,Sophie,False,sophie.b,Sophie Brooks,1002',
    ]));
    // This is the case that matters. Merging the placeholder into whichever
    // Sophie was listed first would hand her the other Sophie's conversation.
    expect(dmsOf(db, 'sophie.a')).toEqual(['hi from A', 'more from A']);
    expect(dmsOf(db, 'sophie.b')).toEqual(['hello from B']);
    expect(dmsOf(db, 'sophie')).toEqual([]);
  });

  it('collapse into one person when both threads are the same account', async () => {
    // The common case in practice: a second thread id for the same person.
    const db = await twoSophies();
    const s = importThreadsCsv(db, csv([
      '100000000000111,Sophie,False,sophie.a,Sophie Anders,1001',
      '100000000000222,Sophie,False,sophie.a,Sophie Anders,1001',
    ]));
    expect(s.messagesMoved).toBe(3);
    expect(dmsOf(db, 'sophie.a')).toEqual(['hello from B', 'hi from A', 'more from A']);
  });

  it('leave the emptied placeholder out of the people list', async () => {
    const db = await twoSophies();
    importThreadsCsv(db, csv([
      '100000000000111,Sophie,False,sophie.a,Sophie Anders,1001',
      '100000000000222,Sophie,False,sophie.b,Sophie Brooks,1002',
    ]));
    const names = people(db, NOW).map((p) => p.username);
    expect(names).toContain('sophie.a');
    expect(names).toContain('sophie.b');
    expect(names).not.toContain('sophie');
  });
});

describe('a placeholder that is one person', () => {
  it('moves everything and merges, so nothing is left behind', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeDir(thread('marcus_100000000000612', 'Marcus', ['a', 'b'])));
    const s = importThreadsCsv(db, csv(['100000000000612,Marcus,False,marcus_penrose,Marcus Penrose,999']));
    expect(s.messagesMoved).toBe(2);
    expect(dmsOf(db, 'marcus_penrose')).toEqual(['a', 'b']);
    const ph = db.prepare("SELECT merged_into FROM account WHERE username = 'marcus'").get() as any;
    expect(ph.merged_into).not.toBeNull();
  });
});

describe('the People list', () => {
  it('flags a DM-folder name as unmatched rather than claiming "no follow"', async () => {
    const db = await twoSophies();
    const row = people(db, NOW).find((p) => p.username === 'sophie');
    // "sophie" is very possibly a mutual whose real handle is elsewhere. Saying
    // she does not follow you is a claim the data cannot support.
    expect(row?.unmatched).toBe(true);
  });

  it('does not flag a real account with DMs', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeDir({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [{ title: '', string_list_data: [{ href: 'h', value: 'kate', timestamp: 100 }] }],
      },
      ...thread('kate_100000000000005', 'kate', ['yo']),
    }));
    const row = people(db, NOW).find((p) => p.username === 'kate');
    expect(row?.unmatched).toBe(false);
  });

  it('never lists Instagram\'s deleted-account stand-in as a person', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeDir({
      ...thread('instagramuser_100000000000001', 'Instagram User', ['gone']),
      ...thread('instagramuser_100000000000002', 'Instagram User', ['also gone']),
    }));
    expect(people(db, NOW).map((p) => p.username)).not.toContain('instagramuser');
    expect(resolveIdentities(db).map((r) => r.threadUsername)).not.toContain('instagramuser');
  });
});

describe('backfill for exports ingested before thread ids existed', () => {
  it('registers threads and stamps every message, without duplicating any', async () => {
    const db = openDb(':memory:');
    const dir = makeDir({
      ...thread('sophie_100000000000111', 'Sophie', ['hi from A']),
      ...thread('sophie_100000000000222', 'Sophie', ['hello from B']),
    });
    await ingestAndDerive(db, dir);
    // Simulate the state of a database that ingested this before the columns existed.
    db.exec('DELETE FROM dm_thread; UPDATE interaction SET thread_id = NULL');
    expect(needsThreadBackfill(db)).toBe(true);

    const before = (db.prepare('SELECT COUNT(*) AS c FROM interaction').get() as any).c;
    const r = await backfillThreads(db, dir);
    expect(r.threads).toBe(2);
    expect(r.messages).toBe(2);
    expect(needsThreadBackfill(db)).toBe(false);
    expect((db.prepare('SELECT COUNT(*) AS c FROM interaction').get() as any).c).toBe(before);

    // And the pull now works on it, splitting the two Sophies correctly.
    importThreadsCsv(db, csv([
      '100000000000111,Sophie,False,sophie.a,Sophie Anders,1001',
      '100000000000222,Sophie,False,sophie.b,Sophie Brooks,1002',
    ]));
    expect(dmsOf(db, 'sophie.a')).toEqual(['hi from A']);
    expect(dmsOf(db, 'sophie.b')).toEqual(['hello from B']);
  });

  it('runs on its own when an already-ingested export is seen again', async () => {
    const db = openDb(':memory:');
    const dir = makeDir(thread('marcus_100000000000612', 'Marcus', ['a']));
    await ingestAndDerive(db, dir);
    db.exec('DELETE FROM dm_thread; UPDATE interaction SET thread_id = NULL');
    // Every refresh re-offers every archive it can find; the skipped path is
    // where a database catches up with a table it predates.
    const r = await ingestAndDerive(db, dir);
    expect(r.skipped).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS c FROM dm_thread').get() as any).c).toBe(1);
    expect(needsThreadBackfill(db)).toBe(false);
  });
});
