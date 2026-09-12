import type { Db } from '../db/open.js';
import { people, overview, habits, taste } from '../report/queries.js';
import { unfollowers } from '../report/reports.js';
import { status } from '../report/status.js';

/**
 * The public payload: real numbers about the account owner, and not one
 * third-party name.
 *
 * This exists because the published page is world-readable static hosting, so
 * anything in here is permanently public. It is built as an explicit
 * **whitelist** — every field is a count, a date, a bucket, or a string drawn
 * from a fixed vocabulary — rather than by removing fields from a full report.
 * A denylist would leak the first time a query gained a column.
 *
 * Deliberately excluded, each for a concrete reason:
 *   - usernames and display names        7,200 real people
 *   - DM text                            66,713 messages other people wrote
 *   - search terms                       they contain usernames ("sam swite")
 *   - saved-post authors                 usernames
 *   - per-person anything                the point of the exclusion
 *
 * tests/publish/noNames.test.ts asserts no username from the database appears
 * anywhere in the output, so the automated monthly publish cannot leak one.
 */
export interface PublicPayload {
  generatedAt: number;
  /** One point per ingested export. */
  exports: { takenAt: number | null; followers: number; following: number }[];
  totals: {
    followers: number | null;
    following: number | null;
    mutuals: number;
    peopleKnown: number;
    interactions: number;
    unattributed: number;
    impressions: number;
    gainedFollowers: number;
    lostFollowers: number;
    dmThreads: number;
    dmMessages: number;
    daysSinceExport: number | null;
  };
  /** Interaction counts by kind — kind names are a fixed vocabulary. */
  byKind: { kind: string; n: number }[];
  /** Unfollow events with their timing, never who. */
  unfollowerEvents: { detectedAt: number; daysLasted: number | null }[];
  /** Weekday x hour activity grid. */
  heatmap: number[][];
  byMonth: { month: string; n: number }[];
  /** Instagram's inferred interests — statements about the owner, not people. */
  interests: string[];
  hashtags: string[];
  /** Shape of the social graph without naming any of it. */
  closeness: { bucket: string; n: number }[];
  relationships: { mutual: number; theyOnly: number; youOnly: number; neverEngaged: number };
}

const BUCKETS: { bucket: string; min: number }[] = [
  { bucket: '80–100', min: 80 }, { bucket: '60–79', min: 60 }, { bucket: '40–59', min: 40 },
  { bucket: '20–39', min: 20 }, { bucket: '1–19', min: 1 }, { bucket: '0', min: 0 },
];

export function buildPublicPayload(db: Db, now: number): PublicPayload {
  const ov = overview(db);
  const st = status(db, now);
  const hab = habits(db);
  const tst = taste(db);
  const ppl = people(db, now);
  const unf = unfollowers(db, now);

  const latest = ov.snapshots[ov.snapshots.length - 1];
  const maxScore = ppl.reduce((m, p) => Math.max(m, p.score), 0);
  const rel = { mutual: 0, theyOnly: 0, youOnly: 0, neverEngaged: 0 };
  const counts = new Map<string, number>(BUCKETS.map((b) => [b.bucket, 0]));

  for (const p of ppl) {
    if (p.followsMe && p.iFollow) rel.mutual++;
    else if (p.followsMe) rel.theyOnly++;
    else if (p.iFollow) rel.youOnly++;
    const touched = p.likes + p.comments + p.storyLikes + p.saves + p.dmOut + p.dmIn + p.mentions;
    if (touched === 0) rel.neverEngaged++;

    const rank = maxScore <= 0 ? 0 : Math.round((p.score / maxScore) * 100);
    const b = BUCKETS.find((x) => rank >= x.min) ?? BUCKETS[BUCKETS.length - 1];
    counts.set(b.bucket, (counts.get(b.bucket) ?? 0) + 1);
  }

  const byKind = (db.prepare(
    'SELECT kind, COUNT(*) AS n FROM interaction GROUP BY kind ORDER BY n DESC',
  ).all() as { kind: string; n: number }[]);

  const dmMessages = byKind.find((k) => k.kind === 'dm')?.n ?? 0;

  return {
    generatedAt: now,
    exports: ov.snapshots.map((s) => ({
      takenAt: s.takenAt, followers: s.followers, following: s.following,
    })),
    totals: {
      followers: latest ? latest.followers : null,
      following: latest ? latest.following : null,
      mutuals: rel.mutual,
      peopleKnown: ppl.length,
      interactions: st.interactions,
      unattributed: st.activity,
      impressions: st.impressions,
      gainedFollowers: ov.gained,
      lostFollowers: ov.lost,
      dmThreads: st.dmThreads,
      dmMessages,
      daysSinceExport: st.daysSinceExport,
    },
    // Only the kind label and a count. No permalink, no text, no account.
    byKind: byKind.map((k) => ({ kind: k.kind, n: k.n })),
    unfollowerEvents: unf.map((u) => ({ detectedAt: u.detectedAt, daysLasted: u.daysLasted })),
    heatmap: hab.heatmap,
    byMonth: hab.byMonth,
    interests: tst.topics.map((t) => t.value),
    hashtags: tst.hashtags.map((h) => h.value),
    closeness: BUCKETS.map((b) => ({ bucket: b.bucket, n: counts.get(b.bucket) ?? 0 })),
    relationships: rel,
  };
}
