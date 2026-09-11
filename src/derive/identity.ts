import type { Db } from '../db/open.js';
import { isTombstone } from './tombstone.js';

/**
 * Instagram names a DM thread folder after the counterpart's *display name*,
 * lowercased with non-alphanumerics stripped: "Marcus" becomes marcus,
 * "Harriet Vale" becomes harrietvale. The export contains no display names
 * at all, so a thread only joins to the follow graph by accident — when the
 * normalized display name happens to equal the username.
 *
 * Given display names captured from a follower/following list, the same
 * normalization reproduces the folder name exactly, which turns the join from
 * guesswork into an equality test.
 */
export function normalizeDisplayName(name: string): string {
  return name
    .normalize('NFD')                 // split accents off their base letters
    .replace(/[\u0300-\u036f]/g, '')  // ...and drop the accents, keeping the letter
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface ResolvedIdentity {
  threadUsername: string;   // the placeholder account made from the folder name
  realUsername: string;     // the account it actually refers to
  displayName: string;
  confidence: number;
}

/**
 * Link DM-thread placeholder accounts to the real accounts they refer to.
 *
 * Only unambiguous matches are linked: if two people share a normalized display
 * name, neither is merged. A wrong merge silently attributes one person's
 * private messages to another, which is far worse than leaving a thread
 * unresolved.
 */
export function resolveIdentities(db: Db): ResolvedIdentity[] {
  const named = db.prepare(
    `SELECT username, display_name AS displayName FROM account
      WHERE display_name IS NOT NULL AND display_name <> '' AND merged_into IS NULL`,
  ).all() as { username: string; displayName: string }[];

  // normalized display name -> candidate usernames
  const byNormalized = new Map<string, { username: string; displayName: string }[]>();
  for (const a of named) {
    const key = normalizeDisplayName(a.displayName);
    if (!key) continue;
    const list = byNormalized.get(key) ?? [];
    list.push(a);
    byNormalized.set(key, list);
  }

  // Accounts known only from a DM thread: they have dm rows but no follow edge
  // and no display name of their own.
  const orphans = db.prepare(
    `SELECT a.id AS id, a.username AS username FROM account a
      WHERE a.merged_into IS NULL
        AND a.display_name IS NULL
        AND EXISTS (SELECT 1 FROM interaction i WHERE i.account_id = a.id AND i.kind = 'dm')`,
  ).all() as { id: number; username: string }[];

  const out: ResolvedIdentity[] = [];

  for (const o of orphans) {
    // "Instagram User" is a deleted account, not a person; 99 dead threads
    // share the name and none of them is anyone in the follow graph.
    if (isTombstone(o.username)) continue;
    const candidates = byNormalized.get(o.username);
    if (!candidates || candidates.length !== 1) continue;      // absent or ambiguous
    const match = candidates[0];
    if (match.username === o.username) continue;               // already the same account
    out.push({
      threadUsername: o.username,
      realUsername: match.username,
      displayName: match.displayName,
      confidence: 1,
    });
  }

  return out;
}

/** Point each placeholder at the real account so every query follows the merge. */
export function applyIdentities(db: Db, resolved: ResolvedIdentity[]): number {
  const link = db.prepare(
    `UPDATE account SET merged_into = (SELECT id FROM account WHERE username = ?)
      WHERE username = ?`);
  db.transaction(() => {
    for (const r of resolved) link.run(r.realUsername, r.threadUsername);
  })();
  return resolved.length;
}
