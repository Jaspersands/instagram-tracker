import { existsSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { eachJsonEntry } from '../archive/reader.js';
import { isMessageFile, parseMessageThread } from '../parse/messages.js';
import type { RowSink, InteractionRow, DmThreadRow } from '../parse/parseArchive.js';
import { accountId, interactionKey } from './dbSink.js';

export interface ThreadBackfill { threads: number; messages: number }

/**
 * Whether any DM is still missing its thread id. True for every database that
 * ingested an export before the column existed, and false after one backfill.
 */
export function needsThreadBackfill(db: Db): boolean {
  const r = db.prepare(
    "SELECT COUNT(*) AS c FROM interaction WHERE kind = 'dm' AND thread_id IS NULL",
  ).get() as { c: number };
  return r.c > 0;
}

/**
 * Register the DM threads of an export that was ingested before dm_thread and
 * interaction.thread_id existed.
 *
 * Ingest is idempotent by archive fingerprint, so a table added later stays
 * empty for every export already seen — and the direct_threads import, which
 * joins on thread id, silently links nothing. This re-parses only the message
 * files (a few hundred small JSONs, not the 90-second archive), upserts each
 * thread, and stamps each message with its thread by matching the same dedupe
 * key the original ingest wrote. Nothing is inserted twice.
 */
export async function backfillThreads(db: Db, archivePath: string): Promise<ThreadBackfill> {
  const threads: DmThreadRow[] = [];
  const messages: InteractionRow[] = [];

  const noop = () => {};
  const collector: RowSink = {
    dmThread(r) { threads.push(r); },
    interaction(r) { if (r.threadId) messages.push(r); },
    followEdge: noop, list: noop, impression: noop, topic: noop,
    search: noop, post: noop, activity: noop, file: noop,
  };

  await eachJsonEntry(archivePath, async (src) => {
    if (!isMessageFile(src.path)) return;   // skip without reading the file
    parseMessageThread(await src.raw(), collector);
  });

  const upThread = db.prepare(
    `INSERT INTO dm_thread (thread_id, folder_name, placeholder, account_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET folder_name = excluded.folder_name,
                                          placeholder = excluded.placeholder`);
  const stamp = db.prepare(
    'UPDATE interaction SET thread_id = ? WHERE dedupe_key = ? AND thread_id IS NULL');

  const result: ThreadBackfill = { threads: 0, messages: 0 };
  db.transaction(() => {
    for (const t of threads) {
      upThread.run(t.threadId, t.folderName, t.placeholder, accountId(db, t.placeholder));
      result.threads++;
    }
    for (const m of messages) {
      result.messages += stamp.run(m.threadId, interactionKey(m)).changes;
    }
  })();
  return result;
}

/** Backfill every export the database still has a copy of. */
export async function backfillAllThreads(db: Db): Promise<ThreadBackfill & { archives: number; missing: string[] }> {
  const rows = db.prepare(
    'SELECT archive_path AS path FROM snapshot WHERE archive_path IS NOT NULL ORDER BY id',
  ).all() as { path: string }[];

  const out = { threads: 0, messages: 0, archives: 0, missing: [] as string[] };
  for (const { path } of rows) {
    if (!existsSync(path)) { out.missing.push(path); continue; }
    const r = await backfillThreads(db, path);
    out.threads += r.threads;
    out.messages += r.messages;
    out.archives++;
  }
  return out;
}
