import { basename } from 'node:path';
import type { Db } from '../db/open.js';
import { ingestAndDerive } from '../ingest/pipeline.js';
import { ingestCapture } from '../ingest/ingest.js';
import { candidateDirs, findInputs } from './discover.js';

export interface RefreshResult {
  scanned: string[];
  found: number;
  archives: { name: string; skipped: boolean; gained: number; lost: string[] }[];
  captures: { name: string; skipped: boolean; rows: number }[];
  newUnfollowers: string[];
}

/**
 * Scan the usual folders and ingest anything new. Shared by the `auto` command
 * and the dashboard's Refresh button so both behave identically.
 *
 * Archives go in oldest-first: a snapshot is only meaningful when diffed against
 * the one before it, so ingesting newest-first would report the wrong changes.
 */
export async function refreshAll(db: Db, dirs?: string[]): Promise<RefreshResult> {
  const scanned = dirs ?? candidateDirs();
  const { archives, captures } = findInputs(scanned);

  const result: RefreshResult = {
    scanned, found: archives.length + captures.length,
    archives: [], captures: [], newUnfollowers: [],
  };

  for (const a of [...archives].reverse()) {
    const r = await ingestAndDerive(db, a.path);
    result.archives.push({
      name: basename(a.path), skipped: r.skipped,
      gained: r.gained.length, lost: r.lost,
    });
    result.newUnfollowers.push(...r.lost);
  }

  for (const c of [...captures].reverse()) {
    const r = await ingestCapture(db, c.path);
    result.captures.push({ name: basename(c.path), skipped: r.skipped, rows: r.rows });
  }

  return result;
}
