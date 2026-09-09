import { readdirSync, statSync } from 'node:fs';
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

/** Where a download or a scheduled cloud transfer plausibly lands. */
function isDirectory(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export function candidateDirs(
  home: string = homedir(),
  isDir: (p: string) => boolean = isDirectory,
  cloudStorageEntries?: string[],
): string[] {
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

/**
 * Find exports and captures across the candidate directories. Scans one level
 * deep as well, since cloud transfers often land inside a dated subfolder.
 */
export function findInputs(dirs: string[] = candidateDirs()): {
  archives: Found[]; captures: Found[];
} {
  const archives: Found[] = [];
  const captures: Found[] = [];

  const consider = (full: string, name: string) => {
    try {
      const st = statSync(full);
      if (!st.isFile()) return;
      if (isExportArchive(name)) archives.push({ path: full, mtime: st.mtimeMs });
      else if (isCaptureName(name)) captures.push({ path: full, mtime: st.mtimeMs });
    } catch { /* unreadable entry */ }
  };

  for (const dir of dirs) {
    for (const name of safeReaddir(dir)) {
      const full = join(dir, name);
      consider(full, name);
      try {
        if (statSync(full).isDirectory()) {
          for (const inner of safeReaddir(full)) consider(join(full, inner), inner);
        }
      } catch { /* unreadable entry */ }
    }
  }

  return { archives: newestFirst(archives), captures: newestFirst(captures) };
}
