import { describe, it, expect } from 'vitest';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { buildServer } from '../../src/server/server.js';
import {
  setPassword, loadAuth, verifyPassword, mintSession, validSession,
  readCookie, sessionCookie, Attempts, COOKIE,
} from '../../src/server/auth.js';
import { isSameOrigin } from '../../src/server/origin.js';

const tmpAuth = () => join(mkdtempSync(join(tmpdir(), 'auth-')), 'auth.json');

describe('password storage', () => {
  it('never stores the password itself', () => {
    const p = tmpAuth();
    setPassword('correct horse battery', p);
    const raw = readFileSync(p, 'utf8');
    expect(raw).not.toContain('correct horse battery');
    expect(JSON.parse(raw)).toHaveProperty('hash');
  });

  it('writes the file readable only by this user', () => {
    const p = tmpAuth();
    setPassword('hunter22', p);
    expect(statSync(p).mode & 0o077).toBe(0);
  });

  it('salts, so the same password hashes differently each time', () => {
    const a = setPassword('same', tmpAuth());
    const b = setPassword('same', tmpAuth());
    expect(a.hash).not.toBe(b.hash);
  });

  it('accepts the right password and rejects the wrong one', () => {
    const p = tmpAuth();
    setPassword('2021', p);
    const f = loadAuth(p)!;
    expect(verifyPassword('2021', f)).toBe(true);
    expect(verifyPassword('2020', f)).toBe(false);
    expect(verifyPassword('', f)).toBe(false);
  });
});

describe('sessions', () => {
  it('accepts a token it minted', () => {
    const f = setPassword('x1234', tmpAuth());
    expect(validSession(mintSession(f), f)).toBe(true);
  });

  it('rejects a forged or tampered token', () => {
    const f = setPassword('x1234', tmpAuth());
    const good = mintSession(f);
    const [body] = good.split('.');
    expect(validSession(`${body}.${'0'.repeat(64)}`, f)).toBe(false);
    expect(validSession('9999999999999.deadbeef', f)).toBe(false);
    expect(validSession(undefined, f)).toBe(false);
  });

  it('rejects a token signed with another install’s secret', () => {
    const a = setPassword('x1234', tmpAuth());
    const b = setPassword('x1234', tmpAuth());
    expect(validSession(mintSession(a), b)).toBe(false);
  });

  it('expires', () => {
    const f = setPassword('x1234', tmpAuth());
    const t = mintSession(f, 0);
    expect(validSession(t, f, 0)).toBe(true);
    expect(validSession(t, f, 40 * 86_400_000)).toBe(false);
  });

  it('sets an HttpOnly cookie, and Secure behind HTTPS', () => {
    expect(sessionCookie('t', false)).toContain('HttpOnly');
    expect(sessionCookie('t', false)).not.toContain('Secure');
    expect(sessionCookie('t', true)).toContain('Secure');
  });

  it('reads its cookie out of a crowded header', () => {
    expect(readCookie(`a=1; ${COOKIE}=abc.def; z=9`, COOKIE)).toBe('abc.def');
    expect(readCookie('a=1', COOKIE)).toBeUndefined();
  });
});

describe('brute-force throttle', () => {
  it('blocks after repeated wrong guesses', () => {
    // A short password is guessable in seconds otherwise, and this may be
    // reachable from a phone over a tunnel.
    const a = new Attempts(3, 1000);
    expect(a.blocked(0)).toBe(false);
    a.record(0); a.record(1); a.record(2);
    expect(a.blocked(3)).toBe(true);
    expect(a.blocked(2000)).toBe(false);   // window slides
  });
});

describe('the server with a password set', () => {
  const app = () => {
    const p = tmpAuth();
    setPassword('2021', p);
    return { app: buildServer(openDb(':memory:'), { authPath: p }), p };
  };

  it('serves nothing without a session', async () => {
    const { app: a } = app();
    for (const url of ['/', '/api/people', '/api/overview', '/bookmarklet']) {
      const r = await a.inject({ method: 'GET', url });
      expect(r.statusCode, url).toBe(401);
    }
  });

  it('shows a login page rather than a bare error', async () => {
    const { app: a } = app();
    const r = await a.inject({ method: 'GET', url: '/' });
    expect(r.body).toContain('type="password"');
  });

  it('rejects the wrong password', async () => {
    const { app: a } = app();
    const r = await a.inject({
      method: 'POST', url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'password=nope',
    });
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
  });

  it('lets the right password through, then serves real data', async () => {
    const { app: a } = app();
    const login = await a.inject({
      method: 'POST', url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'password=2021',
    });
    expect(login.statusCode).toBe(303);
    const cookie = String(login.headers['set-cookie']);
    expect(cookie).toContain('HttpOnly');

    const r = await a.inject({ method: 'GET', url: '/api/overview', headers: { cookie } });
    expect(r.statusCode).toBe(200);
  });

  it('is not fooled by a made-up cookie', async () => {
    const { app: a } = app();
    const r = await a.inject({
      method: 'GET', url: '/api/people',
      headers: { cookie: `${COOKIE}=99999999999999.${'a'.repeat(64)}` },
    });
    expect(r.statusCode).toBe(401);
  });
});

describe('the server with no password set', () => {
  it('stays open, because it is loopback-only until one is set', async () => {
    const a = buildServer(openDb(':memory:'), { authPath: join(tmpdir(), 'definitely-absent.json') });
    const r = await a.inject({ method: 'GET', url: '/api/overview' });
    expect(r.statusCode).toBe(200);
  });
});

describe('same-origin check behind a tunnel', () => {
  it('accepts the login form posted from the tunnel hostname', () => {
    // A loopback-only test would 403 the user's own login the moment the
    // dashboard is reached through a tunnel.
    expect(isSameOrigin('https://mac.tail1234.ts.net', 'mac.tail1234.ts.net')).toBe(true);
  });

  it('still refuses a different site', () => {
    expect(isSameOrigin('https://evil.example', 'mac.tail1234.ts.net')).toBe(false);
  });

  it('still accepts loopback and no-origin', () => {
    expect(isSameOrigin('http://127.0.0.1:4317', '127.0.0.1:4317')).toBe(true);
    expect(isSameOrigin(undefined, 'anything')).toBe(true);
  });
});
