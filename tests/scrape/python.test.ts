import { describe, it, expect } from 'vitest';
import { preflight, pythonCandidates } from '../../src/scrape/python.js';

/** A probe that succeeds only for the commands and imports it is told to allow. */
const probeFor = (ok: Record<string, string[]>) => (cmd: string, args: string[]) => {
  const allowed = ok[cmd];
  if (!allowed) throw new Error('ENOENT');
  const mod = args[1].replace('import ', '');
  if (!allowed.includes(mod)) throw new Error('ModuleNotFoundError');
};

describe('preflight', () => {
  it('accepts the first python that can import instagrapi', () => {
    const r = preflight(['/a/python3', '/b/python3'],
      probeFor({ '/b/python3': ['sys', 'instagrapi'] }), 'scrape.py', () => true);
    expect(r).toMatchObject({ ok: true, python: '/b/python3', problem: null });
  });

  it('skips a python that works but lacks the library', () => {
    const r = preflight(['/a/python3', '/b/python3'],
      probeFor({ '/a/python3': ['sys'], '/b/python3': ['sys', 'instagrapi'] }), 'scrape.py', () => true);
    expect(r.python).toBe('/b/python3');
  });

  it('names the missing library when a python exists', () => {
    const r = preflight(['/a/python3'], probeFor({ '/a/python3': ['sys'] }), 'scrape.py', () => true);
    // "no python" and "no instagrapi" have different fixes; reporting them as
    // one failure sends people down the wrong path.
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(/instagrapi is not/i);
    expect(r.fix).toBe('pip3 install instagrapi');
  });

  it('reports a missing interpreter differently', () => {
    const r = preflight(['/a/python3'], probeFor({}), 'scrape.py', () => true);
    expect(r.problem).toMatch(/no working python3/i);
    expect(r.fix).toMatch(/install python 3/i);
  });

  it('is not ready when the script itself is gone', () => {
    const r = preflight(['/a/python3'],
      probeFor({ '/a/python3': ['sys', 'instagrapi'] }), 'scrape.py', () => false);
    expect(r.ok).toBe(false);
    expect(r.scriptFound).toBe(false);
  });

  it('lets IG_PYTHON take precedence', () => {
    expect(pythonCandidates({ IG_PYTHON: '/opt/mine/python' } as never)[0]).toBe('/opt/mine/python');
  });
});
