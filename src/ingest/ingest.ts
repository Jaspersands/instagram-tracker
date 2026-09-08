import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { parseArchive } from '../parse/parseArchive.js';
import { createDbSink } from './dbSink.js';

export async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
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
  const takenAt = Math.floor(statSync(zipPath).mtimeMs / 1000);

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
