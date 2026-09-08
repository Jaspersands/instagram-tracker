import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestArchive } from '../../src/ingest/ingest.js';
import { makeZip } from '../helpers/makeZip.js';

const thread = (msgs: { sender_name: string; timestamp_ms: number; content: string }[]) => ({
  'your_instagram_activity/messages/inbox/alice_1784299/message_1.json': {
    participants: [{ name: 'Alice' }, { name: 'Me' }],
    title: 'Alice',
    thread_path: 'inbox/alice_1784299',
    messages: msgs,
  },
});

describe('DM ingest', () => {
  it('keeps every message in a same-second burst', async () => {
    // Real chat is bursty. Truncating ms to seconds means a dedupe key of
    // kind|user|second collapses a whole burst into one row.
    const db = openDb(':memory:');
    await ingestArchive(db, makeZip(thread([
      { sender_name: 'Alice', timestamp_ms: 1700000000100, content: 'wait' },
      { sender_name: 'Alice', timestamp_ms: 1700000000400, content: 'no' },
      { sender_name: 'Alice', timestamp_ms: 1700000000800, content: 'actually yes' },
    ])));
    expect((db.prepare("SELECT COUNT(*) c FROM interaction WHERE kind='dm'").get() as any).c).toBe(3);
  });

  it('stores message text with mojibake repaired', async () => {
    const db = openDb(':memory:');
    await ingestArchive(db, makeZip(thread([
      { sender_name: 'Alice', timestamp_ms: 1700000000000, content: 'cafÃ© later?' },
    ])));
    const row = db.prepare("SELECT text FROM interaction WHERE kind='dm'").get() as any;
    expect(row.text).toBe('café later?');
  });

  it('still deduplicates a genuinely repeated message across overlapping exports', async () => {
    const db = openDb(':memory:');
    const msgs = [{ sender_name: 'Alice', timestamp_ms: 1700000000000, content: 'hey' }];
    await ingestArchive(db, makeZip(thread(msgs)));
    await ingestArchive(db, makeZip({ ...thread(msgs), 'extra.json': { x: [] } }));
    expect((db.prepare("SELECT COUNT(*) c FROM interaction WHERE kind='dm'").get() as any).c).toBe(1);
  });

  it('stores comment text', async () => {
    const db = openDb(':memory:');
    await ingestArchive(db, makeZip({
      'your_instagram_activity/comments/post_comments_1.json': {
        comments_media_comments: [{ string_map_data: {
          Comment: { value: 'great shot' },
          'Media Owner': { value: 'Bob' },
          Time: { timestamp: 1700000500 },
        } }],
      },
    }));
    const row = db.prepare("SELECT text FROM interaction WHERE kind='comment'").get() as any;
    expect(row.text).toBe('great shot');
  });
});
