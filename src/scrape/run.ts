import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { importApiCsv } from '../ingest/apiCsv.js';
import { resolveIdentities, applyIdentities } from '../derive/identity.js';
import { preflight, SCRAPE_SCRIPT } from './python.js';

export const PULL_JOBS = ['threads', 'likers', 'comments'] as const;
export type PullJob = (typeof PULL_JOBS)[number];

export function isPullJob(v: unknown): v is PullJob {
  return typeof v === 'string' && (PULL_JOBS as readonly string[]).includes(v);
}

/** Roughly what each job costs, for an honest estimate before you commit to it. */
export const JOB_INFO: Record<PullJob, { label: string; note: string; perPost: boolean }> = {
  threads: {
    label: 'DM threads',
    note: 'Names the real account behind each DM thread. Cheapest and most valuable.',
    perPost: false,
  },
  likers: {
    label: 'Post likers',
    note: 'Who liked each of your posts. One request per post.',
    perPost: true,
  },
  comments: {
    label: 'Post comments',
    note: 'Comments on your posts — absent from the export entirely.',
    perPost: true,
  },
};

export interface PullEvent {
  at: number;
  kind: string;
  job: PullJob | null;
  message: string;
  done: number | null;
  total: number | null;
}

export interface PullRun {
  id: string;
  jobs: PullJob[];
  /** Cap on the per-post jobs; 0 means every post. */
  maxPosts: number;
  startedAt: number;
  finishedAt: number | null;
  state: 'running' | 'done' | 'failed' | 'cancelled';
  events: PullEvent[];
  progress: Record<string, { done: number; total: number }>;
  files: string[];
  imports: { name: string; kind: string; summary: string }[];
  linked: number;
  error: string | null;
}

export interface StartOptions {
  sessionid: string;
  jobs: PullJob[];
  outDir?: string;
  python?: string;
  script?: string;
  delay?: [number, number];
  maxPosts?: number;
  /** Injected in tests. */
  spawnFn?: typeof spawn;
}

const MAX_EVENTS = 600;
const MAX_MESSAGE = 500;

/** Public view of a run. There is deliberately no field that could hold a credential. */
export type PullView = PullRun;

export class ActivePullError extends Error {
  constructor(public readonly runId: string) {
    // A second concurrent pass doubles the request rate against Instagram,
    // which is the pattern that actually gets accounts actioned.
    super('A pull is already running.');
  }
}

export class PullRunner {
  private runs = new Map<string, PullRun>();
  private active: { id: string; child: ChildProcess } | null = null;

  get(id: string): PullRun | undefined {
    return this.runs.get(id);
  }

  activeRun(): PullRun | null {
    return this.active ? this.runs.get(this.active.id) ?? null : null;
  }

  latest(): PullRun | null {
    let best: PullRun | null = null;
    for (const r of this.runs.values()) if (!best || r.startedAt > best.startedAt) best = r;
    return best;
  }

  cancel(id: string): boolean {
    if (!this.active || this.active.id !== id) return false;
    this.active.child.kill('SIGINT');
    return true;
  }

