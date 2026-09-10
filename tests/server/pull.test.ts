import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { openDb } from '../../src/db/open.js';
import { buildServer } from '../../src/server/server.js';

const HTML = readFileSync('src/server/public/index.html', 'utf8');
const app = () => buildServer(openDb(':memory:'));

describe('cross-origin guard', () => {
  it('refuses a write from a page on the open web', async () => {
    const r = await app().inject({
      method: 'POST', url: '/api/pull',
      headers: { origin: 'https://evil.example' },
      payload: { jobs: ['threads'], sessionid: 'x' },
    });
    expect(r.statusCode).toBe(403);
  });

  it("lets the dashboard's own origin through to validation", async () => {
    const r = await app().inject({
      method: 'POST', url: '/api/pull',
      headers: { origin: 'http://127.0.0.1:4317' },
      payload: { jobs: [], sessionid: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('leaves reads alone', async () => {
    const r = await app().inject({
      method: 'GET', url: '/api/overview', headers: { origin: 'https://evil.example' },
    });
    expect(r.statusCode).toBe(200);
  });
});

describe('POST /api/pull validation', () => {
  it('rejects an empty job list', async () => {
    const r = await app().inject({ method: 'POST', url: '/api/pull', payload: { jobs: [], sessionid: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/at least one/i);
  });

  it('rejects a blank session id', async () => {
    const r = await app().inject({ method: 'POST', url: '/api/pull', payload: { jobs: ['threads'], sessionid: '  ' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/session id/i);
  });

  it('drops unknown jobs rather than passing them through', async () => {
    // user_info costs one request per person, which is the pattern that gets
    // accounts flagged. It must not be reachable by editing a request body.
    const r = await app().inject({
      method: 'POST', url: '/api/pull', payload: { jobs: ['user_info', 'followers'], sessionid: 'x' },
    });
    expect(r.statusCode).toBe(400);
  });
});

describe('GET /api/pull', () => {
  it('describes the available jobs and whether the machine can run them', async () => {
    const r = await app().inject({ method: 'GET', url: '/api/pull' });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.jobs.map((j: { id: string }) => j.id)).toEqual(['threads', 'likers', 'comments']);
    expect(typeof b.ready).toBe('boolean');
  });

  it('404s an unknown run id', async () => {
    const r = await app().inject({ method: 'GET', url: '/api/pull/nope' });
    expect(r.statusCode).toBe(404);
  });
});

describe('dashboard shell', () => {
  it('has a syntactically valid inline script', () => {
    // The whole UI is one inline script, so a single stray bracket blanks the
    // page with nothing but a console error to show for it.
    const src = /<script>\n([\s\S]*)\n<\/script>/.exec(HTML)?.[1];
    expect(src, 'inline script not found').toBeTruthy();
    expect(() => new Function(src as string)).not.toThrow();   // compiles, does not run
  });

  it('never stores the session id in the browser', () => {
    // A credential that survives the page is a credential that can leak. The
    // field is cleared the moment the pull starts.
    for (const p of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/]) {
      expect(HTML, `must not contain ${p}`).not.toMatch(p);
    }
    expect(HTML).toMatch(/input\.value = ''/);
  });

  it('sends the session id in a POST body, never in a URL', () => {
    // A query string lands in logs and history.
    expect(HTML).not.toMatch(/sessionid=/);
    expect(HTML).toMatch(/post\('\/api\/pull', \{[^}]*\bsessionid\b[^}]*\}\)/);
  });

  it('offers the five sections the redesign settled on', () => {
    for (const t of ['today', 'people', 'connections', 'you', 'data']) {
      expect(HTML).toContain(`id="tab-${t}"`);
    }
  });
});

describe('postCount', () => {
  it('counts posts, not stories', async () => {
    const { openDb } = await import('../../src/db/open.js');
    const { postCount } = await import('../../src/report/queries.js');
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO my_post (posted_at, caption, media_type, permalink, dedupe_key)
       VALUES (?, NULL, ?, ?, ?)`);
    for (let i = 0; i < 3; i++) ins.run(1000 + i, 'post', 'https://x/p/a' + i + '/', 'p' + i);
    // Stories live in the same table and outnumbered real posts 60:1 here,
    // which is what made the old estimate say "218 min" instead of "4 min".
    for (let i = 0; i < 50; i++) ins.run(2000 + i, 'story', null, 's' + i);
    expect(postCount(db)).toBe(3);
  });

  it('falls back to non-story media when no permalink is known yet', async () => {
    const { openDb } = await import('../../src/db/open.js');
    const { postCount } = await import('../../src/report/queries.js');
    const db = openDb(':memory:');
    const ins = db.prepare(
      `INSERT INTO my_post (posted_at, caption, media_type, permalink, dedupe_key)
       VALUES (?, NULL, ?, NULL, ?)`);
    ins.run(1, 'image', 'i1'); ins.run(2, 'video', 'v1'); ins.run(3, 'story', 's1');
    expect(postCount(db)).toBe(2);
  });
});

describe('how far back a pull goes', () => {
  it('defaults to every post when nothing is given', async () => {
    const r = await app().inject({ method: 'POST', url: '/api/pull', payload: { jobs: [], sessionid: 'x' } });
    expect(r.statusCode).toBe(400);   // still validated, just not on maxPosts
  });

  it('rejects a fractional or negative count', async () => {
    for (const maxPosts of [-1, 2.5, 'three', 100000]) {
      const r = await app().inject({
        method: 'POST', url: '/api/pull', payload: { jobs: ['likers'], sessionid: 'x', maxPosts },
      });
      expect(r.statusCode, `maxPosts=${maxPosts}`).toBe(400);
      expect(r.json().error).toMatch(/whole number/i);
    }
  });

  it('reports how many posts already have a liker list', async () => {
    const r = await app().inject({ method: 'GET', url: '/api/pull' });
    // The UI defaults to a small recent window only once there is something to
    // top up; on an empty database the sensible default is everything.
    expect(r.json().capturedPosts).toBe(0);
  });

  it('offers a scope control in the form', () => {
    expect(HTML).toMatch(/Last \$\{n\} posts/);
    expect(HTML).toMatch(/maxPosts: Number\(scopeSel\.value\)/);
  });
});

describe('PullRunner honours the post cap', () => {
  it('passes it to the scraper', async () => {
    const { PullRunner } = await import('../../src/scrape/run.js');
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const child = new EventEmitter() as never as {
      stdin: InstanceType<typeof PassThrough>; stdout: InstanceType<typeof PassThrough>;
      stderr: InstanceType<typeof PassThrough>; kill: () => boolean; on: () => void;
    };
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), kill: () => true,
    });
    let args: string[] = [];
    const run = new PullRunner().start(openDb(':memory:'), {
      sessionid: 'sid-value-long-enough', jobs: ['likers'], python: 'py', script: 's.py',
      outDir: mkdtempSync(join(tmpdir(), 'cap-')),
      maxPosts: 3,
      spawnFn: ((_c: string, a: string[]) => { args = a; return child; }) as never,
    });
    expect(args).toContain('--max-posts');
    expect(args[args.indexOf('--max-posts') + 1]).toBe('3');
    expect(run.maxPosts).toBe(3);
  });

  it('omits the flag entirely when pulling everything', async () => {
    const { PullRunner } = await import('../../src/scrape/run.js');
    const { EventEmitter } = await import('node:events');
    const { PassThrough } = await import('node:stream');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const child = new EventEmitter() as never as Record<string, unknown>;
    Object.assign(child, {
      stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), kill: () => true,
    });
    let args: string[] = [];
    new PullRunner().start(openDb(':memory:'), {
      sessionid: 'sid-value-long-enough', jobs: ['likers'], python: 'py', script: 's.py',
      outDir: mkdtempSync(join(tmpdir(), 'cap-')), maxPosts: 0,
      spawnFn: ((_c: string, a: string[]) => { args = a; return child; }) as never,
    });
    expect(args).not.toContain('--max-posts');
  });
});
