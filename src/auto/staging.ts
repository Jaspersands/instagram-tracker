import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, sep } from 'node:path';

/**
 * Only JSON is copied. Every datum this tool reads comes from a .json file, and
 * an export is mostly media: photos and videos under media/, and — easy to miss —
 * DM attachments under your_instagram_activity/messages/inbox/<thread>/photos
 * and /videos. A denylist of directory names missed those and pulled 200MB of
 * MP4s; an extension denylist would still have copied the attachments that have
 * no extension at all. An allowlist of one is the only version that holds.
 */
export const COPIED_EXTENSIONS = ['.json'];

const CLOUD_MARKERS = [
  join('Library', 'CloudStorage') + sep,
  join('Library', 'Mobile Documents') + sep,
  sep + 'Dropbox' + sep,
  sep + 'Google Drive' + sep,
];

/**
 * True when the path lives on a cloud-sync mount. Those are on-demand
 * filesystems: reading 837 small JSON files cost ten and a half minutes here,
 * because each cold read is a network fetch. Copying once locally makes every
 * subsequent pass instant.
 */
export function needsStaging(path: string): boolean {
  return CLOUD_MARKERS.some((m) => path.includes(m));
}

/**
 * Copy an export into a local cache, minus media. Returns the staged path.
 * Idempotent: an already-staged export is reused rather than re-copied.
 */
export function stageExport(srcDir: string, cacheRoot: string): string {
  const name = basename(srcDir);
  const dest = join(cacheRoot, name);

  if (existsSync(dest)) return dest;

  mkdirSync(cacheRoot, { recursive: true });
  cpSync(srcDir, dest, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(srcDir.length + 1);
      if (!rel) return true;
      if (rel.split(sep).some((p) => p.startsWith('.'))) return false;

      // Descend into directories; copy only JSON files.
      let isDir = false;
      try { isDir = statSync(src).isDirectory(); } catch { return false; }
      return isDir || COPIED_EXTENSIONS.some((e) => src.toLowerCase().endsWith(e));
    },
  });

  return dest;
}

export const STAGE_ROOT = 'data/staged';

/**
 * Return a locally-readable path for an export, copying it out of a cloud mount
 * first if needed. A no-op for anything already local.
 */
export function localCopyOf(path: string, cacheRoot: string = STAGE_ROOT): string {
  if (!needsStaging(path)) return path;

  let isDir = false;
  try { isDir = statSync(path).isDirectory(); } catch { return path; }

  if (isDir) return stageExport(path, cacheRoot);

  // A zip is a single read, but still worth pulling local once.
  const dest = join(cacheRoot, basename(path));
  if (existsSync(dest)) return dest;
  mkdirSync(cacheRoot, { recursive: true });
  copyFileSync(path, dest);
  return dest;
}
