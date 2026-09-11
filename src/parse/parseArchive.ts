import { eachJsonEntry } from '../archive/reader.js';
import { matchSource } from './registry.js';
import { normalizeEntry } from './entries.js';
import { isMessageFile, parseMessageThread } from './messages.js';
import { mapValue, mapTimestamp, parseComment, COMMENT_FILE } from './maps.js';
import type { TopicRow, SearchRow, MyPostRow } from './maps.js';
import { labelUsername, labelTimestamp, labelUrl, labelValue, labelValueDeep, usernameFromStoryUrl } from './labels.js';

export interface FollowEdgeRow { username: string; direction: 'follows_me' | 'i_follow'; since: number | null }
export interface ListRow { username: string; list: string }
export interface InteractionRow {
  username: string; kind: string; direction: 'out' | 'in'; occurredAt: number | null;
  permalink: string | null; text: string | null;
  /** DM messages only: the thread they came from. */
  threadId?: string | null;
}
export interface ImpressionRow { username: string; kind: string; occurredAt: number | null }
export interface ActivityRow { kind: string; occurredAt: number | null; permalink: string | null }
export interface DmThreadRow { threadId: string; folderName: string | null; placeholder: string }
export interface FileRow { path: string; sourceId: string | null; count: number }

export interface RowSink {
  followEdge(r: FollowEdgeRow): void;
  list(r: ListRow): void;
  interaction(r: InteractionRow): void;
  impression(r: ImpressionRow): void;
  topic(r: TopicRow): void;
  search(r: SearchRow): void;
  post(r: MyPostRow): void;
  activity(r: ActivityRow): void;
  dmThread(r: DmThreadRow): void;
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

    const special = SPECIAL.find((m) => m.match.test(src.path));
    if (special) {
      let n = 0;
      try { for await (const item of src.items()) { special.handle(item, sink); n++; } } catch { /* skip */ }
      sink.file({ path: src.path, sourceId: special.id, count: n });
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
    activities: [] as ActivityRow[],
    dmThreads: [] as DmThreadRow[],
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
    activity(r: ActivityRow) { s.activities.push(r); },
    dmThread(r: DmThreadRow) { s.dmThreads.push(r); },
    file(r: FileRow) { s.files.push(r); },
  };
  return s;
}

/**
 * Files the path registry cannot express, because they use string_map_data or
 * label_values rather than string_list_data. Kept at module scope so classify()
 * can report them and the inventory's UNMATCHED list stays honest.
 */
export interface SpecialDef {
  id: string;
  match: RegExp;
  handle(item: unknown, sink: RowSink): void;
}

