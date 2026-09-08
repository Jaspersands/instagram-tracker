import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/** Build a real .zip on disk from a map of path -> JSON value. */
export function makeZip(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'igfix-'));
  const root = join(dir, 'src');
  mkdirSync(root, { recursive: true });
  for (const [rel, value] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, typeof value === 'string' ? value : JSON.stringify(value));
  }
  const zipPath = join(dir, 'export.zip');
  execFileSync('zip', ['-q', '-r', zipPath, '.'], { cwd: root });
  return zipPath;
}
