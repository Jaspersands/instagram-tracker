import { describe, it, expect } from 'vitest';
import { mapValue, mapTimestamp, parseComment, COMMENT_FILE } from '../../src/parse/maps.js';
import { collectingSink } from '../../src/parse/parseArchive.js';

const topic = { string_map_data: { Name: { value: 'Cats' } } };
const search = { string_map_data: { Search: { value: 'ski trip' }, Time: { timestamp: 1700000000 } } };
const comment = { string_map_data: {
  Comment: { value: 'nice pic' },
  'Media Owner': { value: 'Bob' },
  Time: { timestamp: 1700000500 },
} };

describe('mapValue', () => {
  it('reads a named value out of string_map_data', () => {
    expect(mapValue(topic, 'Name')).toBe('Cats');
    expect(mapValue(search, 'Search')).toBe('ski trip');
  });
  it('returns null for a missing key or malformed item', () => {
    expect(mapValue(topic, 'Nope')).toBeNull();
    expect(mapValue(null, 'Name')).toBeNull();
    expect(mapValue({}, 'Name')).toBeNull();
  });
});

describe('mapTimestamp', () => {
  it('reads a timestamp', () => {
    expect(mapTimestamp(search, 'Time')).toBe(1700000000);
  });
  it('returns null when absent', () => {
    expect(mapTimestamp(topic, 'Time')).toBeNull();
  });
});

describe('COMMENT_FILE pattern', () => {
  it('matches the comment files', () => {
    expect(COMMENT_FILE.test('your_instagram_activity/comments/post_comments_1.json')).toBe(true);
    expect(COMMENT_FILE.test('your_instagram_activity/comments/reels_comments.json')).toBe(true);
  });

  it('does NOT swallow liked_comments.json, which is a like and not a comment', () => {
    // Without the leading-slash anchor this matches, and every liked comment
    // silently becomes an outbound comment with the wrong weight.
    expect(COMMENT_FILE.test('your_instagram_activity/likes/liked_comments.json')).toBe(false);
  });
});

describe('parseComment', () => {
  it('emits an outbound comment interaction with a lowercased username', () => {
    const sink = collectingSink();
    parseComment(comment, sink);
    expect(sink.interactions).toEqual([{
      username: 'bob', kind: 'comment', direction: 'out',
      occurredAt: 1700000500, permalink: null, text: 'nice pic',
    }]);
  });

  it('skips a comment with no media owner rather than inventing one', () => {
    const sink = collectingSink();
    parseComment({ string_map_data: { Comment: { value: 'hi' } } }, sink);
    expect(sink.interactions).toEqual([]);
  });
});