export const SPECIAL: SpecialDef[] = [
  // Comments carry weight 4 in scoring — second only to DMs.
  { id: 'comments', match: COMMENT_FILE, handle: (i, sink) => parseComment(i, sink) },

  { id: 'your_topics', match: /your_topics\.json$/i,
    handle: (i, sink) => { const v = mapValue(i, 'Name'); if (v) sink.topic({ kind: 'your_topic', value: v }); } },
  // Meta replaced your_topics/ads_interests with an AI-written list of
  // natural-language statements ("The user might be interested in cycling").
  { id: 'ai_interests', match: /interest_categories\.json$/i,
    handle: (i, sink) => {
      const v = labelValue(i, 'Interest');
      if (v) sink.topic({ kind: 'ai_interest', value: v });
    } },

  { id: 'ads_interests', match: /ads_interests\.json$/i,
    handle: (i, sink) => { const v = mapValue(i, 'Interest'); if (v) sink.topic({ kind: 'ad_interest', value: v }); } },
  { id: 'searches', match: /word_or_phrase_searches\.json$/i,
    handle: (i, sink) => { const v = mapValue(i, 'Search');
                           if (v) sink.search({ term: v, occurredAt: mapTimestamp(i, 'Time') }); } },

  // Hashtags use string_list_data but are topics, not people — routing them
  // through the registry would pollute the account table with '#cats'.
  { id: 'followed_hashtags', match: /following_hashtags\.json$/i,
    handle: (i, sink) => { const e = normalizeEntry(i, 'value');
                           if (e) sink.topic({ kind: 'followed_hashtag', value: e.username }); } },

  // Accounts I unfollowed, with the date. The natural complement to detecting
  // who unfollowed me, and the export hands it over directly.
  { id: 'recently_unfollowed', match: /recently_unfollowed_profiles\.json$/i,
    handle: (i, sink) => {
      const u = labelUsername(i);
      if (u) sink.interaction({ username: u, kind: 'unfollowed_them', direction: 'out',
                                occurredAt: labelTimestamp(i), permalink: null, text: null });
    } },

  { id: 'suggested_profiles', match: /suggested_profiles_viewed\.json$/i,
    handle: (i, sink) => {
      const u = labelUsername(i);
      if (u) sink.impression({ username: u, kind: 'suggested_profile', occurredAt: labelTimestamp(i) });
    } },

  // Story likes: the only one of the migrated files where the author survives,
  // because a story URL contains the username. Falls back to the old
  // string_list_data shape so older exports still parse.
  { id: 'story_likes', match: /story_likes\.json$/i,
    handle: (i, sink) => {
      const old = normalizeEntry(i, 'title');
      if (old) {
        sink.interaction({ username: old.username, kind: 'like_story', direction: 'out',
                           occurredAt: old.timestamp, permalink: old.href, text: null });
        return;
      }
      const url = labelUrl(i);
      const u = usernameFromStoryUrl(url);
      if (u) sink.interaction({ username: u, kind: 'like_story', direction: 'out',
                                occurredAt: labelTimestamp(i), permalink: url, text: null });
    } },

  // Likes, saves and views: Meta's newer format records only /p/<shortcode>,
  // with no author in the record at all. They cannot be attributed to a person,
  // but their timestamps still drive the habits heatmap and volume trend.
  // The old shape put the author in `title` for likes and saves, but in
  // `value` for views — applying one to all silently dropped every view.
  ...([
    ['liked_posts', /liked_posts\.json$/i, 'like_post', 'title'],
    ['saved_posts', /saved_(posts|collections)\.json$/i, 'save', 'title'],
    ['posts_viewed', /posts_viewed\.json$/i, 'post_viewed', 'value'],
    ['videos_watched', /videos_watched\.json$/i, 'video_watched', 'value'],
  ] as const).map(([id, match, kind, usernameFrom]) => ({
    id, match,
    handle: (i: unknown, sink: RowSink) => {
      const old = normalizeEntry(i, usernameFrom);
      if (old) {
        // Older exports still name the author.
        if (kind === 'post_viewed' || kind === 'video_watched') {
          sink.impression({ username: old.username, kind, occurredAt: old.timestamp });
        } else {
          sink.interaction({ username: old.username, kind, direction: 'out',
                             occurredAt: old.timestamp, permalink: old.href, text: null });
        }
        return;
      }
      sink.activity({ kind, occurredAt: labelTimestamp(i), permalink: labelUrl(i) });
    },
  })),

  // My own posts. The device download puts these under content/, a cloud
  // transfer under media/ — both must match.
  { id: 'my_posts', match: /(content|media)\/posts(_\d+)?\.json$/i,
    handle: (i, sink) => {
      if (!i || typeof i !== 'object') return;
      const it = i as Record<string, unknown>;
      const media = Array.isArray(it.media) ? ((it.media[0] as Record<string, unknown>) ?? {}) : {};
      const postedAt = typeof it.creation_timestamp === 'number' ? it.creation_timestamp
        : typeof media.creation_timestamp === 'number' ? media.creation_timestamp : null;
      const caption = typeof it.title === 'string' && it.title ? it.title
        : typeof media.title === 'string' ? media.title : null;
      const uri = typeof media.uri === 'string' ? media.uri : null;
      sink.post({ postedAt, caption, uri,
                  mediaType: /\.mp4$/i.test(uri ?? '') ? 'video' : 'image' });
    } },

  // My own stories and archived posts: flat records with a uri and timestamp
  // rather than a media[] array.
  { id: 'my_stories', match: /media\/(stories|archived_posts|other_content)\.json$/i,
    handle: (i, sink) => {
      if (!i || typeof i !== 'object') return;
      const it = i as Record<string, unknown>;
      const uri = typeof it.uri === 'string' ? it.uri : null;
      const postedAt = typeof it.creation_timestamp === 'number' ? it.creation_timestamp : null;
      if (!uri && postedAt === null) return;
      sink.post({
        postedAt,
        caption: typeof it.title === 'string' && it.title ? it.title : null,
        uri,
        mediaType: /stories\//.test(uri ?? '') ? 'story'
          : /\.mp4$/i.test(uri ?? '') ? 'video' : 'image',
      });
    } },

  // Notes and reposts name the author, but two dicts deep under an "Author"
  // group — a flat label scan finds nothing.
  { id: 'note_reposts', match: /note_and_repost_interactions\.json$/i,
    handle: (i, sink) => {
      const u = labelValueDeep(i, 'Username');
      if (u) sink.interaction({ username: u.trim().toLowerCase(), kind: 'note_interaction',
                                direction: 'out', occurredAt: labelTimestamp(i),
                                permalink: null, text: null });
    } },

  { id: 'not_interested_profiles', match: /profiles_you.*not_interested_in\.json$/i,
    handle: (i, sink) => {
      const u = labelUsername(i);
      if (u) sink.impression({ username: u, kind: 'not_interested', occurredAt: labelTimestamp(i) });
    } },

  // Story interactions and ad/link history carry no author at all, but their
  // timestamps belong in the activity picture.
  ...([
    ['story_polls', /story_interactions\/polls\.json$/i, 'poll_answered'],
    ['story_quizzes', /story_interactions\/quizzes\.json$/i, 'quiz_answered'],
    ['story_sliders', /story_interactions\/emoji_sliders\.json$/i, 'slider_answered'],
    ['story_questions', /story_interactions\/questions\.json$/i, 'question_answered'],
    ['stories_viewed', /stories_viewed\.json$/i, 'story_viewed'],
    ['ads_viewed', /ads_viewed\.json$/i, 'ad_viewed'],
    ['link_history', /link_history\.json$/i, 'link_opened'],
  ] as const).map(([id, match, kind]) => ({
    id, match,
    handle: (i: unknown, sink: RowSink) =>
      sink.activity({ kind, occurredAt: labelTimestamp(i), permalink: labelUrl(i) }),
  })),
];

/**
 * Which handler claims a path, if any. Shared with the inventory so its
 * UNMATCHED column reflects what ingest actually parses rather than only what
 * the path registry covers.
 */
export function classify(path: string): string | null {
  if (isMessageFile(path)) return 'dm_thread';
  const special = SPECIAL.find((m) => m.match.test(path));
  if (special) return special.id;
  return matchSource(path)?.id ?? null;
}
