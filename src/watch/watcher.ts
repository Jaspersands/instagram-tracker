import chokidar from 'chokidar';
import type { Db } from '../db/open.js';
import { ingestAndDerive } from '../ingest/pipeline.js';

/**
 * chokidar 4 removed glob support, so this watches the directory itself and
 * filters for .zip in the handler. Passing `dir/**\/*.zip` would silently
 * match nothing.
 */
export function watchFolder(
  db: Db,
  dir: string,
  onIngest: (r: { zipPath: string; lost: string[] }) => void,
): Promise<void> {
  const watcher = chokidar.watch(dir, {
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 200 },
  });

  watcher.on('add', async (zipPath: string) => {
    if (!zipPath.toLowerCase().endsWith('.zip')) return;
    try {
      const r = await ingestAndDerive(db, zipPath);
      if (!r.skipped) onIngest({ zipPath, lost: r.lost });
    } catch (err) {
      console.error(`failed to ingest ${zipPath}:`, err);
    }
  });

  return new Promise(() => {});   // runs until interrupted
}
