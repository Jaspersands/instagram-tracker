import { readdirSync, statSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Instagram and Meta name their archives predictably. The pattern is deliberately
 * strict: this scans folders full of the user's unrelated downloads, and ingesting
 * a stranger's zip because it happened to be called export.zip would be worse than
 * missing one.
 */
export function isExportArchive(name: string): boolean {
  return /^(instagram|meta|facebook)[-_].*\.zip$/i.test(name);
}

export function isCaptureName(name: string): boolean {
  return /^ig-capture-.*\.json$/i.test(name);
}

/**
 * A transfer to Google Drive or Dropbox arrives as an unzipped folder tree, not
 * an archive — e.g. instagram-jasper_sands-2026-09-08-jBKMGcaq. The date is
 * required so an unrelated folder that merely starts with "instagram" is not
 * mistaken for an export.
 */
/** Output of likers.py — per-post liker lists, which no export contains. */
export function isLikersCsv(name: string): boolean {
  return /likers.*\.csv$/i.test(name) || /^all_instagram_likers\.csv$/i.test(name);
}

/** Any CSV pulled from the private API; the header decides which importer runs. */
export function isApiCsv(name: string): boolean {
  return /^(all_instagram_)?(likers|threads|comments|dm_threads|post_comments).*\.csv$/i.test(name);
}

export function isExportDir(name: string): boolean {
  if (!/^(instagram|meta|facebook)[-_]/i.test(name)) return false;
  // A ZIP download is dated 2026-09-08; a Drive transfer folder is dated
  // 2026-Sep-08. Both must match, and something with no date at all must not.
  return /\d{4}-(\d{2}|[A-Za-z]{3})-\d{2}/.test(name);
}

/**
 * An explicit override, colon- or comma-separated. Set IG_WATCH_DIRS when your
 * exports land somewhere unusual, or to narrow the scan to one folder.
 */
export function configuredDirs(env: NodeJS.ProcessEnv = process.env): string[] | null {
  const raw = env.IG_WATCH_DIRS;
  if (!raw || !raw.trim()) return null;
  const dirs = raw.split(/[:,]/).map((d) => d.trim()).filter(Boolean);
  return dirs.length ? dirs : null;
}

/** Where a download or a scheduled cloud transfer plausibly lands. */
function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function candidateDirs(
  home: string = homedir(),
  isDir: (p: string) => boolean = isDirectory,
  cloudStorageEntries?: string[],
): string[] {
  const override = configuredDirs();
  if (override) return override;

  const out: string[] = [];
  // Must be a directory, not merely present: ~/Library/CloudStorage contains a
  // .DS_Store file that would otherwise be handed to the watcher as a folder.
  const add = (p: string) => { if (!out.includes(p) && isDir(p)) out.push(p); };

  add(join(home, 'Downloads'));
  add(join(home, 'Dropbox'));
  add(join(home, 'Google Drive'));
  add(join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));

  const cloudRoot = join(home, 'Library', 'CloudStorage');
  const entries = cloudStorageEntries ?? (isDir(cloudRoot) ? safeReaddir(cloudRoot) : []);
  for (const e of entries) {
    if (e.startsWith('.')) continue;
    add(join(cloudRoot, e));
  }

  return out;
}

function safeReaddir(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

export interface Found { path: string; mtime: number }

export function newestFirst(files: Found[]): Found[] {
  return [...files].sort((a, b) => b.mtime - a.mtime);
}

function safeMtime(p: string): number {
  try { return statSync(p).mtimeMs; } catch { return 0; }
}

/**
 * Find exports (zip archives and unzipped folders) and bookmarklet captures.
 *
 * Uses withFileTypes so directory entries are classified from the single
 * readdir rather than a stat per entry, and only stats files whose names
 * already match. These folders include Google Drive's FUSE mount, where a stat
 * is a network round trip — the naive version took ~50 seconds.
 */
export function findInputs(dirs: string[] = candidateDirs()): {
  archives: Found[]; captures: Found[]; likers: Found[];
} {
  const archives: Found[] = [];
  const captures: Found[] = [];
  const likers: Found[] = [];

  const scan = (dir: string, depth: number) => {
    let entries: Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);

      if (e.isDirectory()) {
        if (isExportDir(e.name)) archives.push({ path: full, mtime: safeMtime(full) });
        else if (depth > 0) scan(full, depth - 1);
      } else if (e.isFile()) {
        if (isExportArchive(e.name)) archives.push({ path: full, mtime: safeMtime(full) });
        else if (isCaptureName(e.name)) captures.push({ path: full, mtime: safeMtime(full) });
        else if (isApiCsv(e.name)) likers.push({ path: full, mtime: safeMtime(full) });
      }
    }
  };

  for (const dir of dirs) scan(dir, 1);

  return {
    archives: newestFirst(archives),
    captures: newestFirst(captures),
    likers: newestFirst(likers),
  };
}
