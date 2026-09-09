import type { UsernameSource } from './entries.js';

export type SourceTarget =
  | { kind: 'follow_edge'; direction: 'follows_me' | 'i_follow' }
  | { kind: 'list'; list: string }
  | { kind: 'interaction'; interactionKind: string; direction: 'out' | 'in' }
  | { kind: 'impression'; impressionKind: string };

export interface SourceDef {
  id: string;
  match: RegExp;
  usernameFrom: UsernameSource;
  target: SourceTarget;
}

export const SOURCES: SourceDef[] = [
  // --- graph ---
  { id: 'followers', match: /followers_\d+\.json$/i, usernameFrom: 'value',
    target: { kind: 'follow_edge', direction: 'follows_me' } },
  // following.json names the person in `title`; followers_1.json uses `value`.
  { id: 'following', match: /(^|\/)following\.json$/i, usernameFrom: 'title',
    target: { kind: 'follow_edge', direction: 'i_follow' } },

  // --- lists ---
  { id: 'close_friends', match: /close_friends\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'close_friends' } },
  { id: 'blocked', match: /blocked_(profiles|accounts)\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'blocked' } },
  { id: 'restricted', match: /restricted_(profiles|accounts)\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'restricted' } },
  { id: 'hide_story_from', match: /hide_story_from\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'hide_story_from' } },
  { id: 'pending_out', match: /pending_follow_requests\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'pending_out' } },
  { id: 'pending_in', match: /follow_requests_you.*received\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'pending_in' } },
  { id: 'recent_requests', match: /recent_follow_requests\.json$/i, usernameFrom: 'value',
    target: { kind: 'list', list: 'recent_requests' } },

  // --- outbound interactions (username is the *author* of the liked thing) ---
  { id: 'liked_posts', match: /liked_posts\.json$/i, usernameFrom: 'title',
    target: { kind: 'interaction', interactionKind: 'like_post', direction: 'out' } },
  { id: 'liked_comments', match: /liked_comments\.json$/i, usernameFrom: 'title',
    target: { kind: 'interaction', interactionKind: 'like_comment', direction: 'out' } },
  { id: 'story_likes', match: /story_likes\.json$/i, usernameFrom: 'title',
    target: { kind: 'interaction', interactionKind: 'like_story', direction: 'out' } },
  { id: 'saved_posts', match: /saved_(posts|collections)\.json$/i, usernameFrom: 'title',
    target: { kind: 'interaction', interactionKind: 'save', direction: 'out' } },

  // Accounts I looked up. string_list_data with the username in `title`.
  { id: 'profile_searches', match: /profile_searches\.json$/i, usernameFrom: 'title',
    target: { kind: 'interaction', interactionKind: 'profile_search', direction: 'out' } },

  // --- inbound from the export ---
  { id: 'tagged', match: /(tagged|mentions)\w*\.json$/i, usernameFrom: 'title',
    target: { kind: 'interaction', interactionKind: 'mention', direction: 'in' } },

  // --- impressions (high volume) ---
  { id: 'posts_viewed', match: /posts_viewed\.json$/i, usernameFrom: 'value',
    target: { kind: 'impression', impressionKind: 'post_viewed' } },
  { id: 'videos_watched', match: /videos_watched\.json$/i, usernameFrom: 'value',
    target: { kind: 'impression', impressionKind: 'video_watched' } },
  { id: 'suggested_seen', match: /suggested_accounts_viewed\.json$/i, usernameFrom: 'value',
    target: { kind: 'impression', impressionKind: 'suggested_account' } },
  { id: 'not_interested', match: /accounts_you.*not_interested\.json$/i, usernameFrom: 'value',
    target: { kind: 'impression', impressionKind: 'not_interested' } },
];

export function matchSource(path: string): SourceDef | null {
  if (!path) return null;
  return SOURCES.find((s) => s.match.test(path)) ?? null;
}
