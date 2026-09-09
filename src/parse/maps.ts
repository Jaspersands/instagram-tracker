import type { RowSink } from './parseArchive.js';

export interface TopicRow { kind: string; value: string }
export interface SearchRow { term: string; occurredAt: number | null }
export interface MyPostRow { postedAt: number | null; caption: string | null; mediaType: string | null; uri: string | null }

/**
 * The leading (^|\/) anchor matters: without it this also matches
 * `liked_comments.json`, and every liked comment would be recorded as an
 * outbound comment at double the weight.
 */
export const COMMENT_FILE = /(^|\/)(post_comments_\d+|reels_comments|comments)\.json$/i;

function slot(item: unknown, key: string): Record<string, unknown> | null {
  if (!item || typeof item !== 'object') return null;
  const smd = (item as Record<string, unknown>).string_map_data;
  if (!smd || typeof smd !== 'object') return null;
  const entry = (smd as Record<string, unknown>)[key];
  return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
}

export function mapValue(item: unknown, key: string): string | null {
  const s = slot(item, key);
  return s && typeof s.value === 'string' ? s.value : null;
}

export function mapTimestamp(item: unknown, key: string): number | null {
  const s = slot(item, key);
  return s && typeof s.timestamp === 'number' ? s.timestamp : null;
}

/**
 * A comment I left. Attributed to the *media owner* — the person whose post I
 * commented on — since that is the relationship the score is measuring. The
 * export carries no permalink for comments.
 */
export function parseComment(item: unknown, sink: RowSink): void {
  const owner = mapValue(item, 'Media Owner');
  if (!owner) return;   // comments on my own posts have no owner field
  sink.interaction({
    username: owner.trim().toLowerCase(),
    kind: 'comment',
    direction: 'out',
    occurredAt: mapTimestamp(item, 'Time'),
    permalink: null,
    text: mapValue(item, 'Comment'),
  });
}
