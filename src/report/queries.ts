import type { Db } from '../db/open.js';
import { decayedScore } from '../derive/score.js';

export interface PersonRow {
  username: string;
  followsMe: boolean;
  iFollow: boolean;
  followedSince: number | null;
  likes: number;
  comments: number;
  storyLikes: number;
  saves: number;
  dmOut: number;
  dmIn: number;
  mentions: number;
  views: number;
  lastInteraction: number | null;
  score: number;
}

type InterRow = { accountId: number; kind: string; direction: 'out' | 'in'; occurredAt: number | null };

/** Usernames that are me, not someone I interact with. */
export function ownerUsernames(db: Db): Set<string> {
  const rows = db.prepare(
    'SELECT DISTINCT owner FROM snapshot WHERE owner IS NOT NULL',
  ).all() as { owner: string }[];
  return new Set(rows.map((r) => r.owner));
}

function latestSnapshotId(db: Db): number | null {
  return (db.prepare('SELECT MAX(id) AS id FROM snapshot').get() as { id: number | null }).id;
}

/**
 * account_id -> surviving account id. A username change creates a second account
 * row linked by merged_into; without this map the person's history is split
 * across both and the live row looks like a stranger who has never interacted.
 */
function canonicalIds(db: Db): Map<number, number> {
  const rows = db.prepare('SELECT id, merged_into AS mergedInto FROM account')
    .all() as { id: number; mergedInto: number | null }[];
  const m = new Map<number, number>();
  for (const r of rows) m.set(r.id, r.mergedInto ?? r.id);
  return m;
}

export function people(db: Db, now: number): PersonRow[] {
  const owners = ownerUsernames(db);
  const accounts = (db.prepare(
    'SELECT id, username FROM account WHERE merged_into IS NULL',
  ).all() as { id: number; username: string }[])
    .filter((a) => !owners.has(a.username));
  if (accounts.length === 0) return [];

  const canon = canonicalIds(db);

  const latest = latestSnapshotId(db);

  const edges = latest === null ? [] : (db.prepare(
    'SELECT account_id AS accountId, direction, since FROM follow_edge WHERE snapshot_id = ?',
  ).all(latest) as { accountId: number; direction: string; since: number | null }[]);

  // Impressions can be hundreds of thousands of rows — aggregate in SQL, never fetch.
  const views = db.prepare(
    'SELECT account_id AS accountId, COUNT(*) AS n FROM impression GROUP BY account_id',
  ).all() as { accountId: number; n: number }[];

  const inter = db.prepare(
    'SELECT account_id AS accountId, kind, direction, occurred_at AS occurredAt FROM interaction',
  ).all() as InterRow[];

  const followsMe = new Map<number, number | null>();
  const iFollow = new Set<number>();
  for (const e of edges) {
    if (e.direction === 'follows_me') followsMe.set(e.accountId, e.since);
    else iFollow.add(e.accountId);
  }

  const viewMap = new Map<number, number>();
  for (const v of views) {
    const id = canon.get(v.accountId) ?? v.accountId;
    viewMap.set(id, (viewMap.get(id) ?? 0) + v.n);
  }

  const byAccount = new Map<number, InterRow[]>();
  for (const r of inter) {
    const id = canon.get(r.accountId) ?? r.accountId;
    const list = byAccount.get(id);
    if (list) list.push(r); else byAccount.set(id, [r]);
  }

  return accounts.map((a) => {
    const rows = byAccount.get(a.id) ?? [];
    const n = (kind: string, dir?: 'out' | 'in') =>
      rows.filter((r) => r.kind === kind && (dir === undefined || r.direction === dir)).length;

    const times = rows.map((r) => r.occurredAt).filter((t): t is number => t !== null);

    return {
      username: a.username,
      followsMe: followsMe.has(a.id),
      iFollow: iFollow.has(a.id),
      followedSince: followsMe.get(a.id) ?? null,
      likes: n('like_post', 'out'),
      comments: n('comment', 'out'),
      storyLikes: n('like_story', 'out'),
      saves: n('save', 'out'),
      dmOut: n('dm', 'out'),
      dmIn: n('dm', 'in'),
      mentions: n('mention', 'in'),
      views: viewMap.get(a.id) ?? 0,
      lastInteraction: times.length ? Math.max(...times) : null,
      score: decayedScore(rows.filter((r) => r.direction === 'out'), now),
    };
  }).sort((x, y) => y.score - x.score);
}

export function overview(db: Db) {
  const snapshots = db.prepare(
    `SELECT s.id AS id, s.taken_at AS takenAt,
            (SELECT COUNT(*) FROM follow_edge e
              WHERE e.snapshot_id = s.id AND e.direction = 'follows_me') AS followers,
            (SELECT COUNT(*) FROM follow_edge e
              WHERE e.snapshot_id = s.id AND e.direction = 'i_follow') AS following
       FROM snapshot s ORDER BY s.id`,
  ).all() as { id: number; takenAt: number | null; followers: number; following: number }[];

  const evt = (kind: string) =>
    (db.prepare('SELECT COUNT(*) AS n FROM graph_event WHERE kind = ?').get(kind) as { n: number }).n;

  return {
    snapshots,
    gained: evt('gained_follower'),
    lost: evt('lost_follower'),
    renames: evt('probable_rename'),
    totalInteractions: (db.prepare('SELECT COUNT(*) AS n FROM interaction').get() as { n: number }).n,
  };
}

