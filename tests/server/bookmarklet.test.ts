import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db/open.js';
import { buildServer } from '../../src/server/server.js';

const SRC = readFileSync('src/server/public/capture.js', 'utf8');

/** Strip block and line comments so the safety checks test code, not prose. */
const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('capture.js safety contract', () => {
  it('makes no network requests', () => {
    // This is the property that separates reading a page you scrolled from
    // session automation. If it ever fails, the bookmarklet is no longer safe.
    for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /\bWebSocket\b/, /\bimport\s*\(/,
                           /sendBeacon/, /\.src\s*=/]) {
      expect(code, `must not contain ${pattern}`).not.toMatch(pattern);
    }
  });

  it('never scrolls the page for you', () => {
    for (const pattern of [/scrollTo\s*\(/, /scrollBy\s*\(/, /scrollIntoView\s*\(/,
                           /\.scrollTop\s*=/]) {
      expect(code, `must not contain ${pattern}`).not.toMatch(pattern);
    }
  });

  it('does observe the DOM, which is how it works at all', () => {
    expect(code).toMatch(/MutationObserver/);
  });

  it('never calls innerText, which forces a synchronous layout', () => {
    // A MutationObserver calling innerText on a page that mutates as often as
    // Instagram is a reflow storm — it froze the tab outright. Text is read
    // with a TreeWalker instead.
    expect(code).not.toMatch(/\.innerText/);
    expect(code).toMatch(/createTreeWalker/);
  });

  it('coalesces mutations instead of scanning on every one', () => {
    // Instagram fires mutations in bursts; one scan each meant thousands per
    // second. The observer must schedule rather than scan directly.
    expect(code).toMatch(/new MutationObserver\(schedule\)/);
    expect(code).toMatch(/pending/);
  });

  it('skips rows it has already fully captured', () => {
    expect(code).toMatch(/if \(prev && prev\.name/);
  });
});

describe('/bookmarklet', () => {
  it('serves a page whose link decodes back to the source', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ url: '/bookmarklet' });
    expect(res.statusCode).toBe(200);

    const m = /href="javascript:([^"]+)"/.exec(res.body);
    expect(m, 'bookmarklet href present').not.toBeNull();

    const decoded = decodeURIComponent(m![1].replace(/&quot;/g, '"'));
    expect(decoded).toContain('MutationObserver');
    expect(decoded).toContain('__igTrackerCapture');
    expect(res.body).not.toContain('__BOOKMARKLET__');   // placeholder was replaced
    await app.close();
  });

  it('serves the raw script too', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ url: '/capture.js' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('javascript');
    await app.close();
  });
});
