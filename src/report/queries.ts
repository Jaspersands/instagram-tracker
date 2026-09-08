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

function latestSnapshotId(db: Db): number | null {
  return (db.prepare('SELECT MAX(id) AS id FROM snapshot').get() as { id: number | null }).id;
}

export function people(db: Db, now: number): PersonRow[] {
  const accounts = db.prepare(
    'SELECT id, username FROM account WHERE merged_into IS NULL',
  ).all() as { id: number; username: string }[];
  if (accounts.length === 0) return [];

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

  const viewMap = new Map(views.map((v) => [v.accountId, v.n]));
  const byAccount = new Map<number, InterRow[]>();
  for (const r of inter) {
    const list = byAccount.get(r.accountId);
    if (list) list.push(r); else byAccount.set(r.accountId, [r]);
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

  const rows = db.prepare(
    'SELECT occurred_at AS t FROM interaction WHERE occurred_at IS NOT NULL',
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
    `SELECT kind, value FROM topic WHERE kind IN ('your_topic','ad_interest')
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
