import { readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { parseCsv } from '../parse/csv.js';
import { accountId } from './dbSink.js';

/**
 * Expected columns, from instagrapi's media_comments():
 *   post_shortcode,post_url,post_date,comment_id,created_at,username,full_name,user_id,text
 *
 * Comments received are absent from the export at every account tier — the
 * export carries comments you left on other people's posts, never the reverse.
 * Unlike likes, these carry a real per-comment timestamp.
 */
const REQUIRED = ['post_shortcode', 'username', 'text'];

export function isCommentsCsv(text: string): boolean {
  const first = text.slice(0, 400).split('\n')[0] ?? '';
  return REQUIRED.every((c) => first.includes(c)) && first.includes('comment_id');
}

export interface CommentsImport {
  posts: number;
  comments: number;
  people: number;
  withTimestamps: number;
}

function toEpoch(v: string | undefined): number | null {
  if (!v) return null;
  const n = Number(v);
  // Accept a unix timestamp (seconds or ms) or an ISO-ish date string.
  if (Number.isFinite(n) && n > 1e8) return Math.floor(n > 1e12 ? n / 1000 : n);
  const ms = Date.parse(v.includes('T') ? v : v.replace(' ', 'T') + 'Z');
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

export function importCommentsCsv(db: Db, filePath: string): CommentsImport {
  const rows = parseCsv(readFileSync(filePath, 'utf8'));
  const stats: CommentsImport = { posts: 0, comments: 0, people: 0, withTimestamps: 0 };

  const insInter = db.prepare(
    `INSERT OR IGNORE INTO interaction
       (account_id, kind, direction, occurred_at, permalink, text, dedupe_key)
     VALUES (?, 'comment_received', 'in', ?, ?, ?, ?)`);
  const setMeta = db.prepare(
    `UPDATE account SET display_name = COALESCE(?, display_name),
                        instagram_id = COALESCE(?, instagram_id)
      WHERE id = ?`);

  const posts = new Set<string>();
  const people = new Set<string>();
  const cache = new Map<string, number>();

  db.transaction(() => {
    for (const r of rows) {
      const username = (r.username || '').trim().toLowerCase();
      if (!username || !r.post_shortcode) continue;

      posts.add(r.post_shortcode);
      people.add(username);

      let id = cache.get(username);
      if (id === undefined) { id = accountId(db, username); cache.set(username, id); }

      const name = r.full_name?.trim() || null;
      const igId = r.user_id?.trim() || null;
      if (name || igId) setMeta.run(name, igId, id);

      const at = toEpoch(r.created_at) ?? toEpoch(r.post_date);
      if (toEpoch(r.created_at) !== null) stats.withTimestamps++;

      // comment_id is unique per comment, so two identical texts from the same
      // person on the same post are still two comments.
      const key = `comment_received|${username}|${r.comment_id || `${r.post_shortcode}|${at ?? ''}|${(r.text || '').slice(0, 60)}`}`;
      stats.comments += insInter.run(id, at, r.post_url || null, r.text || null, key).changes;
    }
  })();

  stats.posts = posts.size;
  stats.people = people.size;
  return stats;
}
