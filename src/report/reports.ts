import type { Db } from '../db/open.js';
import { decayedScore } from '../derive/score.js';

export interface UnfollowerRow {
  username: string;
  detectedAt: number;
  followedSince: number | null;
  daysLasted: number | null;
  myScore: number;
  iStillFollow: boolean;
}

export function unfollowers(db: Db, now: number): UnfollowerRow[] {
  const events = db.prepare(
    `SELECT a.username AS username, e.occurred_at AS detectedAt, e.snapshot_id AS snapshotId,
            a.id AS accountId
       FROM graph_event e JOIN account a ON a.id = e.account_id
      WHERE e.kind = 'lost_follower'
      ORDER BY e.occurred_at DESC`,
  ).all() as { username: string; detectedAt: number; snapshotId: number; accountId: number }[];

  const latest = db.prepare('SELECT MAX(id) AS id FROM snapshot').get() as { id: number };

  return events.map((e) => {
    const since = (db.prepare(
      `SELECT since FROM follow_edge
        WHERE account_id = ? AND direction = 'follows_me'
        ORDER BY snapshot_id DESC LIMIT 1`,
    ).get(e.accountId) as { since: number | null } | undefined)?.since ?? null;

    const rows = db.prepare(
      `SELECT kind, occurred_at AS occurredAt FROM interaction
        WHERE account_id = ? AND direction = 'out'`,
    ).all(e.accountId) as { kind: string; occurredAt: number | null }[];

    const stillFollow = db.prepare(
      `SELECT 1 FROM follow_edge
        WHERE account_id = ? AND direction = 'i_follow' AND snapshot_id = ?`,
    ).get(e.accountId, latest.id);

    return {
      username: e.username,
      detectedAt: e.detectedAt,
      followedSince: since,
      daysLasted: since === null ? null : Math.round((e.detectedAt - since) / 86400),
      myScore: decayedScore(rows, now),
      iStillFollow: Boolean(stillFollow),
    };
  });
}

export function lurkGap(db: Db, limit: number) {
  return db.prepare(
    `SELECT a.username AS username,
            COUNT(DISTINCT m.id) AS views,
            (SELECT COUNT(*) FROM interaction i
              WHERE i.account_id = a.id AND i.direction = 'out') AS engagements
       FROM impression m JOIN account a ON a.id = m.account_id
      GROUP BY a.id
      ORDER BY views DESC, engagements ASC
      LIMIT ?`,
  ).all(limit) as { username: string; views: number; engagements: number }[];
}
