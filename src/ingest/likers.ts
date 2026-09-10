import { readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { parseCsv } from '../parse/csv.js';
import { accountId } from './dbSink.js';

export interface LikersImport {
  posts: number;
  people: number;
  likeEvents: number;
  displayNames: number;
  instagramIds: number;
  completePosts: number;
  partialPosts: number;
}

/** Columns produced by likers.py (instagrapi media_likers). */
const REQUIRED = ['post_shortcode', 'post_date', 'post_url', 'like_count', 'username'];

export function isLikersCsv(text: string): boolean {
  const firstLine = text.slice(0, 400).split('\n')[0] ?? '';
  return REQUIRED.every((c) => firstLine.includes(c));
}

/**
 * Import per-post liker lists.
 *
 * Each post becomes one capture, marked complete only when the retrieved list
 * reaches the like count Instagram itself reported — a short list means
 * deactivated or blocked accounts, and its absences must not be read as
 * evidence that someone never engaged.
 *
 * Like timestamps do not exist in this data, so events are dated to the post.
 * That is a proxy, but a defensible one: engagement clusters within days of
 * posting, and it keeps the activity timeline honest at month resolution.
 */
export function importLikersCsv(db: Db, filePath: string): LikersImport {
  const rows = parseCsv(readFileSync(filePath, 'utf8'));

  const byPost = new Map<string, Record<string, string>[]>();
  for (const r of rows) {
    if (!r.username || !r.post_shortcode) continue;
    const list = byPost.get(r.post_shortcode) ?? [];
    list.push(r);
    byPost.set(r.post_shortcode, list);
  }

  const insCapture = db.prepare(
    `INSERT INTO inbound_capture (captured_at, kind, permalink, complete, expected, raw_json)
     VALUES (?, 'post_likes', ?, ?, ?, ?)`);
  const insInter = db.prepare(
    `INSERT OR IGNORE INTO interaction
       (account_id, kind, direction, occurred_at, permalink, text, dedupe_key)
     VALUES (?, 'like_received', 'in', ?, ?, NULL, ?)`);
  const setMeta = db.prepare(
    `UPDATE account SET display_name = COALESCE(?, display_name),
                        instagram_id = COALESCE(?, instagram_id)
      WHERE id = ?`);
  const insPost = db.prepare(
    `INSERT INTO my_post (posted_at, caption, media_type, permalink, like_count, dedupe_key)
     VALUES (?, NULL, 'post', ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET like_count = excluded.like_count,
                                           permalink  = excluded.permalink`);

  const stats: LikersImport = {
    posts: byPost.size, people: 0, likeEvents: 0,
    displayNames: 0, instagramIds: 0, completePosts: 0, partialPosts: 0,
  };
  const people = new Set<string>();
  const cache = new Map<string, number>();

  db.transaction(() => {
    for (const [shortcode, list] of byPost) {
      const first = list[0];
      const claimed = Number(first.like_count) || 0;
      const postedAt = Math.floor(Date.parse(first.post_date.replace(' ', 'T') + 'Z') / 1000) || null;
      // A handful short means deactivated accounts, not a truncated fetch.
      const complete = claimed === 0 ? true : list.length >= claimed * 0.97;
      if (complete) stats.completePosts++; else stats.partialPosts++;

      insCapture.run(postedAt ?? 0, first.post_url || null, complete ? 1 : 0, claimed,
        JSON.stringify({ source: 'likers.py', shortcode, retrieved: list.length, claimed }));

      insPost.run(postedAt, first.post_url || null, claimed, `post|${shortcode}`);

      for (const r of list) {
        const username = r.username.trim().toLowerCase();
        if (!username) continue;
        people.add(username);

        let id = cache.get(username);
        if (id === undefined) { id = accountId(db, username); cache.set(username, id); }

        const name = r.full_name?.trim() || null;
        const igId = r.user_id?.trim() || null;
        if (name || igId) {
          setMeta.run(name, igId, id);
          if (name) stats.displayNames++;
          if (igId) stats.instagramIds++;
        }

        // Same key shape the bookmarklet uses, so the two never double-count.
        const changes = insInter.run(id, postedAt, r.post_url || null,
          `like_received|${username}|${r.post_url || ''}`).changes;
        stats.likeEvents += changes;
      }
    }
  })();

  stats.people = people.size;
  return stats;
}
