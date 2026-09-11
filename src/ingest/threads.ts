import { readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { parseCsv } from '../parse/csv.js';
import { accountId } from './dbSink.js';
import { isTombstone } from '../derive/tombstone.js';

/**
 * Expected columns, from instagrapi's direct_threads():
 *   thread_id,thread_title,is_group,username,full_name,user_id
 *
 * One row per participant per thread (excluding yourself). This is the exact
 * fix for DM attribution: the export names a thread folder
 * <normalised display name>_<thread id>, and this file reports the same thread
 * id next to the real username — so the join is an equality test, not a guess.
 */
const REQUIRED = ['thread_id', 'username'];

export function isThreadsCsv(text: string): boolean {
  const first = text.slice(0, 400).split('\n')[0] ?? '';
  return REQUIRED.every((c) => first.includes(c)) && !first.includes('post_shortcode');
}

export interface ThreadsImport {
  threads: number;
  linked: number;
  unmatched: number;
  displayNames: number;
  groupsSkipped: number;
  /** DM rows moved from a display-name placeholder onto the real account. */
  messagesMoved: number;
  /** Messages left on a shared placeholder because nothing says which thread they came from. */
  ambiguous: number;
  tombstones: number;
}

export function importThreadsCsv(db: Db, filePath: string): ThreadsImport {
  const rows = parseCsv(readFileSync(filePath, 'utf8'));
  const stats: ThreadsImport = {
    threads: 0, linked: 0, unmatched: 0, displayNames: 0, groupsSkipped: 0,
    messagesMoved: 0, ambiguous: 0, tombstones: 0,
  };

  const findThread = db.prepare(
    'SELECT thread_id, placeholder, account_id FROM dm_thread WHERE thread_id = ?');
  const setMeta = db.prepare(
    `UPDATE account SET display_name = COALESCE(?, display_name),
                        instagram_id = COALESCE(?, instagram_id)
      WHERE id = ?`);
  const linkThread = db.prepare('UPDATE dm_thread SET account_id = ? WHERE thread_id = ?');
  const mergeAccount = db.prepare('UPDATE account SET merged_into = ? WHERE id = ? AND id <> ?');
  // How many folders share this placeholder's display name. One means the
  // placeholder *is* this person; more means it is a blend that can only be
  // split message by message, using the thread id stamped on each row.
  const foldersNamed = db.prepare(
    'SELECT COUNT(*) AS c FROM dm_thread WHERE placeholder = ?');
  const moveThread = db.prepare(
    'UPDATE interaction SET account_id = ? WHERE thread_id = ? AND account_id = ?');
  const moveAll = db.prepare(
    "UPDATE interaction SET account_id = ? WHERE account_id = ? AND kind = 'dm'");
  const leftBehind = db.prepare(
    "SELECT COUNT(*) AS c FROM interaction WHERE account_id = ? AND kind = 'dm' AND thread_id IS NULL");

  // A group thread has several participants; its messages belong to no single
  // person, and merging a placeholder into one of them would be a fabrication.
  const perThread = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    if (!r.thread_id || !r.username) continue;
    const list = perThread.get(r.thread_id) ?? [];
    list.push(r);
    perThread.set(r.thread_id, list);
  }

  db.transaction(() => {
    for (const [threadId, participants] of perThread) {
      stats.threads++;

      const isGroup = participants.length > 1
        || participants.some((p) => /^(true|1|yes)$/i.test(p.is_group ?? ''));
      if (isGroup) { stats.groupsSkipped++; continue; }

      const p = participants[0];
      const username = p.username.trim().toLowerCase();
      if (isTombstone(username)) { stats.tombstones++; continue; }
      const realId = accountId(db, username);

      const name = p.full_name?.trim() || null;
      const igId = p.user_id?.trim() || null;
      if (name || igId) {
        setMeta.run(name, igId, realId);
        if (name) stats.displayNames++;
      }

      const thread = findThread.get(threadId) as
        { thread_id: string; placeholder: string; account_id: number | null } | undefined;

      if (!thread) { stats.unmatched++; continue; }

      linkThread.run(realId, threadId);
      const holder = thread.account_id;
      if (holder === null || holder === realId) continue;

      stats.linked++;
      const shared = (foldersNamed.get(thread.placeholder) as { c: number }).c > 1;
      if (!shared) {
        // The folder name belongs to exactly one person, so every message on
        // the placeholder is theirs — including any the backfill could not
        // stamp — and the placeholder can collapse into them entirely.
        stats.messagesMoved += moveAll.run(realId, holder).changes;
        mergeAccount.run(realId, holder, realId);
      } else {
        // Two people share this display name. Move only the messages that
        // carry this thread's id; merging the whole placeholder would hand
        // one Sophie the other Sophie's conversation.
        stats.messagesMoved += moveThread.run(realId, threadId, holder).changes;
        stats.ambiguous = (leftBehind.get(holder) as { c: number }).c;
      }
    }
  })();

  return stats;
}
