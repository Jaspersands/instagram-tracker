import { createHash } from 'node:crypto';
import type { Db } from '../db/open.js';
import type {
  RowSink, FollowEdgeRow, ListRow, InteractionRow, ImpressionRow, FileRow,
  ActivityRow,
  DmThreadRow,
} from '../parse/parseArchive.js';
import type { TopicRow, SearchRow, MyPostRow } from '../parse/maps.js';

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
    `INSERT OR IGNORE INTO interaction
       (account_id, kind, direction, occurred_at, permalink, text, dedupe_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const insImpr = db.prepare(
    `INSERT OR IGNORE INTO impression (account_id, kind, occurred_at, dedupe_key) VALUES (?, ?, ?, ?)`);

  const insTopic = db.prepare(
    'INSERT OR IGNORE INTO topic (snapshot_id, kind, value) VALUES (?, ?, ?)');
  const insSearch = db.prepare(
    'INSERT OR IGNORE INTO search_event (term, occurred_at, dedupe_key) VALUES (?, ?, ?)');
  const insPost = db.prepare(
    `INSERT OR IGNORE INTO my_post (posted_at, caption, media_type, dedupe_key)
     VALUES (?, ?, ?, ?)`);

  const insActivity = db.prepare(
    `INSERT OR IGNORE INTO activity (kind, occurred_at, permalink, dedupe_key)
     VALUES (?, ?, ?, ?)`);

  const insThread = db.prepare(
    `INSERT INTO dm_thread (thread_id, folder_name, placeholder, account_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET folder_name = excluded.folder_name,
                                          placeholder = excluded.placeholder`);

  const files: FileRow[] = [];

  return {
    files,
    followEdge(r: FollowEdgeRow) { insEdge.run(snapshotId, id(r.username), r.direction, r.since); },
    list(r: ListRow) { insList.run(snapshotId, id(r.username), r.list); },
    interaction(r: InteractionRow) {
      // DM timestamps are truncated from ms to seconds, so a bursty exchange
      // puts several distinct messages in the same second. Without the text in
      // the key the whole burst collapses to one row. Hashed to keep the index
      // small.
      const textKey = r.text
        ? createHash('sha1').update(r.text).digest('hex').slice(0, 12)
        : '';
      insInter.run(id(r.username), r.kind, r.direction, r.occurredAt, r.permalink, r.text,
        `${r.kind}|${r.username}|${r.occurredAt ?? ''}|${r.permalink ?? ''}|${textKey}`);
    },
    impression(r: ImpressionRow) {
      insImpr.run(id(r.username), r.kind, r.occurredAt,
        `${r.kind}|${r.username}|${r.occurredAt ?? ''}`);
    },
    topic(r: TopicRow) { insTopic.run(snapshotId, r.kind, r.value); },
    search(r: SearchRow) { insSearch.run(r.term, r.occurredAt, `${r.term}|${r.occurredAt ?? ''}`); },
    post(r: MyPostRow) {
      // Stories mostly have empty captions; without the uri, any two posted in
      // the same second collapse into one.
      insPost.run(r.postedAt, r.caption, r.mediaType,
        `${r.postedAt ?? ''}|${r.uri ?? ''}|${(r.caption ?? '').slice(0, 80)}`);
    },
    dmThread(r: DmThreadRow) {
      insThread.run(r.threadId, r.folderName, r.placeholder, id(r.placeholder));
    },
    activity(r: ActivityRow) {
      insActivity.run(r.kind, r.occurredAt, r.permalink,
        `${r.kind}|${r.occurredAt ?? ''}|${r.permalink ?? ''}`);
    },
    file(r: FileRow) { files.push(r); },
    flush() { /* better-sqlite3 writes synchronously; nothing buffered */ },
  };
}
