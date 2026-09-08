import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from '../db/open.js';
import { people, overview, decay, habits, taste, person } from '../report/queries.js';
import { unfollowers, lurkGap } from '../report/reports.js';

const here = dirname(fileURLToPath(import.meta.url));
const now = () => Math.floor(Date.now() / 1000);

export function buildServer(db: Db): FastifyInstance {
  const app = Fastify({ logger: false });

  app.get('/', (_req, reply) => {
    reply.type('text/html; charset=utf-8')
      .send(readFileSync(join(here, 'public', 'index.html'), 'utf8'));
  });

  app.get('/api/overview', () => overview(db));
  app.get('/api/people', () => people(db, now()));
  app.get('/api/unfollowers', () => unfollowers(db, now()));
  app.get('/api/lurkers', () => lurkGap(db, 200));
  app.get('/api/habits', () => habits(db));
  app.get('/api/taste', () => taste(db));

  app.get('/api/decay', (req) => {
    const days = Number((req.query as { days?: string }).days ?? 90);
    return decay(db, now(), Number.isFinite(days) ? days : 90);
  });

  app.get('/api/person/:username', (req) =>
    person(db, (req.params as { username: string }).username, now()));

  return app;
}
