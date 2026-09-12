import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { renderSite, publish } from '../../src/publish/publish.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { makeDir } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const sld = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

async function db() {
  const d = openDb(':memory:');
  await ingestAndDerive(d, makeDir({
    'connections/followers_and_following/followers_1.json': {
      relationships_followers: [sld('zartheticpanther', 100), sld('quibblesnort_vex', 200)],
    },
  }));
  return d;
}

describe('renderSite', () => {
  it('writes a self-contained page with the payload inlined', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pub-'));
    renderSite(await db(), NOW, out, 'someone/repo');
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).toContain('const D = {');
    expect(html).not.toContain('__PAYLOAD__');
    expect(html).not.toContain('__REPO__');
    expect(html).toContain('someone/repo');
    // No sibling JSON to fetch means no second URL to index or scrape alone.
    expect(existsSync(join(out, 'api'))).toBe(false);
    expect(existsSync(join(out, '.nojekyll'))).toBe(true);
  });

  it('names nobody', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pub-'));
    renderSite(await db(), NOW, out, 'someone/repo');
    const html = readFileSync(join(out, 'index.html'), 'utf8');
    expect(html).not.toContain('zartheticpanther');
    expect(html).not.toContain('quibblesnort_vex');
  });

  it('clears a previous build, including the retired demo files', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pub-'));
    mkdirSync(join(out, 'api'), { recursive: true });
    writeFileSync(join(out, 'api', 'people.json'), '["leftover"]');
    writeFileSync(join(out, 'demo-config.js'), 'window.DEMO_PIN="2021";');
    renderSite(await db(), NOW, out, null);
    expect(existsSync(join(out, 'api', 'people.json'))).toBe(false);
    expect(existsSync(join(out, 'demo-config.js'))).toBe(false);
  });
});

describe('publish', () => {
  it('builds without pushing when asked not to', async () => {
    const out = mkdtempSync(join(tmpdir(), 'pub-'));
    const r = publish(await db(), NOW, { outDir: out, push: false });
    expect(r).toMatchObject({ wrote: true, pushed: false });
    expect(existsSync(join(out, 'index.html'))).toBe(true);
  });

  it('reports rather than throws, so a publish problem cannot fail an ingest', async () => {
    // An unwritable path: the ingest that triggered this must still succeed.
    const r = publish(await db(), NOW, { outDir: '/dev/null/nope', push: false });
    expect(r.wrote).toBe(false);
    expect(r.reason).toMatch(/render failed/);
  });
});
