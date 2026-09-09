import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from '../db/open.js';
import { people, overview, decay, habits, taste, person, inbound } from '../report/queries.js';
import { unfollowers, lurkGap } from '../report/reports.js';
import { status } from '../report/status.js';
import { refreshAll } from '../auto/refresh.js';
import { notify, unfollowerMessage } from '../notify/notify.js';

const here = dirname(fileURLToPath(import.meta.url));
const now = () => Math.floor(Date.now() / 1000);

export function buildServer(db: Db): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/', (_req, reply) => {
    reply.type('text/html; charset=utf-8')
      .send(readFileSync(join(here, 'public', 'index.html'), 'utf8'));
  });

  // The bookmarklet URL is built at request time from capture.js, so editing
  // the script updates the bookmarklet with no build step.
  app.get('/bookmarklet', (_req, reply) => {
    const js = readFileSync(join(here, 'public', 'capture.js'), 'utf8');
    const url = 'javascript:' + encodeURIComponent(js + '\nvoid 0;');
    const page = readFileSync(join(here, 'public', 'bookmarklet.html'), 'utf8')
      .replace('__BOOKMARKLET__', url.replace(/"/g, '&quot;'));
    reply.type('text/html; charset=utf-8').send(page);
  });

  app.get('/capture.js', (_req, reply) => {
    reply.type('application/javascript; charset=utf-8')
      .send(readFileSync(join(here, 'public', 'capture.js'), 'utf8'));
  });

  app.get('/api/overview', () => overview(db));
  app.get('/api/people', () => people(db, now()));
  app.get('/api/unfollowers', () => unfollowers(db, now()));
  app.get('/api/lurkers', () => lurkGap(db, 200));
  app.get('/api/habits', () => habits(db));
  app.get('/api/taste', () => taste(db));
  app.get('/api/inbound', () => inbound(db, now()));
  app.get('/api/status', () => status(db, now()));

  // Pull new data on demand. POST because it mutates; same-origin only, and the
  // server is bound to loopback.
  app.post('/api/refresh', async () => {
    const r = await refreshAll(db);
    const msg = unfollowerMessage(r.newUnfollowers);
    if (msg) notify('Instagram Tracker', msg);
    return { ...r, status: status(db, now()) };
  });

  app.get('/api/decay', (req) => {
    const days = Number((req.query as { days?: string }).days ?? 90);
    return decay(db, now(), Number.isFinite(days) ? days : 90);
  });

  app.get('/api/person/:username', (req) =>
    person(db, (req.params as { username: string }).username, now()));

  return app;
}
