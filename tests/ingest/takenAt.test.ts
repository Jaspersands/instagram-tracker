import { describe, it, expect } from 'vitest';
import { takenAtFromPath } from '../../src/ingest/ingest.js';

const MTIME = 1_800_000_000;

describe('takenAtFromPath', () => {
  it('reads the date out of a real Instagram export filename', () => {
    // Instagram names archives like instagram-<user>-2026-09-08-<hash>.zip
    const t = takenAtFromPath('/Users/x/Downloads/instagram-jasper-2026-09-08-Xy7Qa.zip', MTIME);
    expect(new Date(t * 1000).toISOString().slice(0, 10)).toBe('2026-09-08');
  });

  it('falls back to mtime when the filename has no date', () => {
    expect(takenAtFromPath('/tmp/export.zip', MTIME)).toBe(MTIME);
  });

  it('ignores a nonsense date and falls back', () => {
    expect(takenAtFromPath('/tmp/instagram-9999-99-99.zip', MTIME)).toBe(MTIME);
  });

  it('does not pick a date out of the parent directory', () => {
    expect(takenAtFromPath('/backups/2020-01-01/export.zip', MTIME)).toBe(MTIME);
  });
});
