import { describe, it, expect } from 'vitest';
import { matchSource, SOURCES } from '../../src/parse/registry.js';

describe('matchSource', () => {
  it('matches followers regardless of the numeric suffix or folder depth', () => {
    for (const p of [
      'connections/followers_and_following/followers_1.json',
      'connections/followers_and_following/followers_2.json',
      'some/other/prefix/followers_1.json',
    ]) {
      expect(matchSource(p)?.target).toEqual({ kind: 'follow_edge', direction: 'follows_me' });
    }
  });

  it('does not confuse following.json with followers', () => {
    const m = matchSource('connections/followers_and_following/following.json');
    expect(m?.target).toEqual({ kind: 'follow_edge', direction: 'i_follow' });
  });

  it('reads liked posts from the title field, not value', () => {
    expect(matchSource('your_instagram_activity/likes/liked_posts.json')?.usernameFrom).toBe('title');
  });

  it('reads followers from the value field', () => {
    expect(matchSource('connections/followers_and_following/followers_1.json')?.usernameFrom).toBe('value');
  });

  it('returns null for unknown files rather than throwing', () => {
    expect(matchSource('media/posts/photo.jpg')).toBeNull();
    expect(matchSource('')).toBeNull();
  });

  it('has unique ids', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
