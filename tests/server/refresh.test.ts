import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { buildServer } from '../../src/server/server.js';

// Without this the refresh route scans the real Downloads and Google Drive
// folders — a FUSE network mount that made this test take ~50 seconds.
const prev = process.env.IG_WATCH_DIRS;
beforeAll(() => { process.env.IG_WATCH_DIRS = mkdtempSync(join(tmpdir(), 'empty-')); });
afterAll(() => {
  if (prev === undefined) delete process.env.IG_WATCH_DIRS;
  else process.env.IG_WATCH_DIRS = prev;
});

describe('POST /api/refresh', () => {
  it('returns a result and current status even when nothing is found', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ method: 'POST', url: '/api/refresh' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(Array.isArray(body.archives)).toBe(true);
    expect(Array.isArray(body.scanned)).toBe(true);
    expect(body.status).toBeDefined();
    expect(body.status.snapshots).toBe(0);
    await app.close();
  });

  it('exposes status on its own route too', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ url: '/api/status' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).warnings.length).toBeGreaterThan(0);
    await app.close();
  });
});
