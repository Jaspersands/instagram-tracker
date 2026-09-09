import { describe, it, expect } from 'vitest';
import { mkdtempSync, copyFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { refreshAll } from '../../src/auto/refresh.js';
import { makeZip } from '../helpers/makeZip.js';

const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

function folderWith(users1: string[], users2?: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'refresh-'));
  const a = makeZip({
    'connections/followers_and_following/followers_1.json':
      { relationships_followers: users1.map((u, i) => f(u, 100 + i)) },
  });
  copyFileSync(a, join(dir, 'instagram-jasper-2026-06-14-aaa.zip'));
  if (users2) {
    const b = makeZip({
      'connections/followers_and_following/followers_1.json':
        { relationships_followers: users2.map((u, i) => f(u, 100 + i)) },
    });
    copyFileSync(b, join(dir, 'instagram-jasper-2026-09-05-bbb.zip'));
  }
  // Unrelated files that must be left alone.
  writeFileSync(join(dir, 'KeeperImport.zip'), 'not an export');
  writeFileSync(join(dir, 'notes.txt'), 'hello');
  return dir;
}

describe('refreshAll', () => {
  it('reports finding nothing on an empty folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-'));
    const r = await refreshAll(openDb(':memory:'), [dir]);
    expect(r.found).toBe(0);
    expect(r.archives).toEqual([]);
  });

  it('ingests exports oldest-first so the diff runs in order', async () => {
    const db = openDb(':memory:');
    const r = await refreshAll(db, [folderWith(['alice', 'bob'], ['alice'])]);

    expect(r.archives.map((a) => a.name)).toEqual([
      'instagram-jasper-2026-06-14-aaa.zip',
      'instagram-jasper-2026-09-05-bbb.zip',
    ]);
    // bob only reads as an unfollower if the older snapshot went in first.
    expect(r.archives[1].lost).toEqual(['bob']);
    expect(r.newUnfollowers).toEqual(['bob']);
  });

  it('ignores unrelated zips and files', async () => {
    const r = await refreshAll(openDb(':memory:'), [folderWith(['alice'])]);
    expect(r.archives).toHaveLength(1);
    expect(r.archives.every((a) => !a.name.includes('Keeper'))).toBe(true);
  });

  it('is a no-op the second time, so the button is safe to mash', async () => {
    const db = openDb(':memory:');
    const dir = folderWith(['alice', 'bob'], ['alice']);
    await refreshAll(db, [dir]);
    const second = await refreshAll(db, [dir]);

    expect(second.archives.every((a) => a.skipped)).toBe(true);
    expect(second.newUnfollowers).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) c FROM snapshot').get() as any).c).toBe(2);
  });

  it('picks up bookmarklet captures too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'refresh-'));
    writeFileSync(join(dir, 'ig-capture-post_likes-1.json'), JSON.stringify({
      v: 1, kind: 'post_likes', permalink: 'https://ig/p/A/', capturedAt: 1757000000,
      items: [{ username: 'fan1' }, { username: 'fan2' }],
    }));
    const r = await refreshAll(openDb(':memory:'), [dir]);
    expect(r.captures).toHaveLength(1);
    expect(r.captures[0].rows).toBe(2);
  });
});
