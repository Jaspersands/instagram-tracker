import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { fingerprintExport } from '../../src/ingest/ingest.js';
import { findInputs, isExportDir } from '../../src/auto/discover.js';
import { unfollowers } from '../../src/report/reports.js';
import { people } from '../../src/report/queries.js';
import { makeDir } from '../helpers/makeZip.js';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

const NOW = 1_800_000_000;
const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

describe('isExportDir', () => {
  it('matches how Meta names a transfer folder', () => {
    expect(isExportDir('instagram-jasper_sands-2026-09-08-jBKMGcaq')).toBe(true);
    expect(isExportDir('meta-2026-01-02-abc')).toBe(true);
  });
  it('requires a date, so an unrelated folder is not mistaken for an export', () => {
    expect(isExportDir('instagram photos')).toBe(false);
    expect(isExportDir('instagram-backup')).toBe(false);
    expect(isExportDir('Sands Residence')).toBe(false);
  });
});

describe('ingesting an unzipped export folder', () => {
  it('loads followers, following and activity exactly as a zip would', async () => {
    const db = openDb(':memory:');
    const dir = makeDir({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [f('alice', 100), f('bob', 200)] },
      'connections/followers_and_following/following.json':
        { relationships_following: [f('bob', 50)] },
      'your_instagram_activity/likes/liked_posts.json': {
        likes_media_likes: [
          { title: 'bob', string_list_data: [{ href: 'p1', value: '❤', timestamp: NOW - 3600 }] },
        ],
      },
    });

    const r = await ingestAndDerive(db, dir);
    expect(r.skipped).toBe(false);

    const rows = people(db, NOW);
    const bob = rows.find((p) => p.username === 'bob')!;
    expect(bob.followsMe).toBe(true);
    expect(bob.iFollow).toBe(true);
    expect(bob.likes).toBe(1);
  });

  it('is idempotent — re-ingesting the same folder changes nothing', async () => {
    const db = openDb(':memory:');
    const dir = makeDir({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [f('alice', 100)] },
    });
    await ingestAndDerive(db, dir);
    const second = await ingestAndDerive(db, dir);
    expect(second.skipped).toBe(true);
    expect((db.prepare('SELECT COUNT(*) c FROM snapshot').get() as any).c).toBe(1);
  });

  it('detects unfollowers across two folder exports', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeDir({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [f('alice', 100), f('bob', 200)] },
    }));
    const r = await ingestAndDerive(db, makeDir({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [f('alice', 100)] },
    }));
    expect(r.lost).toEqual(['bob']);
    expect(unfollowers(db, NOW).map((u) => u.username)).toEqual(['bob']);
  });

  it('fingerprints a folder by manifest, and notices when a file changes', async () => {
    const a = makeDir({ 'x/one.json': { a: [1] } });
    const first = await fingerprintExport(a);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await fingerprintExport(a)).toBe(first);          // stable

    writeFileSync(join(a, 'x', 'one.json'), JSON.stringify({ a: [1, 2, 3] }));
    expect(await fingerprintExport(a)).not.toBe(first);      // size changed
  });
});

describe('findInputs', () => {
  it('finds an unzipped export folder sitting in a watched directory', () => {
    const watched = mkdtempSync(join(tmpdir(), 'watched-'));
    const exportDir = makeDir({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: [f('alice', 100)] },
    });
    cpSync(exportDir, join(watched, 'instagram-jasper_sands-2026-09-08-jBKMGcaq'),
      { recursive: true });
    // An unrelated folder that must be ignored.
    mkdirSync(join(watched, 'Sands Residence'), { recursive: true });

    const { archives } = findInputs([watched]);
    expect(archives).toHaveLength(1);
    expect(archives[0].path).toContain('instagram-jasper_sands-2026-09-08');
  });
});