/**
 * How many of your own posts a per-post API pull would have to visit.
 *
 * Not `COUNT(*) FROM my_post`: that table also holds every story ever posted —
 * 2,854 of them here against 47 real posts — which turned a four-minute
 * estimate into "218 min" and would have talked anyone out of running it.
 * Stories are not addressable by media_likers or media_comments anyway.
 */
export function postCount(db: Db): number {
  const r = db.prepare(
    `SELECT (SELECT COUNT(DISTINCT permalink) FROM my_post WHERE permalink IS NOT NULL) AS withUrl,
            (SELECT COUNT(*) FROM my_post WHERE media_type <> 'story') AS notStories`,
  ).get() as { withUrl: number; notStories: number };
  // A permalink is the reliable signal, but the export's own post records carry
  // none, so fall back to whatever is not a story.
  return r.withUrl || r.notStories;
}

/** Posts that already have a liker list, so the UI can default to a small window. */
export function capturedPostCount(db: Db): number {
  return (db.prepare(
    "SELECT COUNT(DISTINCT permalink) AS c FROM inbound_capture WHERE kind = 'post_likes'",
  ).get() as { c: number }).c;
}

export function decay(db: Db, now: number, days: number) {
  const cutoff = now - days * 86400;
  const latest = latestSnapshotId(db);
  if (latest === null) return [];

  return db.prepare(
    `SELECT a.username AS username, MAX(i.occurred_at) AS lastInteraction
       FROM account a
       JOIN follow_edge f1 ON f1.account_id = a.id AND f1.direction = 'follows_me' AND f1.snapshot_id = ?
       JOIN follow_edge f2 ON f2.account_id = a.id AND f2.direction = 'i_follow'   AND f2.snapshot_id = ?
       LEFT JOIN interaction i ON i.account_id = a.id
      WHERE a.merged_into IS NULL
      GROUP BY a.id
     HAVING lastInteraction IS NULL OR lastInteraction < ?
      ORDER BY lastInteraction ASC NULLS FIRST`,
  ).all(latest, latest, cutoff).map((r: any) => ({
    username: r.username as string,
    lastInteraction: r.lastInteraction as number | null,
    daysSilent: r.lastInteraction === null
      ? null : Math.round((now - r.lastInteraction) / 86400),
  }));
}

export function habits(db: Db) {
  const heatmap: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  const byMonth = new Map<string, number>();

  // Union both: the newer export leaves 33k likes unattributed, and dropping
  // them would hollow out the heatmap that shows when you are actually active.
  const rows = db.prepare(
    `SELECT occurred_at AS t FROM interaction WHERE occurred_at IS NOT NULL
     UNION ALL
     SELECT occurred_at AS t FROM activity    WHERE occurred_at IS NOT NULL`,
  ).all() as { t: number }[];

  for (const { t } of rows) {
    const d = new Date(t * 1000);
    heatmap[d.getDay()][d.getHours()]++;
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    byMonth.set(m, (byMonth.get(m) ?? 0) + 1);
  }

  return {
    heatmap,
    byMonth: [...byMonth.entries()].sort().map(([month, n]) => ({ month, n })),
  };
}

export function taste(db: Db) {
  const topics = db.prepare(
    `SELECT kind, value FROM topic WHERE kind IN ('your_topic','ad_interest','ai_interest')
      GROUP BY kind, value ORDER BY kind, value`,
  ).all() as { kind: string; value: string }[];

  const hashtags = db.prepare(
    `SELECT value FROM topic WHERE kind = 'followed_hashtag' GROUP BY value ORDER BY value`,
  ).all() as { value: string }[];

  const searches = db.prepare(
    'SELECT term, occurred_at AS occurredAt FROM search_event ORDER BY occurred_at DESC LIMIT 100',
  ).all() as { term: string; occurredAt: number | null }[];

  const savedAuthors = db.prepare(
    `SELECT a.username AS username, COUNT(*) AS n
       FROM interaction i JOIN account a ON a.id = i.account_id
      WHERE i.kind = 'save' GROUP BY a.id ORDER BY n DESC LIMIT 50`,
  ).all() as { username: string; n: number }[];

  const posts = db.prepare(
    'SELECT COUNT(*) AS n, MIN(posted_at) AS first, MAX(posted_at) AS last FROM my_post',
  ).get() as { n: number; first: number | null; last: number | null };

  return { topics, hashtags, searches, savedAuthors, posts };
}

