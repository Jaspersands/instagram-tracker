import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Password protection for the dashboard.
 *
 * Real server-side auth, not a curtain: nothing is served until a request
 * proves it holds a valid session. That distinction is the whole point — a
 * client-side gate on static files cannot work, because the files are already
 * in the browser by the time the gate runs.
 *
 * The password is never stored. A scrypt hash and a random HMAC secret live in
 * a local file outside the repo, mode 0600.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_DAYS = 30;
export const COOKIE = 'ig_session';

export interface AuthFile {
  salt: string;
  hash: string;
  /** Signs session cookies, so a restart does not log you out. */
  secret: string;
  createdAt: number;
}

export function authPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.IG_AUTH ?? 'data/auth.json';
}

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')): { salt: string; hash: string } {
  const hash = scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, hash };
}

export function setPassword(password: string, path = authPath()): AuthFile {
  if (password.length < 4) throw new Error('Password must be at least 4 characters.');
  const { salt, hash } = hashPassword(password);
  const file: AuthFile = { salt, hash, secret: randomBytes(32).toString('hex'), createdAt: Date.now() };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(file, null, 2));
  chmodSync(path, 0o600);   // readable only by this user
  return file;
}

export function loadAuth(path = authPath()): AuthFile | null {
  try {
    if (!existsSync(path)) return null;
    const f = JSON.parse(readFileSync(path, 'utf8')) as AuthFile;
    return f.salt && f.hash && f.secret ? f : null;
  } catch {
    return null;
  }
}

export function verifyPassword(password: string, file: AuthFile): boolean {
  const candidate = scryptSync(password, file.salt, SCRYPT.keylen, SCRYPT);
  const known = Buffer.from(file.hash, 'hex');
  // Lengths must match before timingSafeEqual, and comparing this way keeps the
  // check constant-time so the response cannot be used to guess the hash.
  return candidate.length === known.length && timingSafeEqual(candidate, known);
}

/** A signed, expiring token. Survives restarts because the secret is on disk. */
export function mintSession(file: AuthFile, now = Date.now()): string {
  const expires = now + SESSION_DAYS * 86_400_000;
  const body = String(expires);
  const sig = createHmac('sha256', file.secret).update(body).digest('hex');
  return `${body}.${sig}`;
}

export function validSession(token: string | undefined, file: AuthFile, now = Date.now()): boolean {
  if (!token) return false;
  const [body, sig] = token.split('.');
  if (!body || !sig) return false;
  const expected = createHmac('sha256', file.secret).update(body).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  const expires = Number(body);
  return Number.isFinite(expires) && expires > now;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}

export function sessionCookie(token: string, secure: boolean): string {
  const bits = [
    `${COOKIE}=${encodeURIComponent(token)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    `Max-Age=${SESSION_DAYS * 86_400}`,
  ];
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

/**
 * Simple per-process throttle on wrong guesses. A 4-digit password is
 * brute-forceable in seconds otherwise, and this dashboard may be reachable
 * from a phone over a tunnel.
 */
export class Attempts {
  private hits: number[] = [];
  constructor(private max = 10, private windowMs = 5 * 60_000) {}

  blocked(now = Date.now()): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    return this.hits.length >= this.max;
  }

  record(now = Date.now()): void {
    this.hits.push(now);
  }

  clear(): void {
    this.hits = [];
  }

  /** Seconds until the next attempt is allowed. */
  retryAfter(now = Date.now()): number {
    if (!this.hits.length) return 0;
    return Math.max(1, Math.ceil((this.windowMs - (now - this.hits[0])) / 1000));
  }
}
