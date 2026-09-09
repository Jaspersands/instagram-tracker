import { createHash } from 'node:crypto';
import { createReadStream, statSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
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
 * Idempotency key for an export. A zip is hashed by content; an unzipped folder
 * has no single file to hash, so it is hashed over its sorted manifest of
 * relative paths and sizes — deterministic, and it never reads file contents
 * (these trees live on a network-backed Drive mount).
 */
export async function fingerprintExport(path: string): Promise<string> {
  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch { isDir = false; }
  if (!isDir) return hashFile(path);

  const lines: string[] = [];
  const walk = (dir: string, prefix: string) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, rel);
      else if (e.isFile()) {
        try { lines.push(`${rel}\0${statSync(full).size}`); } catch { /* skip */ }
      }
    }
  };
  walk(path, '');

  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/**
 * Instagram names archives `instagram-<user>-YYYY-MM-DD-<hash>.zip`. That date is
 * far more trustworthy than the file mtime, which changes whenever the file is
 * copied or synced. Only the basename is searched, so a dated parent directory
 * cannot spoof it.
 */
const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * The account owner, read from the export folder name
 * (instagram-<username>-2026-09-08-<hash>). Comments on your own posts list you
 * as the Media Owner, so without this you appear in your own People table as
 * the person you comment at most.
 */
export function ownerFromPath(path: string): string | null {
  for (const seg of path.split('/')) {
    const m = /^instagram-([A-Za-z0-9._]+)-\d{4}-\d{2}-\d{2}/.exec(seg);
    if (m) return m[1].toLowerCase();
  }
  return null;
}

export function takenAtFromPath(path: string, mtimeSeconds: number): number {
  // Two shapes in the wild: instagram-user-2026-09-08-hash.zip (device
  // download) and meta-2026-Sep-08-18-57-05 (cloud transfer folder).
  const m = /(\d{4})-(\d{2}|[A-Za-z]{3})-(\d{2})/.exec(basename(path));
  if (!m) return mtimeSeconds;

  const month = /^\d{2}$/.test(m[2]) ? m[2] : MONTHS[m[2].toLowerCase()];
  if (!month) return mtimeSeconds;

  const ms = Date.parse(`${m[1]}-${month}-${m[3]}T00:00:00Z`);
  return Number.isNaN(ms) ? mtimeSeconds : Math.floor(ms / 1000);
}

export async function ingestArchive(
  db: Db,
  zipPath: string,
): Promise<{ snapshotId: number; skipped: boolean }> {
  const sha = await fingerprintExport(zipPath);

  const existing = db.prepare('SELECT id FROM snapshot WHERE sha256 = ?').get(sha) as
    | { id: number } | undefined;
  if (existing) return { snapshotId: existing.id, skipped: true };

  const now = Math.floor(Date.now() / 1000);
  const takenAt = takenAtFromPath(zipPath, Math.floor(statSync(zipPath).mtimeMs / 1000));

  const snapshotId = Number(
    db.prepare(
      `INSERT INTO snapshot (taken_at, ingested_at, source, sha256, archive_path, owner)
       VALUES (?, ?, 'export', ?, ?, ?)`,
    ).run(takenAt, now, sha, zipPath, ownerFromPath(zipPath)).lastInsertRowid,
  );

  const sink = createDbSink(db, snapshotId);
  await parseArchive(zipPath, sink);
  sink.flush();

  // A cloud transfer nests the real export inside a meta-<date> wrapper, so the
  // owner is not in the path we were handed — it is in the paths inside it.
  const owner = ownerFromPath(zipPath)
    ?? sink.files.map((f) => ownerFromPath(f.path)).find((o) => o) ?? null;

  db.prepare('UPDATE snapshot SET manifest_json = ?, owner = COALESCE(owner, ?) WHERE id = ?')
    .run(JSON.stringify(sink.files), owner, snapshotId);

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