export function person(db: Db, username: string, now: number) {
  const row = people(db, now).find((p) => p.username === username) ?? null;

  const timeline = db.prepare(
    `SELECT i.kind AS kind, i.direction AS direction, i.occurred_at AS occurredAt,
            i.text AS text, i.permalink AS permalink
       FROM interaction i JOIN account a ON a.id = i.account_id
      WHERE a.username = ?
      ORDER BY i.occurred_at DESC LIMIT 500`,
  ).all(username) as {
    kind: string; direction: string; occurredAt: number | null;
    text: string | null; permalink: string | null;
  }[];

  const events = db.prepare(
    `SELECT e.kind AS kind, e.occurred_at AS occurredAt, e.confidence AS confidence
       FROM graph_event e JOIN account a ON a.id = e.account_id
      WHERE a.username = ? ORDER BY e.occurred_at DESC`,
  ).all(username) as { kind: string; occurredAt: number | null; confidence: number }[];

  return { row, timeline, events };
}

/**
 * Inbound engagement — the half the export cannot supply, assembled from
 * bookmarklet captures.
 */
export function inbound(db: Db, now: number) {
  const captures = db.prepare(
    `SELECT c.id AS id, c.kind AS kind, c.permalink AS permalink,
            c.captured_at AS capturedAt,
            (SELECT COUNT(*) FROM interaction i
              WHERE i.direction = 'in'
                AND i.permalink IS c.permalink
                AND i.occurred_at = c.captured_at) AS people
       FROM inbound_capture c ORDER BY c.captured_at DESC`,
  ).all() as { id: number; kind: string; permalink: string | null; capturedAt: number; people: number }[];

  // Only ghost detection depends on capture completeness. Superfans and
  // reciprocity are read off inbound interactions and are valid whatever their
  // source — an imported comment list creates no capture row, and gating the
  // whole report on captures silently returned nothing.
  const completeCaptures = (db.prepare(
    'SELECT COUNT(*) AS c FROM inbound_capture WHERE complete = 1',
  ).get() as { c: number }).c;

  const latest = latestSnapshotId(db);

  // The engaged set is built once in a CTE rather than re-derived per follower.
  // As a correlated NOT EXISTS, COALESCE(merged_into, id) = a.id could use no
  // index and rescanned all 109k interactions for each of 1,115 followers —
  // 6.7 seconds for this one query, which blocked the whole dashboard. Hoisting
  // it out gives the same answer in 6ms.
  const ghosts = (latest === null || completeCaptures === 0) ? [] : (db.prepare(
    `WITH engaged(id) AS (
       SELECT DISTINCT COALESCE(a2.merged_into, a2.id)
         FROM interaction i
         JOIN account a2 ON a2.id = i.account_id
        WHERE i.direction = 'in'
     )
     SELECT a.username AS username, f.since AS followedSince
       FROM account a
       JOIN follow_edge f ON f.account_id = a.id
        AND f.direction = 'follows_me' AND f.snapshot_id = ?
      WHERE a.merged_into IS NULL
        AND a.id NOT IN (SELECT id FROM engaged)
      ORDER BY f.since ASC`,
  ).all(latest) as { username: string; followedSince: number | null }[]);

  // Engagement with your *content* only. Inbound DMs are real closeness but
  // belong in the People table, not here — counting them made a DM-only friend
  // the top "superfan" with zero likes, and the total stopped matching its parts.
  const superfans = db.prepare(
    `SELECT can.username AS username,
            SUM(CASE WHEN i.kind = 'like_received'    THEN 1 ELSE 0 END) AS likesReceived,
            SUM(CASE WHEN i.kind = 'comment_received' THEN 1 ELSE 0 END) AS commentsReceived,
            SUM(CASE WHEN i.kind = 'story_view'       THEN 1 ELSE 0 END) AS storyViews,
            COUNT(*) AS total
       FROM interaction i
       JOIN account a   ON a.id = i.account_id
       JOIN account can ON can.id = COALESCE(a.merged_into, a.id)
      WHERE i.direction = 'in'
        AND i.kind IN ('like_received','comment_received','story_view')
      GROUP BY can.id ORDER BY total DESC LIMIT 200`,
  ).all() as {
    username: string; likesReceived: number; commentsReceived: number;
    storyViews: number; total: number;
  }[];

  // A Map, not .find(): 7,534 people against 200 superfans is 1.5M string
  // comparisons for a lookup that should be constant time.
  const byName = new Map(superfans.map((s) => [s.username, s.total]));
  const reciprocity = people(db, now)
    .map((p) => {
      const theyGive = byName.get(p.username) ?? 0;
      const youGive = p.likes + p.comments + p.storyLikes + p.saves + p.dmOut;
      return { username: p.username, youGive, theyGive, gap: youGive - theyGive };
    })
    .filter((r) => r.youGive > 0 || r.theyGive > 0)
    .sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap))
    .slice(0, 200);

  return { captures, ghosts, superfans, reciprocity };
}
