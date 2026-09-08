import type { Db } from '../db/open.js';
import type {
  RowSink, FollowEdgeRow, ListRow, InteractionRow, ImpressionRow, FileRow,
} from '../parse/parseArchive.js';

export function accountId(db: Db, username: string): number {
  db.prepare('INSERT OR IGNORE INTO account (username) VALUES (?)').run(username);
  return (db.prepare('SELECT id FROM account WHERE username = ?').get(username) as { id: number }).id;
}

export function createDbSink(db: Db, snapshotId: number): RowSink & { flush(): void; files: FileRow[] } {
  const cache = new Map<string, number>();
  const id = (u: string) => {
    let v = cache.get(u);
    if (v === undefined) { v = accountId(db, u); cache.set(u, v); }
    return v;
  };

  const insEdge = db.prepare(
    `INSERT OR REPLACE INTO follow_edge (snapshot_id, account_id, direction, since)
     VALUES (?, ?, ?, ?)`);
  const insList = db.prepare(
    `INSERT OR IGNORE INTO list_membership (snapshot_id, account_id, list) VALUES (?, ?, ?)`);
  const insInter = db.prepare(
    `INSERT OR IGNORE INTO interaction (account_id, kind, direction, occurred_at, permalink, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?)`);
  const insImpr = db.prepare(
    `INSERT OR IGNORE INTO impression (account_id, kind, occurred_at, dedupe_key) VALUES (?, ?, ?, ?)`);

  const files: FileRow[] = [];

  return {
    files,
    followEdge(r: FollowEdgeRow) { insEdge.run(snapshotId, id(r.username), r.direction, r.since); },
    list(r: ListRow) { insList.run(snapshotId, id(r.username), r.list); },
    interaction(r: InteractionRow) {
      insInter.run(id(r.username), r.kind, r.direction, r.occurredAt, r.permalink,
        `${r.kind}|${r.username}|${r.occurredAt ?? ''}|${r.permalink ?? ''}`);
    },
    impression(r: ImpressionRow) {
      insImpr.run(id(r.username), r.kind, r.occurredAt,
        `${r.kind}|${r.username}|${r.occurredAt ?? ''}`);
    },
    file(r: FileRow) { files.push(r); },
    flush() { /* better-sqlite3 writes synchronously; nothing buffered */ },
  };
}
