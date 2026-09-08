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
