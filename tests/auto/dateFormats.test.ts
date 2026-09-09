import { describe, it, expect } from 'vitest';
import { isExportDir } from '../../src/auto/discover.js';
import { takenAtFromPath } from '../../src/ingest/ingest.js';

const MTIME = 1_800_000_000;
const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);

describe('isExportDir', () => {
  it('matches the ZIP-download naming (numeric month)', () => {
    expect(isExportDir('instagram-jasper_sands-2026-09-08-jBKMGcaq')).toBe(true);
  });

  it('matches the Drive-transfer naming (month NAME)', () => {
    // Meta names a cloud transfer differently from a device download.
    expect(isExportDir('meta-2026-Sep-08-18-57-05')).toBe(true);
    expect(isExportDir('meta-2026-Dec-31-23-59-59')).toBe(true);
  });

  it('still refuses folders with no date at all', () => {
    expect(isExportDir('instagram photos')).toBe(false);
    expect(isExportDir('instagram-backup')).toBe(false);
    expect(isExportDir('Sands Residence')).toBe(false);
    expect(isExportDir('metadata')).toBe(false);
  });
});

describe('takenAtFromPath', () => {
  it('reads a numeric date', () => {
    expect(day(takenAtFromPath('/x/instagram-j-2026-09-08-abc.zip', MTIME))).toBe('2026-09-08');
  });

  it('reads a month-name date from a Drive transfer folder', () => {
    expect(day(takenAtFromPath('/x/meta-2026-Sep-08-18-57-05', MTIME))).toBe('2026-09-08');
    expect(day(takenAtFromPath('/x/meta-2026-Jan-01-00-00-00', MTIME))).toBe('2026-01-01');
    expect(day(takenAtFromPath('/x/meta-2025-Dec-25-12-00-00', MTIME))).toBe('2025-12-25');
  });

  it('falls back to mtime when there is no date or the month is nonsense', () => {
    expect(takenAtFromPath('/x/export.zip', MTIME)).toBe(MTIME);
    expect(takenAtFromPath('/x/meta-2026-Xyz-08', MTIME)).toBe(MTIME);
  });
});
