import { describe, it, expect } from 'vitest';
import { parseArchive, collectingSink } from '../../src/parse/parseArchive.js';
import { makeDir } from '../helpers/makeZip.js';

/**
 * Meta migrated several files from string_list_data to label_values, dropping
 * the author entirely for likes/saves/views. These fixtures are the real shapes
 * observed in a September 2026 export. Both formats must keep working.
 */
const lv = (labels: Record<string, string>, timestamp: number) => ({
  timestamp, media: [],
  label_values: Object.entries(labels).map(([label, value]) => ({ label, value })),
});

describe('new label_values format', () => {
  it('attributes a story like via the username in its URL', async () => {
    const sink = collectingSink();
    await parseArchive(makeDir({
      'your_instagram_activity/story_interactions/story_likes.json': [
        lv({ URL: 'https://www.instagram.com/stories/wren_halloway/3980675275733447577' }, 1788754664),
        lv({ URL: 'https://www.instagram.com/stories/harrietvale/3980510003853158210' }, 1788754000),
      ],
    }), sink);

    expect(sink.interactions.map((i) => i.username)).toEqual(['wren_halloway', 'harrietvale']);
    expect(sink.interactions[0].kind).toBe('like_story');
    expect(sink.interactions[0].occurredAt).toBe(1788754664);
  });

  it('records a liked post as unattributed activity, because no author exists in the record', async () => {
    const sink = collectingSink();
    await parseArchive(makeDir({
      'your_instagram_activity/likes/liked_posts.json': [
        // Title is the literal string "title" in real data — junk, not an author.
        lv({ URL: 'https://www.instagram.com/p/DdDEzmRGrDA/', Caption: 'hi', Title: 'title' }, 1788918521),
      ],
    }), sink);

    expect(sink.interactions).toEqual([]);
    expect(sink.activities).toEqual([{
      kind: 'like_post', occurredAt: 1788918521,
      permalink: 'https://www.instagram.com/p/DdDEzmRGrDA/',
    }]);
    // Critically: no account row invented from a shortcode.
    expect(sink.followEdges).toEqual([]);
  });

  it('reads accounts I unfollowed, which the export hands over directly', async () => {
    const sink = collectingSink();
    await parseArchive(makeDir({
      'connections/followers_and_following/recently_unfollowed_profiles.json': [
        lv({ URL: 'http://known.com', Name: 'Known', Username: 'Known' }, 1788867376),
      ],
    }), sink);
    expect(sink.interactions).toEqual([{
      username: 'known', kind: 'unfollowed_them', direction: 'out',
      occurredAt: 1788867376, permalink: null, text: null,
    }]);
  });
});

describe('old string_list_data format still works', () => {
  const sld = (title: string, value: string, ts: number) =>
    ({ title, string_list_data: [{ href: 'https://ig/p/1/', value, timestamp: ts }] });

  it('keeps attributing likes when the author is present', async () => {
    const sink = collectingSink();
    await parseArchive(makeDir({
      'your_instagram_activity/likes/liked_posts.json': { likes_media_likes: [sld('bob', '❤', 500)] },
    }), sink);
    expect(sink.interactions[0]).toMatchObject({ username: 'bob', kind: 'like_post' });
    expect(sink.activities).toEqual([]);
  });

  it('keeps reading views from `value`, not `title`', async () => {
    // Applying title everywhere silently dropped every view.
    const sink = collectingSink();
    await parseArchive(makeDir({
      'ads_information/posts_viewed.json': {
        impressions_history_posts_seen: [sld('', 'carol', 400)],
      },
    }), sink);
    expect(sink.impressions).toEqual([{ username: 'carol', kind: 'post_viewed', occurredAt: 400 }]);
  });
});

describe('AI interest categories', () => {
  it('reads Meta’s AI-written interest statements', async () => {
    const sink = collectingSink();
    await parseArchive(makeDir({
      'your_instagram_activity/ai/interest_categories.json': [{
        timestamp: 1788090285, media: [],
        label_values: [
          { label: 'Interest', value: 'The user might be interested in cycling and mountain biking' },
          { label: 'Last updated time', timestamp_value: 1788090285 },
        ],
      }],
    }), sink);
    expect(sink.topics).toEqual([
      { kind: 'ai_interest', value: 'The user might be interested in cycling and mountain biking' },
    ]);
  });
});
