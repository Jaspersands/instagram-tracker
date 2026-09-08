import type { Db } from '../db/open.js';

const DAY = 86400;
export const DECAY_DAYS = 90;

export const WEIGHTS: Record<string, number> = {
  dm: 5,
  comment: 4,
  comment_received: 4,
  like_received: 2,
  story_view: 0.5,
  save: 3,
  mention: 3,
  like_story: 2.5,
  like_post: 2,
  like_comment: 2,
  post_viewed: 0.15,
  video_watched: 0.15,
};

export function decayedScore(
  rows: { kind: string; occurredAt: number | null }[],
  now: number,
): number {
  let total = 0;
  for (const r of rows) {
    const w = WEIGHTS[r.kind];
    if (w === undefined || r.occurredAt === null) continue;
    const ageDays = Math.max(0, (now - r.occurredAt) / DAY);
    total += w * Math.exp(-ageDays / DECAY_DAYS);
  }
  return total;
}

export interface PersonScore {
  username: string;
  outScore: number;
  inScore: number;
  reciprocity: number;
}

export function scoreEveryone(db: Db, now: number): PersonScore[] {
  const rows = db.prepare(
    `SELECT a.username AS username, i.kind AS kind,
            i.direction AS direction, i.occurred_at AS occurredAt
       FROM interaction i JOIN account a ON a.id = i.account_id`,
  ).all() as { username: string; kind: string; direction: 'out' | 'in'; occurredAt: number | null }[];

  const byUser = new Map<string, { out: typeof rows; in: typeof rows }>();
  for (const r of rows) {
    let e = byUser.get(r.username);
    if (!e) { e = { out: [], in: [] }; byUser.set(r.username, e); }
    (r.direction === 'out' ? e.out : e.in).push(r);
  }

  return [...byUser.entries()]
    .map(([username, e]) => {
      const outScore = decayedScore(e.out, now);
      const inScore = decayedScore(e.in, now);
      return {
        username,
        outScore,
        inScore,
        reciprocity: outScore === 0 ? 0 : inScore / outScore,
      };
    })
    .sort((a, b) => b.outScore - a.outScore);
}
