import { createHash } from 'node:crypto';
import { createReadStream, statSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Db } from '../db/open.js';
import { parseArchive } from '../parse/parseArchive.js';
import { createDbSink, accountId } from './dbSink.js';
import { parseCapture, CAPTURE_KIND_MAP } from '../parse/capture.js';

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

/**
 * Ingest a bookmarklet capture. The DOM carries no per-like timestamp, so the
 * dedupe key is kind|username|permalink: re-capturing one post is a no-op, but
 * the same person liking two different posts counts twice.
 */
export async function ingestCapture(
  db: Db,
  filePath: string,
): Promise<{ captureId: number; rows: number; skipped: boolean }> {
  let parsed = null;
  try {
    parsed = parseCapture(JSON.parse(readFileSync(filePath, 'utf8')));
  } catch {
    parsed = null;
  }
  if (!parsed) return { captureId: -1, rows: 0, skipped: true };

  const captureId = Number(
    db.prepare(
      `INSERT INTO inbound_capture (captured_at, kind, permalink, raw_json)
       VALUES (?, ?, ?, ?)`,
    ).run(parsed.capturedAt, parsed.kind, parsed.permalink,
          readFileSync(filePath, 'utf8')).lastInsertRowid,
  );

  const kind = CAPTURE_KIND_MAP[parsed.kind];
  const ins = db.prepare(
    `INSERT OR IGNORE INTO interaction
       (account_id, kind, direction, occurred_at, permalink, text, dedupe_key)
     VALUES (?, ?, 'in', ?, ?, ?, ?)`);

  let rows = 0;
  db.transaction(() => {
    for (const it of parsed!.items) {
      const r = ins.run(accountId(db, it.username), kind, parsed!.capturedAt,
        parsed!.permalink, it.text,
        `${kind}|${it.username}|${parsed!.permalink ?? ''}`);
      rows += r.changes;
    }
  })();

  return { captureId, rows, skipped: false };
}
