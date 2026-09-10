import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Db } from '../db/open.js';
import { people, overview, decay, habits, taste, person, inbound, postCount } from '../report/queries.js';
import { unfollowers, lurkGap } from '../report/reports.js';
import { status } from '../report/status.js';
import { refreshAll } from '../auto/refresh.js';
import { notify, unfollowerMessage } from '../notify/notify.js';
import { runner, ActivePullError, isPullJob, PULL_JOBS, JOB_INFO, type PullJob } from '../scrape/run.js';
import { preflight } from '../scrape/python.js';
import { isLocalOrigin } from './origin.js';

const here = dirname(fileURLToPath(import.meta.url));
const now = () => Math.floor(Date.now() / 1000);

export function buildServer(db: Db): FastifyInstance {
  const app = Fastify({ logger: false });

  // Reject cross-origin writes. See origin.ts — loopback binding is not enough
  // on its own, and one of these routes now carries a credential.
  app.addHook('onRequest', (req, reply, done) => {
    if (req.method === 'GET' || req.method === 'HEAD') return done();
    if (!isLocalOrigin(req.headers.origin)) {
      reply.code(403).send({ error: 'Cross-origin request refused.' });
      return;
    }
    done();
  });

  // Read from disk per request and tell the browser not to keep a copy: the
  // dashboard is edited far more often than it is loaded, and a cached shell
  // silently shows old code against a new API.
  app.get('/', (_req, reply) => {
    reply.type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
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
      .header('cache-control', 'no-store')
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

  // ---- pull straight from Instagram's private API ----
  // The session id arrives in the POST body over loopback, is handed to the
  // child process on stdin, and is never stored, logged or echoed back.
  app.get('/api/pull', () => {
    const pre = preflight();
    return {
      ready: pre.ok,
      python: pre.python,
      problem: pre.problem,
      fix: pre.fix,
      jobs: PULL_JOBS.map((j) => ({ id: j, ...JOB_INFO[j] })),
      posts: postCount(db),
      run: runner.latest(),
      busy: runner.activeRun()?.id ?? null,
    };
  });

  app.get('/api/pull/:id', (req, reply) => {
    const run = runner.get((req.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'No such run.' });
    return run;
  });

  app.post('/api/pull', (req, reply) => {
    const body = (req.body ?? {}) as { sessionid?: unknown; jobs?: unknown };
    const jobs = Array.isArray(body.jobs) ? body.jobs.filter(isPullJob) as PullJob[] : [];
    const sessionid = typeof body.sessionid === 'string' ? body.sessionid : '';

    if (!jobs.length) return reply.code(400).send({ error: 'Pick at least one thing to pull.' });
    if (!sessionid.trim()) return reply.code(400).send({ error: 'A session id is required.' });

    try {
      return runner.start(db, { sessionid, jobs });
    } catch (err) {
      if (err instanceof ActivePullError) {
        return reply.code(409).send({ error: err.message, runId: err.runId });
      }
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/pull/:id/cancel', (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!runner.cancel(id)) return reply.code(409).send({ error: 'That run is not active.' });
    return { cancelling: id };
  });

  app.get('/api/person/:username', (req) =>
    person(db, (req.params as { username: string }).username, now()));

  return app;
}
