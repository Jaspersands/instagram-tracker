import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { needsStaging, stageExport } from '../../src/auto/staging.js';

describe('needsStaging', () => {
  it('stages anything under a cloud mount, where every read is a network round trip', () => {
    const h = homedir();
    expect(needsStaging(join(h, 'Library/CloudStorage/GoogleDrive-me@x.com/My Drive/meta-2026-Sep-08'))).toBe(true);
    expect(needsStaging(join(h, 'Dropbox/meta-2026-Sep-08'))).toBe(true);
    expect(needsStaging(join(h, 'Library/Mobile Documents/com~apple~CloudDocs/meta-2026-Sep-08'))).toBe(true);
  });

  it('leaves a local folder alone', () => {
    expect(needsStaging(join(homedir(), 'Downloads/meta-2026-Sep-08'))).toBe(false);
    expect(needsStaging('/tmp/meta-2026-Sep-08')).toBe(false);
  });
});

describe('stageExport', () => {
  function fakeExport() {
    const root = mkdtempSync(join(tmpdir(), 'src-'));
    const w = (rel: string, body: string) => {
      const p = join(root, rel);
      mkdirSync(join(p, '..'), { recursive: true });
      writeFileSync(p, body);
    };
    w('connections/followers_and_following/followers_1.json', '{"a":[1]}');
    w('your_instagram_activity/likes/liked_posts.json', '{"b":[2]}');
    w('media/posts/photo1.jpg', 'x'.repeat(5000));
    w('media/reels/clip.mp4', 'y'.repeat(9000));
    // DM attachments live under the activity tree, not media/ — this is what a
    // media/-only denylist missed, and it is where the gigabytes actually are.
    w('your_instagram_activity/messages/inbox/liv_825076/photos/958489.jpg', 'z'.repeat(7000));
    w('your_instagram_activity/messages/inbox/liv_825076/videos/745102.mp4', 'v'.repeat(9000));
    w('your_instagram_activity/messages/inbox/liv_825076/videos/1736911616781971', 'n'.repeat(9000));
    w('your_instagram_activity/messages/inbox/liv_825076/message_1.json', '{"c":[3]}');
    return root;
  }

  it('copies every JSON and nothing else', () => {
    const src = fakeExport();
    const cache = mkdtempSync(join(tmpdir(), 'cache-'));
    const staged = stageExport(src, cache);

    expect(existsSync(join(staged, 'connections/followers_and_following/followers_1.json'))).toBe(true);
    expect(readFileSync(join(staged, 'your_instagram_activity/likes/liked_posts.json'), 'utf8')).toBe('{"b":[2]}');
    // DM thread JSON must survive even though its sibling attachments do not.
    expect(existsSync(join(staged, 'your_instagram_activity/messages/inbox/liv_825076/message_1.json'))).toBe(true);
  });

  it('skips media wherever it lives, including DM attachments', () => {
    const staged = stageExport(fakeExport(), mkdtempSync(join(tmpdir(), 'cache-')));
    for (const skipped of [
      'media/posts/photo1.jpg',
      'media/reels/clip.mp4',
      'your_instagram_activity/messages/inbox/liv_825076/photos/958489.jpg',
      'your_instagram_activity/messages/inbox/liv_825076/videos/745102.mp4',
      // No extension at all — an extension denylist would have copied this one.
      'your_instagram_activity/messages/inbox/liv_825076/videos/1736911616781971',
    ]) {
      expect(existsSync(join(staged, skipped)), `${skipped} must not be copied`).toBe(false);
    }
  });

  it('is idempotent — staging twice reuses the same folder', () => {
    const src = fakeExport();
    const cache = mkdtempSync(join(tmpdir(), 'cache-'));
    expect(stageExport(src, cache)).toBe(stageExport(src, cache));
  });

  it('keeps the export name so snapshot dating still works', () => {
    const src = mkdtempSync(join(tmpdir(), 'meta-2026-Sep-08-18-57-05-'));
    writeFileSync(join(src, 'x.json'), '{}');
    const staged = stageExport(src, mkdtempSync(join(tmpdir(), 'cache-')));
    expect(staged).toContain('meta-2026-Sep-08-18-57-05');
  });
});
