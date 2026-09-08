import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { buildServer } from '../../src/server/server.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { makeZip } from '../helpers/makeZip.js';

const sld = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });

describe('buildServer', () => {
  it('serves every API route on an empty database without crashing', async () => {
    const app = buildServer(openDb(':memory:'));
    for (const route of [
      '/api/overview', '/api/people', '/api/unfollowers',
      '/api/lurkers', '/api/decay', '/api/habits', '/api/taste',
    ]) {
      const res = await app.inject({ method: 'GET', url: route });
      expect(res.statusCode, `${route} status`).toBe(200);
      expect(() => JSON.parse(res.body), `${route} json`).not.toThrow();
    }
    await app.close();
  });

  it('serves the dashboard HTML at /', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>');
    await app.close();
  });

  it('returns a null row for an unknown person rather than a 404', async () => {
    const app = buildServer(openDb(':memory:'));
    const res = await app.inject({ method: 'GET', url: '/api/person/nobody' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).row).toBeNull();
    await app.close();
  });

  it('returns real data once a snapshot is ingested', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, makeZip({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [sld('alice', 100), sld('bob', 200)],
      },
    }));
    const app = buildServer(db);
    const people = JSON.parse((await app.inject({ url: '/api/people' })).body);
    expect(people.map((p: any) => p.username).sort()).toEqual(['alice', 'bob']);
    const ov = JSON.parse((await app.inject({ url: '/api/overview' })).body);
    expect(ov.snapshots[0].followers).toBe(2);
    await app.close();
  });
});
