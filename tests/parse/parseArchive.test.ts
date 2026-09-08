import { describe, it, expect } from 'vitest';
import { parseArchive, collectingSink } from '../../src/parse/parseArchive.js';
import { makeZip } from '../helpers/makeZip.js';

const zipOf = () => makeZip({
  'connections/followers_and_following/followers_1.json': {
    relationships_followers: [
      { title: '', string_list_data: [{ href: 'h', value: 'Alice', timestamp: 100 }] },
      { title: '', string_list_data: [{ href: 'h', value: 'bob', timestamp: 200 }] },
    ],
  },
  'connections/followers_and_following/following.json': {
    relationships_following: [
      { title: '', string_list_data: [{ href: 'h', value: 'bob', timestamp: 150 }] },
    ],
  },
  'your_instagram_activity/likes/liked_posts.json': {
    likes_media_likes: [
      { title: 'bob', string_list_data: [{ href: 'https://ig/p/1/', value: '❤️', timestamp: 300 }] },
    ],
  },
  'ads_information/posts_viewed.json': {
    impressions_history_posts_seen: [
      { title: '', string_list_data: [{ href: '', value: 'carol', timestamp: 400 }] },
    ],
  },
  'media/photo.jpg': 'binary-ish',
});

describe('parseArchive', () => {
  it('routes each file to the right row type', async () => {
    const sink = collectingSink();
    await parseArchive(zipOf(), sink);

    expect(sink.followEdges).toContainEqual({ username: 'alice', direction: 'follows_me', since: 100 });
    expect(sink.followEdges).toContainEqual({ username: 'bob', direction: 'i_follow', since: 150 });
    expect(sink.interactions).toContainEqual({
      username: 'bob', kind: 'like_post', direction: 'out',
      occurredAt: 300, permalink: 'https://ig/p/1/', text: null,
    });
    expect(sink.impressions).toContainEqual({ username: 'carol', kind: 'post_viewed', occurredAt: 400 });
  });

  it('records unmatched files in the manifest without producing rows', async () => {
    const sink = collectingSink();
    await parseArchive(makeZip({ 'weird/thing.json': { x: [{ a: 1 }] } }), sink);
    expect(sink.files.find((f) => f.path.endsWith('thing.json'))?.sourceId).toBeNull();
    expect(sink.followEdges).toEqual([]);
    expect(sink.interactions).toEqual([]);
  });

  it('does not abort the whole archive when one file is malformed', async () => {
    const sink = collectingSink();
    await parseArchive(makeZip({
      'broken.json': '{ not json',
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [
          { title: '', string_list_data: [{ href: 'h', value: 'dana', timestamp: 1 }] },
        ],
      },
    }), sink);
    expect(sink.followEdges).toContainEqual({ username: 'dana', direction: 'follows_me', since: 1 });
  });
});
