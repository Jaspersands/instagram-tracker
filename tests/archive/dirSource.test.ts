import { describe, it, expect } from 'vitest';
import { eachJsonEntry, STREAM_THRESHOLD_BYTES } from '../../src/archive/reader.js';
import { makeDir, makeZip } from '../helpers/makeZip.js';

const EXPORT = {
  'connections/followers_and_following/followers_1.json': {
    relationships_followers: [
      { title: '', string_list_data: [{ href: 'h', value: 'alice', timestamp: 1 }] },
      { title: '', string_list_data: [{ href: 'h', value: 'bob', timestamp: 2 }] },
    ],
  },
  'your_instagram_activity/messages/inbox/alice_1/message_1.json': {
    participants: [{ name: 'Alice' }, { name: 'Me' }],
    title: 'Alice', thread_path: 'inbox/alice_1',
    messages: [{ sender_name: 'Alice', timestamp_ms: 1700000000000, content: 'hey' }],
  },
  'media/posts/photo.jpg': 'not json',
};

describe('eachJsonEntry over an unzipped directory', () => {
  it('reads a directory the same way it reads a zip', async () => {
    const seen: Record<string, number> = {};
    await eachJsonEntry(makeDir(EXPORT), async (src) => {
      let n = 0;
      for await (const _ of src.items()) n++;
      seen[src.path] = n;
    });

    const followers = Object.keys(seen).find((k) => k.endsWith('followers_1.json'))!;
    expect(seen[followers]).toBe(2);
    expect(Object.keys(seen).some((k) => k.endsWith('.jpg'))).toBe(false);
  });

  it('reports paths relative to the export root so the registry still matches', async () => {
    const paths: string[] = [];
    await eachJsonEntry(makeDir(EXPORT), async (src) => { paths.push(src.path); });
    expect(paths).toContain('connections/followers_and_following/followers_1.json');
    expect(paths).toContain('your_instagram_activity/messages/inbox/alice_1/message_1.json');
    expect(paths.every((p) => !p.startsWith('/'))).toBe(true);
  });

  it('supports raw() for message threads', async () => {
    let doc: any = null;
    await eachJsonEntry(makeDir(EXPORT), async (src) => {
      if (src.path.endsWith('message_1.json')) doc = await src.raw();
    });
    expect(doc.participants).toHaveLength(2);
    expect(doc.messages).toHaveLength(1);
  });

  it('streams a large file rather than buffering it', async () => {
    const items = Array.from({ length: 120_000 }, (_, i) => ({
      title: '', string_list_data: [{ href: '', value: `user${i}`, timestamp: i }],
    }));
    const doc = JSON.stringify({ impressions_history_posts_seen: items });
    expect(doc.length).toBeGreaterThan(STREAM_THRESHOLD_BYTES);

    let n = 0;
    await eachJsonEntry(makeDir({ 'ads_information/posts_viewed.json': doc }), async (src) => {
      expect(src.size).toBeGreaterThan(STREAM_THRESHOLD_BYTES);
      for await (const _ of src.items()) n++;
    });
    expect(n).toBe(120_000);
  }, 60_000);

  it('does not throw on a malformed file', async () => {
    const counts: number[] = [];
    await eachJsonEntry(makeDir({ 'broken.json': '{ not json' }), async (src) => {
      let n = 0;
      try { for await (const _ of src.items()) n++; } catch { n = -1; }
      counts.push(n);
    });
    expect(counts).toEqual([-1]);
  });

  it('still reads zips exactly as before', async () => {
    const paths: string[] = [];
    await eachJsonEntry(makeZip(EXPORT), async (src) => { paths.push(src.path); });
    expect(paths.some((p) => p.endsWith('followers_1.json'))).toBe(true);
  });
});
