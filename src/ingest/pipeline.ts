import type { Db } from '../db/open.js';
import { ingestArchive } from './ingest.js';
import { diffFollowState, loadFollowState, previousSnapshotId } from '../derive/diff.js';
import { detectRenames, applyRenames } from '../derive/rename.js';
import { recordEvents } from '../derive/events.js';

export async function ingestAndDerive(db: Db, zipPath: string) {
  const { snapshotId, skipped } = await ingestArchive(db, zipPath);
  if (skipped) return { snapshotId, skipped, lost: [] as string[], gained: [] as string[] };

  const prevId = previousSnapshotId(db, snapshotId);
  if (prevId === null) return { snapshotId, skipped, lost: [] as string[], gained: [] as string[] };

  const prev = loadFollowState(db, prevId);
  const next = loadFollowState(db, snapshotId);

  const raw = diffFollowState(prev, next);
  const renames = detectRenames(raw, prev, next);
  const diff = applyRenames(raw, renames);

  recordEvents(db, snapshotId, diff, renames);

  return { snapshotId, skipped, lost: diff.lostFollowers, gained: diff.gainedFollowers };
}
