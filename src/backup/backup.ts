import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from '../db/open.js';

/**
 * Snapshot the database to a dated file, keeping the most recent few.
 *
 * This matters more than it looks. An Instagram export is a point-in-time
 * picture: if the database is lost, the follower history it accumulated cannot
 * be recovered, because Instagram will only ever hand you *today's* list again.
 * The DMs are irreplaceable for the same reason.
 *
 * Uses VACUUM INTO rather than copying the file. A plain copy while the write
 * ahead log holds uncommitted pages produces a torn backup that looks fine
 * until you try to open it.
 */
const PREFIX = 'instagram-';
const SUFFIX = '.db';

export interface BackupResult {
  path: string | null;
  pruned: string[];
  reason: string;
}

export function backupDb(
  db: Db,
  dir = 'data/backups',
  keep = 5,
  now: Date = new Date(),
): BackupResult {
  try {
    mkdirSync(dir, { recursive: true });
    const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const path = join(dir, `${PREFIX}${stamp}${SUFFIX}`);
    if (existsSync(path)) return { path, pruned: [], reason: 'already backed up this second' };

    // VACUUM INTO takes a consistent snapshot and compacts it at the same time.
    db.prepare('VACUUM INTO ?').run(path);
    return { path, pruned: prune(dir, keep), reason: 'ok' };
  } catch (err) {
    // Never throw: a failed backup must not take down the ingest that asked
    // for it. The data is still in the live database.
    return { path: null, pruned: [], reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Drop all but the newest `keep` backups. */
export function prune(dir: string, keep: number): string[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX));
  } catch {
    return [];
  }
  // Filenames are ISO timestamps, so lexical order is chronological.
  const doomed = names.sort().reverse().slice(Math.max(0, keep));
  const gone: string[] = [];
  for (const n of doomed) {
    try { unlinkSync(join(dir, n)); gone.push(n); } catch { /* leave it */ }
  }
  return gone;
}

export function listBackups(dir = 'data/backups'): { name: string; size: number; at: Date }[] {
  try {
    return readdirSync(dir)
      .filter((n) => n.startsWith(PREFIX) && n.endsWith(SUFFIX))
      .sort().reverse()
      .map((name) => {
        const s = statSync(join(dir, name));
        return { name, size: s.size, at: s.mtime };
      });
  } catch {
    return [];
  }
}
