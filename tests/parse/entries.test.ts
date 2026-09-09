import { describe, it, expect } from 'vitest';
import { collectItems, normalizeEntries, normalizeEntry } from '../../src/parse/entries.js';

const FOLLOWERS = {
  relationships_followers: [
    { title: '', media_list_data: [], string_list_data: [
      { href: 'https://www.instagram.com/Alice', value: 'Alice', timestamp: 1700000000 } ] },
    { title: '', media_list_data: [], string_list_data: [
      { href: 'https://www.instagram.com/bob', value: 'bob', timestamp: 1700000100 } ] },
  ],
};

// Real exports ship followers as a bare top-level array in some versions.
const FOLLOWERS_BARE = FOLLOWERS.relationships_followers;

const LIKED = {
  likes_media_likes: [
    { title: 'carol', string_list_data: [
      { href: 'https://www.instagram.com/p/XYZ/', value: '❤️', timestamp: 1700000200 } ] },
  ],
};

describe('collectItems', () => {
  it('unwraps a single array-valued key', () => {
    expect(collectItems(FOLLOWERS)).toHaveLength(2);
  });

  it('accepts a bare top-level array', () => {
    expect(collectItems(FOLLOWERS_BARE)).toHaveLength(2);
  });

  it('returns empty for null, undefined and empty objects', () => {
    expect(collectItems(null)).toEqual([]);
    expect(collectItems(undefined)).toEqual([]);
    expect(collectItems({})).toEqual([]);
  });
});

describe('normalizeEntries', () => {
  it('reads the username from string_list_data.value and lowercases it', () => {
    const out = normalizeEntries(FOLLOWERS, 'value');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({
      username: 'alice',
      href: 'https://www.instagram.com/Alice',
      timestamp: 1700000000,
      value: 'Alice',
    });
  });

  it('reads the username from title when value holds an emoji', () => {
    const out = normalizeEntries(LIKED, 'title');
    expect(out).toHaveLength(1);
    expect(out[0].username).toBe('carol');
    expect(out[0].href).toBe('https://www.instagram.com/p/XYZ/');
    expect(out[0].timestamp).toBe(1700000200);
  });

  it('skips items with no resolvable username instead of throwing', () => {
    const junk = { whatever: [{ title: '', string_list_data: [] }, { nope: 1 }] };
    expect(normalizeEntries(junk, 'value')).toEqual([]);
  });

  it('tolerates a missing timestamp', () => {
    const noTs = { x: [{ title: 'dave', string_list_data: [{ href: null, value: 'dave' }] }] };
    expect(normalizeEntries(noTs, 'value')[0].timestamp).toBeNull();
  });
});

describe('normalizeEntry', () => {
  it('normalizes a single item', () => {
    const item = { title: '', string_list_data: [{ href: 'h', value: 'Eve', timestamp: 5 }] };
    expect(normalizeEntry(item, 'value')?.username).toBe('eve');
  });

  it('returns null rather than throwing on junk', () => {
    expect(normalizeEntry(null, 'value')).toBeNull();
    expect(normalizeEntry(42, 'value')).toBeNull();
    expect(normalizeEntry({ nope: 1 }, 'value')).toBeNull();
  });
});

describe('username source fallback', () => {
  // followers_1.json puts the username in string_list_data[0].value with an
  // empty title; following.json puts it in title and omits value entirely.
  // Reading one convention for both silently dropped all 1,359 follows.
  const followersShape = {
    relationships_followers: [
      { title: '', media_list_data: [], string_list_data: [
        { href: 'https://www.instagram.com/pip_thornbury', value: 'pip_thornbury', timestamp: 1788829514 }] },
    ],
  };
  const followingShape = {
    relationships_following: [
      { title: 'pip_thornbury', string_list_data: [
        { href: 'https://www.instagram.com/_u/pip_thornbury', timestamp: 1788829516 }] },
    ],
  };

  it('reads followers from value', () => {
    expect(normalizeEntries(followersShape, 'value')[0].username).toBe('pip_thornbury');
  });

  it('falls back to title when value is absent', () => {
    expect(normalizeEntries(followingShape, 'value')[0].username).toBe('pip_thornbury');
  });

  it('falls back to value when title is empty', () => {
    expect(normalizeEntries(followersShape, 'title')[0].username).toBe('pip_thornbury');
  });

  it('refuses a fallback that is not username-shaped', () => {
    // liked_posts has title=author and value=emoji. Falling back blindly would
    // record "❤️" as a person.
    const emoji = { x: [{ title: '', string_list_data: [{ href: 'p', value: '❤️', timestamp: 1 }] }] };
    expect(normalizeEntries(emoji, 'title')).toEqual([]);
  });

  it('still refuses a caption-length string as a username', () => {
    const caption = { x: [{ title: '', string_list_data: [
      { href: 'p', value: 'what a lovely day out here in the park', timestamp: 1 }] }] };
    expect(normalizeEntries(caption, 'title')).toEqual([]);
  });
});
