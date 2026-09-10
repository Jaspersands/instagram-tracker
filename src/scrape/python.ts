import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, where scrape.py lives next to package.json. */
export const SCRAPE_SCRIPT = join(here, '..', '..', 'scrape.py');

/**
 * Anaconda first: it is what `python3` resolves to on this machine and where
 * instagrapi was installed. IG_PYTHON overrides everything.
 */
export function pythonCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [
    env.IG_PYTHON,
    '/opt/anaconda3/bin/python3',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    'python3',
  ].filter((p): p is string => !!p && p.trim().length > 0);
}

export interface Preflight {
  ok: boolean;
  python: string | null;
  script: string;
  scriptFound: boolean;
  /** Plain-language remedy, safe to show in the UI. */
  problem: string | null;
  fix: string | null;
}

export type Probe = (cmd: string, args: string[]) => void;

const realProbe: Probe = (cmd, args) => {
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 30_000 });
};

/**
 * Find a python that can actually run the scraper, and say precisely which of
 * the two possible problems applies — "no python" and "python but no
 * instagrapi" have completely different fixes, and reporting them as one
 * failure sends people down the wrong path.
 */
export function preflight(
  candidates: string[] = pythonCandidates(),
  probe: Probe = realProbe,
  script: string = SCRAPE_SCRIPT,
  fileExists: (p: string) => boolean = existsSync,
): Preflight {
  const scriptFound = fileExists(script);
  let sawPython = false;

  for (const cmd of candidates) {
    try {
      probe(cmd, ['-c', 'import sys']);
    } catch {
      continue; // not a working interpreter
    }
    sawPython = true;
    try {
      probe(cmd, ['-c', 'import instagrapi']);
    } catch {
      continue; // python works, library missing — keep looking
    }
    return {
      ok: scriptFound, python: cmd, script, scriptFound,
      problem: scriptFound ? null : 'scrape.py is missing from the project folder.',
      fix: scriptFound ? null : 'Restore scrape.py from git.',
    };
  }

  return sawPython
    ? {
        ok: false, python: null, script, scriptFound,
        problem: 'Python is installed, but instagrapi is not.',
        fix: 'pip3 install instagrapi',
      }
    : {
        ok: false, python: null, script, scriptFound,
        problem: 'No working python3 found.',
        fix: 'Install Python 3, then: pip3 install instagrapi',
      };
}
