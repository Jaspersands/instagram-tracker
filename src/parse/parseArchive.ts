import { eachJsonEntry } from '../archive/reader.js';
import { matchSource } from './registry.js';
import { normalizeEntry } from './entries.js';
import { isMessageFile, parseMessageThread } from './messages.js';
import { mapValue, mapTimestamp, parseComment, COMMENT_FILE } from './maps.js';
import type { TopicRow, SearchRow, MyPostRow } from './maps.js';

export interface FollowEdgeRow { username: string; direction: 'follows_me' | 'i_follow'; since: number | null }
export interface ListRow { username: string; list: string }
export interface InteractionRow { username: string; kind: string; direction: 'out' | 'in'; occurredAt: number | null; permalink: string | null; text: string | null }
export interface ImpressionRow { username: string; kind: string; occurredAt: number | null }
export interface FileRow { path: string; sourceId: string | null; count: number }

export interface RowSink {
  followEdge(r: FollowEdgeRow): void;
  list(r: ListRow): void;
  interaction(r: InteractionRow): void;
  impression(r: ImpressionRow): void;
  topic(r: TopicRow): void;
  search(r: SearchRow): void;
  post(r: MyPostRow): void;
  file(r: FileRow): void;
}

export async function parseArchive(zipPath: string, sink: RowSink): Promise<void> {
  await eachJsonEntry(zipPath, async (src) => {
    // DM threads first: participants and messages are sibling arrays, so
    // items() would unwrap only the first of them. raw() is required here.
    if (isMessageFile(src.path)) {
      let count = 0;
      try {
        count = parseMessageThread(await src.raw(), sink);
      } catch {
        // One unreadable thread must not abort the archive.
      }
      sink.file({ path: src.path, sourceId: 'dm_thread', count });
      return;
    }

    // string_map_data family — the registry's string_list_data extractor
    // cannot reach these shapes.
    const MAPS: { match: RegExp; handle: (item: unknown) => void }[] = [
      // Comments carry weight 4 in scoring — second only to DMs.
      { match: COMMENT_FILE, handle: (i) => parseComment(i, sink) },
      { match: /your_topics\.json$/i,
        handle: (i) => { const v = mapValue(i, 'Name'); if (v) sink.topic({ kind: 'your_topic', value: v }); } },
      { match: /ads_interests\.json$/i,
        handle: (i) => { const v = mapValue(i, 'Interest'); if (v) sink.topic({ kind: 'ad_interest', value: v }); } },
      { match: /word_or_phrase_searches\.json$/i,
        handle: (i) => { const v = mapValue(i, 'Search');
                         if (v) sink.search({ term: v, occurredAt: mapTimestamp(i, 'Time') }); } },
      // Hashtags use string_list_data but are topics, not people — routing them
      // through the registry would pollute the account table with '#cats'.
      { match: /following_hashtags\.json$/i,
        handle: (i) => { const e = normalizeEntry(i, 'value');
                         if (e) sink.topic({ kind: 'followed_hashtag', value: e.username }); } },
      // My own posts: top-level creation_timestamp, else the first media item's.
      { match: /content\/posts_\d+\.json$/i,
        handle: (i) => {
          if (!i || typeof i !== 'object') return;
          const it = i as Record<string, unknown>;
          const media = Array.isArray(it.media) ? ((it.media[0] as Record<string, unknown>) ?? {}) : {};
          const postedAt = typeof it.creation_timestamp === 'number' ? it.creation_timestamp
            : typeof media.creation_timestamp === 'number' ? media.creation_timestamp : null;
          const caption = typeof it.title === 'string' && it.title ? it.title
            : typeof media.title === 'string' ? media.title : null;
          const uri = typeof media.uri === 'string' ? media.uri : '';
          sink.post({ postedAt, caption, mediaType: /\.mp4$/i.test(uri) ? 'video' : 'image' });
        } },
    ];
    const mapDef = MAPS.find((m) => m.match.test(src.path));
    if (mapDef) {
      let n = 0;
      try { for await (const item of src.items()) { mapDef.handle(item); n++; } } catch { /* skip */ }
      sink.file({ path: src.path, sourceId: 'string_map', count: n });
      return;
    }

    const def = matchSource(src.path);
    let count = 0;

    try {
      for await (const raw of src.items()) {
        if (!def) { count++; continue; }
        const e = normalizeEntry(raw, def.usernameFrom);
        if (!e) continue;
        count++;

        switch (def.target.kind) {
          case 'follow_edge':
            sink.followEdge({ username: e.username, direction: def.target.direction, since: e.timestamp });
            break;
          case 'list':
            sink.list({ username: e.username, list: def.target.list });
            break;
          case 'interaction':
            sink.interaction({
              username: e.username,
              kind: def.target.interactionKind,
              direction: def.target.direction,
              occurredAt: e.timestamp,
              permalink: e.href,
              text: null,
            });
            break;
          case 'impression':
            sink.impression({ username: e.username, kind: def.target.impressionKind, occurredAt: e.timestamp });
            break;
        }
      }
    } catch {
      // A single unreadable file must not abort the archive.
    }

    sink.file({ path: src.path, sourceId: def?.id ?? null, count });
  });
}

export function collectingSink() {
  const s = {
    followEdges: [] as FollowEdgeRow[],
    lists: [] as ListRow[],
    interactions: [] as InteractionRow[],
    impressions: [] as ImpressionRow[],
    topics: [] as TopicRow[],
    searches: [] as SearchRow[],
    posts: [] as MyPostRow[],
    files: [] as FileRow[],
    followEdge(r: FollowEdgeRow) { s.followEdges.push(r); },
    list(r: ListRow) { s.lists.push(r); },
    interaction(r: InteractionRow) { s.interactions.push(r); },
    impression(r: ImpressionRow) { s.impressions.push(r); },
    topic(r: TopicRow) { s.topics.push(r); },
    search(r: SearchRow) { s.searches.push(r); },
    post(r: MyPostRow) { s.posts.push(r); },
    file(r: FileRow) { s.files.push(r); },
  };
  return s;
}
