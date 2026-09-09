import { basename } from 'node:path';
import type { Db } from '../db/open.js';
import { ingestAndDerive } from '../ingest/pipeline.js';
import { ingestCapture } from '../ingest/ingest.js';
import { candidateDirs, findInputs } from './discover.js';
import { localCopyOf, needsStaging } from './staging.js';
import { resolveIdentities, applyIdentities } from '../derive/identity.js';

export interface RefreshResult {
  scanned: string[];
  found: number;
  archives: { name: string; skipped: boolean; staged: boolean; gained: number; lost: string[] }[];
  captures: { name: string; skipped: boolean; rows: number }[];
  newUnfollowers: string[];
  linked: number;
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
    archives: [], captures: [], newUnfollowers: [], linked: 0,
  };

  for (const a of [...archives].reverse()) {
    // Cloud mounts are on-demand filesystems; copy locally before reading.
    const path = localCopyOf(a.path);
    const r = await ingestAndDerive(db, path);
    result.archives.push({
      name: basename(a.path), skipped: r.skipped, staged: needsStaging(a.path),
      gained: r.gained.length, lost: r.lost,
    });
    result.newUnfollowers.push(...r.lost);
  }

  for (const c of [...captures].reverse()) {
    const r = await ingestCapture(db, localCopyOf(c.path));
    result.captures.push({ name: basename(c.path), skipped: r.skipped, rows: r.rows });
  }

  // Display names captured just now may resolve DM threads ingested long ago.
  result.linked = applyIdentities(db, resolveIdentities(db));

  return result;
}
