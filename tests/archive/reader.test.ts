import { describe, it, expect } from 'vitest';
import { eachJsonEntry, detectWrapperKey, STREAM_THRESHOLD_BYTES } from '../../src/archive/reader.js';
import { makeZip } from '../helpers/makeZip.js';

describe('detectWrapperKey', () => {
  it('finds the wrapper key of an object-wrapped array', () => {
    expect(detectWrapperKey('{"relationships_followers": [{"title"')).toBe('relationships_followers');
  });
  it('returns null for a bare top-level array', () => {
    expect(detectWrapperKey('[{"title": "x"}]')).toBeNull();
  });
  it('tolerates leading whitespace and newlines', () => {
    expect(detectWrapperKey('\n\n  {\n  "likes_media_likes" : [')).toBe('likes_media_likes');
  });
});

describe('eachJsonEntry', () => {
  it('yields every JSON entry with its items, and skips non-JSON', async () => {
    const zip = makeZip({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [
          { title: '', string_list_data: [{ href: 'h', value: 'alice', timestamp: 1 }] },
          { title: '', string_list_data: [{ href: 'h', value: 'bob', timestamp: 2 }] },
        ],
      },
      'media/photo.jpg': 'not json at all',
    });

    const seen: Record<string, number> = {};
    await eachJsonEntry(zip, async (src) => {
      let n = 0;
      for await (const _ of src.items()) n++;
      seen[src.path] = n;
    });

    const key = Object.keys(seen).find((k) => k.endsWith('followers_1.json'))!;
    expect(seen[key]).toBe(2);
    expect(Object.keys(seen).some((k) => k.endsWith('.jpg'))).toBe(false);
  });

  it('raw() returns the whole document with sibling arrays intact', async () => {
    const zip = makeZip({
      'messages/inbox/alice_1/message_1.json': {
        participants: [{ name: 'Alice' }, { name: 'Me' }],
        messages: [{ sender_name: 'Alice', timestamp_ms: 1700000000000, content: 'hey' }],
      },
    });
    let checked = false;
    await eachJsonEntry(zip, async (src) => {
      const doc = (await src.raw()) as any;
      expect(doc.participants).toHaveLength(2);
      expect(doc.messages).toHaveLength(1);
      checked = true;
    });
    expect(checked).toBe(true);
  });

  it('yields nothing for an archive with no JSON', async () => {
    const zip = makeZip({ 'readme.txt': 'hello' });
    const paths: string[] = [];
    await eachJsonEntry(zip, async (src) => { paths.push(src.path); });
    expect(paths).toEqual([]);
  });

  it('streams a file above the threshold without buffering it', async () => {
    // Every other fixture is small and takes the buffered path. This is the only
    // test covering the branch that runs on a real multi-hundred-MB export.
    const items = Array.from({ length: 100_000 }, (_, i) => ({
      title: '',
      string_list_data: [{ href: `https://www.instagram.com/u${i}`, value: `user${i}`, timestamp: i }],
    }));
    const doc = JSON.stringify({ impressions_history_posts_seen: items });
    expect(doc.length).toBeGreaterThan(STREAM_THRESHOLD_BYTES);

    const zip = makeZip({ 'ads_information/posts_viewed.json': doc });

    let n = 0;
    let first: any = null;
    await eachJsonEntry(zip, async (src) => {
      expect(src.size).toBeGreaterThan(STREAM_THRESHOLD_BYTES);
      for await (const item of src.items()) {
        if (n === 0) first = item;
        n++;
      }
    });

    expect(n).toBe(100_000);
    expect(first.string_list_data[0].value).toBe('user0');
  }, 60_000);

  it('raw() refuses to buffer a file above the threshold', async () => {
    const pad = 'x'.repeat(200);
    const doc = JSON.stringify(
      Array.from({ length: 50_000 }, (_, i) => ({ title: `u${i}`, pad, string_list_data: [] })),
    );
    expect(doc.length).toBeGreaterThan(STREAM_THRESHOLD_BYTES);
    const zip = makeZip({ 'big.json': doc });
    await eachJsonEntry(zip, async (src) => {
      await expect(src.raw()).rejects.toThrow(/refusing to buffer/);
    });
  }, 60_000);

  it('does not throw on a malformed JSON entry', async () => {
    const zip = makeZip({ 'broken.json': '{ this is not json' });
    const counts: number[] = [];
    await eachJsonEntry(zip, async (src) => {
      let n = 0;
      try { for await (const _ of src.items()) n++; } catch { n = -1; }
      counts.push(n);
    });
    expect(counts).toEqual([-1]);
  });
});
