import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '../db/open.js';
import { parseArchive } from '../parse/parseArchive.js';
import { createDbSink } from './dbSink.js';

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

/**
 * Instagram names archives `instagram-<user>-YYYY-MM-DD-<hash>.zip`. That date is
 * far more trustworthy than the file mtime, which changes whenever the file is
 * copied or synced. Only the basename is searched, so a dated parent directory
 * cannot spoof it.
 */
export function takenAtFromPath(path: string, mtimeSeconds: number): number {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(basename(path));
  if (!m) return mtimeSeconds;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(ms) ? mtimeSeconds : Math.floor(ms / 1000);
}

export async function ingestArchive(
  db: Db,
  zipPath: string,
): Promise<{ snapshotId: number; skipped: boolean }> {
  const sha = await hashFile(zipPath);

  const existing = db.prepare('SELECT id FROM snapshot WHERE sha256 = ?').get(sha) as
    | { id: number } | undefined;
  if (existing) return { snapshotId: existing.id, skipped: true };

  const now = Math.floor(Date.now() / 1000);
  const takenAt = takenAtFromPath(zipPath, Math.floor(statSync(zipPath).mtimeMs / 1000));

  const snapshotId = Number(
    db.prepare(
      `INSERT INTO snapshot (taken_at, ingested_at, source, sha256, archive_path)
       VALUES (?, ?, 'export', ?, ?)`,
    ).run(takenAt, now, sha, zipPath).lastInsertRowid,
  );

  const sink = createDbSink(db, snapshotId);
  await parseArchive(zipPath, sink);
  sink.flush();

  db.prepare('UPDATE snapshot SET manifest_json = ? WHERE id = ?')
    .run(JSON.stringify(sink.files), snapshotId);

  return { snapshotId, skipped: false };
}
