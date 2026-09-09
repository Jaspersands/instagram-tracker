import chokidar from 'chokidar';
import type { Db } from '../db/open.js';
import { ingestAndDerive } from '../ingest/pipeline.js';
import { ingestCapture } from '../ingest/ingest.js';
import { isCaptureFile } from '../parse/capture.js';
import { isExportArchive, isExportDir } from '../auto/discover.js';
import { resolveIdentities, applyIdentities } from '../derive/identity.js';

/**
 * chokidar 4 removed glob support, so this watches the directory itself and
 * filters for .zip in the handler. Passing `dir/**\/*.zip` would silently
 * match nothing.
 */
export function watchFolder(
  db: Db,
  dirs: string | string[],
  onIngest: (r: { zipPath: string; lost: string[]; captured?: number; linked?: number }) => void,
): Promise<void> {
  const watcher = chokidar.watch(Array.isArray(dirs) ? dirs : [dirs], {
    ignoreInitial: false,
    // Downloads folders are large and deep. Exports land at the top level, or one
    // level down inside a dated folder for a scheduled cloud transfer — watching
    // an 11GB tree recursively would burn file handles for nothing.
    depth: 2,
    // Skip dotfiles and the package trees that dominate a Downloads folder.
    ignored: (p: string) => /(^|\/)\.[^/]|\/node_modules\//.test(p),
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on('add', async (zipPath: string) => {
    if (isCaptureFile(zipPath)) {
      try {
        const c = await ingestCapture(db, zipPath);
        // Display names just captured may resolve threads ingested long ago —
        // the whole point of a profile_list capture.
        const linked = applyIdentities(db, resolveIdentities(db));
        if (!c.skipped) onIngest({ zipPath, lost: [], captured: c.rows, linked });
      } catch (err) {
        console.error(`failed to ingest capture ${zipPath}:`, err);
      }
      return;
    }
    // Must be an Instagram export, not merely a zip. A watched Downloads folder
    // is full of unrelated archives, and ingesting one reports every follower
    // as having unfollowed you.
    const name = zipPath.split('/').pop() ?? '';
    if (!isExportArchive(name) && !isExportDir(name)) return;
    try {
      const r = await ingestAndDerive(db, zipPath);
      if (!r.skipped) onIngest({ zipPath, lost: r.lost });
    } catch (err) {
      console.error(`failed to ingest ${zipPath}:`, err);
    }
  });

  return new Promise(() => {});   // runs until interrupted
}
