import { describe, it, expect } from 'vitest';
import { isExportArchive, isCaptureName, candidateDirs, newestFirst, configuredDirs } from '../../src/auto/discover.js';

describe('isExportArchive', () => {
  it('recognises the names Instagram and Meta actually use', () => {
    for (const n of [
      'instagram-jasper-2026-09-08-Xy7Qa.zip',
      'instagram-jaspersands-2026-01-02-abc123.zip',
      'meta-2026-09-08-abcdef.zip',
      'facebook-jasper-2026-09-08.zip',
    ]) expect(isExportArchive(n), n).toBe(true);
  });

  it('ignores unrelated archives so we never ingest someone else’s zip', () => {
    for (const n of ['KeeperImport.zip', 'Sands Residence.zip', 'photos.zip', 'notes.txt']) {
      expect(isExportArchive(n), n).toBe(false);
    }
  });
});

describe('isCaptureName', () => {
  it('matches bookmarklet output', () => {
    expect(isCaptureName('ig-capture-post_likes-1757000000.json')).toBe(true);
    expect(isCaptureName('ig-capture-story_viewers-1.json')).toBe(true);
  });
  it('ignores other json', () => {
    expect(isCaptureName('package.json')).toBe(false);
  });
});

describe('candidateDirs', () => {
  it('returns only directories that exist', () => {
    const isDir = (p: string) => p.includes('Downloads') || p.includes('GoogleDrive-');
    const dirs = candidateDirs('/home/j', isDir, ['GoogleDrive-me@x.com']);
    expect(dirs.some((d) => d.endsWith('/Downloads'))).toBe(true);
    expect(dirs.some((d) => d.includes('GoogleDrive-me@x.com'))).toBe(true);
    expect(dirs.some((d) => d.endsWith('/Dropbox'))).toBe(false);
  });

  it('skips dotfiles sitting in CloudStorage', () => {
    // .DS_Store lives in ~/Library/CloudStorage and is not a folder to watch.
    const dirs = candidateDirs('/home/j', () => true, ['.DS_Store', 'GoogleDrive-me@x.com']);
    expect(dirs.some((d) => d.endsWith('.DS_Store'))).toBe(false);
    expect(dirs.some((d) => d.includes('GoogleDrive-me@x.com'))).toBe(true);
  });

  it('never returns duplicates', () => {
    const dirs = candidateDirs('/home/j', () => true, []);
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('configuredDirs', () => {
  it('splits on colons and commas', () => {
    expect(configuredDirs({ IG_WATCH_DIRS: '/a:/b' })).toEqual(['/a', '/b']);
    expect(configuredDirs({ IG_WATCH_DIRS: '/a, /b' })).toEqual(['/a', '/b']);
  });
  it('returns null when unset or blank, so the defaults apply', () => {
    expect(configuredDirs({})).toBeNull();
    expect(configuredDirs({ IG_WATCH_DIRS: '   ' })).toBeNull();
  });
});

describe('newestFirst', () => {
  it('orders by mtime descending', () => {
    const files = [
      { path: 'a', mtime: 100 }, { path: 'b', mtime: 300 }, { path: 'c', mtime: 200 },
    ];
    expect(newestFirst(files).map((f) => f.path)).toEqual(['b', 'c', 'a']);
  });
});
