import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../../src/db/open.js';
import { PullRunner, ActivePullError, makeScrubber, isPullJob } from '../../src/scrape/run.js';

const SECRET = '71234567%3AAbCdEfGhIjKl%3A17';

/** A stand-in for the python child, so nothing here touches Instagram. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough; stdout: PassThrough; stderr: PassThrough;
    kill: (sig?: string) => boolean;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => true) as never;
  return child;
}

function harness() {
  const child = fakeChild();
  const calls: { cmd: string; args: string[] }[] = [];
  const spawnFn = ((cmd: string, args: string[]) => {
    calls.push({ cmd, args });
    return child;
  }) as never;
  const outDir = mkdtempSync(join(tmpdir(), 'pull-'));
  return { child, calls, spawnFn, outDir };
}

const settle = () => new Promise((r) => setImmediate(r));

describe('makeScrubber', () => {
  it('removes the raw and percent-encoded forms of the session id', () => {
    const scrub = makeScrubber(SECRET);
    expect(scrub(`login failed for ${SECRET}`)).toBe('login failed for <redacted>');
    expect(scrub(`cookie=71234567:AbCdEfGhIjKl:17 rejected`)).toBe('cookie=<redacted> rejected');
  });

  it('ignores a short secret so it cannot blank out ordinary text', () => {
    expect(makeScrubber('abc')('abc def')).toBe('abc def');
  });
});

describe('isPullJob', () => {
  it('accepts only the three known jobs', () => {
    expect(['threads', 'likers', 'comments'].every(isPullJob)).toBe(true);
    expect(isPullJob('user_info')).toBe(false);
    expect(isPullJob(7)).toBe(false);
  });
});

describe('PullRunner', () => {
  it('never puts the session id on the command line', () => {
    const { calls, spawnFn, outDir } = harness();
    const r = new PullRunner();
    r.start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    // `ps` is readable by every process running as this user, so an argument
    // here would hand the credential to anything on the machine.
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].args)).not.toContain('71234567');
    expect(calls[0].args).toContain('--jobs');
  });

  it('feeds the session id to the child over stdin, with a newline', async () => {
    const { child, spawnFn, outDir } = harness();
    const seen: string[] = [];
    child.stdin.on('data', (c) => seen.push(String(c)));
    new PullRunner().start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    await settle();
    expect(seen.join('')).toBe(SECRET + '\n');
  });

  it('keeps the session id out of the run record even when the child echoes it', async () => {
    const { child, spawnFn, outDir } = harness();
    const run = new PullRunner().start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    child.stdout.write(JSON.stringify({ event: 'error', message: `bad session ${SECRET}` }) + '\n');
    child.stderr.write(`Traceback: sessionid=${SECRET}\n`);
    await settle();

    const serialised = JSON.stringify(run);
    expect(serialised).not.toContain('71234567');
    expect(serialised).toContain('<redacted>');
  });

  it('tracks per-job progress', async () => {
    const { child, spawnFn, outDir } = harness();
    const run = new PullRunner().start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['likers'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    child.stdout.write(JSON.stringify({ event: 'progress', job: 'likers', done: 3, total: 47 }) + '\n');
    await settle();
    expect(run.progress.likers).toEqual({ done: 3, total: 47 });
  });

  it('survives a chunk boundary in the middle of a JSON line', async () => {
    const { child, spawnFn, outDir } = harness();
    const run = new PullRunner().start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['likers'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    const line = JSON.stringify({ event: 'progress', job: 'likers', done: 9, total: 47 }) + '\n';
    child.stdout.write(line.slice(0, 14));
    await settle();
    child.stdout.write(line.slice(14));
    await settle();
    expect(run.progress.likers).toEqual({ done: 9, total: 47 });
  });

  it('imports what the run produced and reports the summary', async () => {
    const { child, spawnFn, outDir } = harness();
    const db = openDb(':memory:');
    const csv = join(outDir, 'threads.csv');
    writeFileSync(csv, [
      'thread_id,thread_title,is_group,username,full_name,user_id',
      '99887766,Marcus,False,marcus_r,Marcus Reed,555',
    ].join('\n') + '\n');

    const run = new PullRunner().start(db, {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    child.stdout.write(JSON.stringify({ event: 'file', job: 'threads', path: csv }) + '\n');
    await settle();
    child.emit('close', 0);
    await settle();

    expect(run.state).toBe('done');
    expect(run.imports).toHaveLength(1);
    expect(run.imports[0].kind).toBe('threads');
    // The header decides the importer, so a pull is indistinguishable from a
    // manual `npm run ingest` as far as the database is concerned.
    const acct = db.prepare('SELECT username FROM account WHERE username = ?').get('marcus_r');
    expect(acct).toBeTruthy();
  });

  it('marks a non-zero exit as failed', async () => {
    const { child, spawnFn, outDir } = harness();
    const run = new PullRunner().start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    child.stdout.write(JSON.stringify({ event: 'error', message: 'Session id rejected' }) + '\n');
    await settle();
    child.emit('close', 4);
    await settle();
    expect(run.state).toBe('failed');
    expect(run.error).toBe('Session id rejected');
  });

  it('treats exit code 5 as a cancellation rather than a failure', async () => {
    const { child, spawnFn, outDir } = harness();
    const r = new PullRunner();
    const run = r.start(openDb(':memory:'), {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    expect(r.cancel(run.id)).toBe(true);
    child.emit('close', 5);
    await settle();
    expect(run.state).toBe('cancelled');
  });

  it('refuses a second concurrent pull', () => {
    const { spawnFn, outDir } = harness();
    const r = new PullRunner();
    const db = openDb(':memory:');
    const first = r.start(db, {
      sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn,
    });
    // Two passes at once double the request rate, which is the thing that
    // actually gets accounts actioned.
    expect(() => r.start(db, {
      sessionid: SECRET, jobs: ['likers'], python: 'py', script: 's.py', outDir, spawnFn,
    })).toThrow(ActivePullError);
    expect(r.activeRun()?.id).toBe(first.id);
  });

  it('allows another pull once the first has closed', async () => {
    const { child, spawnFn, outDir } = harness();
    const r = new PullRunner();
    const db = openDb(':memory:');
    r.start(db, { sessionid: SECRET, jobs: ['threads'], python: 'py', script: 's.py', outDir, spawnFn });
    child.emit('close', 0);
    await settle();
    expect(r.activeRun()).toBeNull();
    const second = harness();
    expect(() => r.start(db, {
      sessionid: SECRET, jobs: ['likers'], python: 'py', script: 's.py',
      outDir: second.outDir, spawnFn: second.spawnFn,
    })).not.toThrow();
  });

  it('rejects an empty job list and a blank session id', () => {
    const { spawnFn, outDir } = harness();
    const r = new PullRunner();
    const db = openDb(':memory:');
    expect(() => r.start(db, { sessionid: SECRET, jobs: [], python: 'py', outDir, spawnFn }))
      .toThrow(/at least one/i);
    expect(() => r.start(db, { sessionid: '   ', jobs: ['threads'], python: 'py', outDir, spawnFn }))
      .toThrow(/session id/i);
  });
});