  /**
   * Launch a pull.
   *
   * The session id is written to the child's **stdin**, never into argv: a
   * command line is world-readable through `ps`, so an argument would hand the
   * credential to every process running as this user. It is not stored on the
   * run record, not logged, and scrubbed out of the child's output before any
   * of it is kept.
   */
  start(db: Db, opts: StartOptions): PullRun {
    if (this.active) throw new ActivePullError(this.active.id);
    if (!opts.jobs.length) throw new Error('Pick at least one thing to pull.');
    if (!opts.sessionid.trim()) throw new Error('A session id is required.');

    // Only probe for python when the caller has not named one; the probe shells
    // out and importing instagrapi is not fast.
    let python = opts.python;
    if (!python) {
      const pre = preflight();
      if (!pre.python) throw new Error(pre.problem ?? 'No usable python found.');
      python = pre.python;
    }

    const script = opts.script ?? SCRAPE_SCRIPT;
    const outDir = opts.outDir ?? join('data', 'pulls');
    mkdirSync(outDir, { recursive: true });

    const [lo, hi] = opts.delay ?? [3, 6];
    const run: PullRun = {
      id: randomUUID().slice(0, 8),
      jobs: opts.jobs,
      maxPosts: opts.maxPosts ?? 0,
      startedAt: Date.now(),
      finishedAt: null,
      state: 'running',
      events: [],
      progress: Object.fromEntries(opts.jobs.map((j) => [j, { done: 0, total: 0 }])),
      files: [],
      imports: [],
      linked: 0,
      error: null,
    };
    this.runs.set(run.id, run);

    const args = [
      script,
      '--jobs', opts.jobs.join(','),
      '--out', outDir,
      '--delay-min', String(lo),
      '--delay-max', String(hi),
    ];
    if (opts.maxPosts) args.push('--max-posts', String(opts.maxPosts));

    const sessionid = opts.sessionid.trim();
    const scrub = makeScrubber(sessionid);
    const spawner = opts.spawnFn ?? spawn;
    const child = spawner(python, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.active = { id: run.id, child };

    child.stdin?.on('error', () => { /* child died before reading; exit handler reports it */ });
    child.stdin?.write(sessionid + '\n');
    child.stdin?.end();

    lines(child, 'stdout', (line) => this.onStdout(run, line, scrub));
    lines(child, 'stderr', (line) => {
      const t = scrub(line);
      if (t.trim()) push(run, { kind: 'log', job: null, message: t, done: null, total: null });
    });

    child.on('error', (err) => {
      run.error = scrub(err.message);
      push(run, { kind: 'error', job: null, message: run.error, done: null, total: null });
    });

    child.on('close', (code) => {
      this.active = null;
      this.finish(db, run, code);
    });

    return run;
  }

  private onStdout(run: PullRun, line: string, scrub: (s: string) => string): void {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Not our protocol — keep it as a log line rather than dropping it, since
      // it may be the only clue about a failure.
      const t = scrub(line);
      if (t.trim()) push(run, { kind: 'log', job: null, message: t, done: null, total: null });
      return;
    }

    const kind = String(ev.event ?? 'log');
    const job = isPullJob(ev.job) ? ev.job : null;
    const message = scrub(String(ev.message ?? ''));
    const done = typeof ev.done === 'number' ? ev.done : null;
    const total = typeof ev.total === 'number' ? ev.total : null;

    if (kind === 'file' && typeof ev.path === 'string') {
      run.files.push(ev.path);
      return;
    }
    if (kind === 'error') run.error = message;
    if (job && done != null) run.progress[job] = { done, total: total ?? 0 };

    push(run, { kind, job, message, done, total });
  }

  /** Import whatever the run produced. The data path is identical to a manual `npm run ingest`. */
  private finish(db: Db, run: PullRun, code: number | null): void {
    if (code === 5) {
      run.state = 'cancelled';
    } else if (code !== 0) {
      run.state = 'failed';
      run.error ??= `The scraper exited with code ${code}.`;
    }

    for (const f of run.files) {
      try {
        const r = importApiCsv(db, f);
        run.imports.push({ name: basename(f), kind: r.kind, summary: r.summary });
        push(run, { kind: 'import', job: null, message: `${basename(f)}: ${r.summary}`, done: null, total: null });
      } catch (err) {
        push(run, {
          kind: 'error', job: null, done: null, total: null,
          message: `Could not import ${basename(f)}: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    if (run.imports.length) {
      // Usernames learned just now can resolve DM threads ingested long ago.
      run.linked = applyIdentities(db, resolveIdentities(db));
    }
    if (run.state === 'running') run.state = 'done';
    run.finishedAt = Date.now();
  }
}

function push(run: PullRun, e: Omit<PullEvent, 'at'>): void {
  run.events.push({ at: Date.now(), ...e, message: e.message.slice(0, MAX_MESSAGE) });
  if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
}

/**
 * Never let the credential reach a log or an HTTP response. instagrapi can put
 * request context into exception text, and a session id has both a raw and a
 * percent-encoded form depending on where it was copied from.
 */
export function makeScrubber(secret: string): (s: string) => string {
  const forms = [...new Set([secret, secret.replace(/:/g, '%3A'), secret.replace(/%3A/g, ':')])]
    .filter((f) => f.length >= 8);
  return (s: string) => {
    let out = s;
    for (const f of forms) out = out.split(f).join('<redacted>');
    return out;
  };
}

function lines(child: ChildProcess, stream: 'stdout' | 'stderr', onLine: (l: string) => void): void {
  let buf = '';
  child[stream]?.setEncoding('utf8');
  child[stream]?.on('data', (chunk: string) => {
    buf += chunk;
    const parts = buf.split('\n');
    buf = parts.pop() ?? '';
    for (const p of parts) if (p.trim()) onLine(p);
  });
  child[stream]?.on('end', () => { if (buf.trim()) onLine(buf); });
}

/** One runner per process, so two browser tabs cannot start two pulls. */
export const runner = new PullRunner();
