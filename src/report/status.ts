import type { Db } from '../db/open.js';

export interface Status {
  snapshots: number;
  lastExport: number | null;
  daysSinceExport: number | null;
  followers: number | null;
  accounts: number;
  interactions: number;
  impressions: number;
  activity: number;
  captures: number;
  dmThreads: number;
  dmLinked: number;
  unfollowers: number;
  warnings: string[];
}

const STALE_DAYS = 30;

export function status(db: Db, now: number): Status {
  const n = (t: string) => (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;

  const snapshots = n('snapshot');
  const last = db.prepare(
    'SELECT id, taken_at AS takenAt FROM snapshot ORDER BY id DESC LIMIT 1',
  ).get() as { id: number; takenAt: number | null } | undefined;

  const lastExport = last?.takenAt ?? null;
  const daysSinceExport = lastExport === null
    ? null : Math.floor((now - lastExport) / 86400);

  const followers = last
    ? (db.prepare(
        `SELECT COUNT(*) AS c FROM follow_edge
          WHERE snapshot_id = ? AND direction = 'follows_me'`,
      ).get(last.id) as { c: number }).c
    : null;

  const captures = n('inbound_capture');

  // A DM thread folder is named after the display name, which the export omits,
  // so most threads start life unlinked to the follow graph.
  const dmThreads = (db.prepare(
    `SELECT COUNT(DISTINCT account_id) AS c FROM interaction WHERE kind = 'dm'`,
  ).get() as { c: number }).c;
  const dmLinked = (db.prepare(
    `SELECT COUNT(DISTINCT COALESCE(a.merged_into, a.id)) AS c
       FROM interaction i JOIN account a ON a.id = i.account_id
      WHERE i.kind = 'dm'
        AND (a.merged_into IS NOT NULL
             OR EXISTS (SELECT 1 FROM follow_edge f WHERE f.account_id = a.id))`,
  ).get() as { c: number }).c;

  const warnings: string[] = [];

  if (snapshots === 0) {
    warnings.push(
      'No exports ingested yet. Request one in the Instagram app, then press ' +
      '"Pull new data" in the dashboard (or run: npm run auto).');
  } else {
    if (snapshots === 1) {
      warnings.push('Only one snapshot. Unfollower detection needs a second export to diff against.');
    }
    if (daysSinceExport !== null && daysSinceExport > STALE_DAYS) {
      warnings.push(
        `Last export was ${daysSinceExport} days ago. Request a fresh one to catch recent unfollowers.`);
    }
    if (captures === 0) {
      warnings.push('No inbound captures yet — who engages with you is unmeasured. See /bookmarklet.');
    }
    if (dmThreads > 0 && dmLinked < dmThreads) {
      warnings.push(
        `${dmThreads - dmLinked} of ${dmThreads} DM threads are not linked to a profile. ` +
        'Instagram names thread folders after display names, which the export omits — ' +
        'pull DM threads on the Data tab to name them exactly. A conversation the API no ' +
        'longer returns (deleted, or the account is gone) cannot be, and that is fine.');
    }
  }

  return {
    snapshots, lastExport, daysSinceExport, followers,
    accounts: n('account'), interactions: n('interaction'),
    impressions: n('impression'), activity: n('activity'), captures,
    dmThreads, dmLinked,
    unfollowers: (db.prepare(
      "SELECT COUNT(*) AS c FROM graph_event WHERE kind = 'lost_follower'",
    ).get() as { c: number }).c,
    warnings,
  };
}

export function formatStatus(s: Status): string {
  const date = (t: number | null) =>
    t === null ? 'never' : new Date(t * 1000).toISOString().slice(0, 10);
  const rows: [string, string][] = [
    ['snapshots', String(s.snapshots)],
    ['last export', `${date(s.lastExport)}${s.daysSinceExport === null ? '' : ` (${s.daysSinceExport}d ago)`}`],
    ['followers', s.followers === null ? '—' : String(s.followers)],
    ['unfollowers seen', String(s.unfollowers)],
    ['people known', String(s.accounts)],
    ['interactions', String(s.interactions)],
    ['posts seen', String(s.impressions)],
    ['unattributed acts', String(s.activity)],
    ['inbound captures', String(s.captures)],
    ['DM threads linked', `${s.dmLinked} of ${s.dmThreads}`],
  ];
  const out = rows.map(([k, v]) => `  ${k.padEnd(18)} ${v}`);
  if (s.warnings.length) out.push('', ...s.warnings.map((w) => `  ! ${w}`));
  return out.join('\n');
}
