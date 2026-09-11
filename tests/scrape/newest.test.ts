import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { pythonCandidates } from '../../src/scrape/python.js';

/**
 * scrape.py's post selection, exercised through a real interpreter.
 *
 * It is Python, so it cannot be imported here — but it is also the function
 * that decides *which* posts a capped pull touches, and getting it wrong means
 * silently scraping the wrong three posts. `newest` deliberately has no
 * instagrapi dependency (that import lives inside main), so any python3 runs it.
 */
function python(): string | null {
  for (const cmd of pythonCandidates()) {
    try {
      execFileSync(cmd, ['-c', 'import sys'], { stdio: 'ignore', timeout: 10_000 });
      return cmd;
    } catch { /* try the next */ }
  }
  return null;
}

const PY = python();
const run = (body: string) =>
  execFileSync(PY as string, ['-c', `
import importlib.util, datetime, json
spec = importlib.util.spec_from_file_location("scrape", "scrape.py")
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

class M:
    def __init__(self, code, days, dated=True):
        self.code = code
        self.taken_at = datetime.datetime(2026,1,1) + datetime.timedelta(days=days) if dated else None

${body}
`], { encoding: 'utf8', timeout: 20_000 }).trim();

describe.skipIf(!PY)('scrape.py newest()', () => {
  it('takes the genuinely newest posts, not the ones Instagram lists first', () => {
    // Instagram lets you pin three posts to the top of your profile and the
    // feed returns them first regardless of age. Trusting that order would
    // scrape a two-year-old pin and call it "your last 3 posts".
    const out = run(`
feed = [M("PINNED_OLD", 0), M("new1", 300), M("new2", 290), M("new3", 280), M("old", 10)]
print(json.dumps([x.code for x in m.newest(feed, 3)]))`);
    expect(JSON.parse(out)).toEqual(['new1', 'new2', 'new3']);
  });

  it('treats 0 as every post', () => {
    const out = run(`
feed = [M("a", 3), M("b", 1), M("c", 2)]
print(json.dumps([x.code for x in m.newest(feed, 0)]))`);
    expect(JSON.parse(out)).toEqual(['a', 'c', 'b']);
  });

  it('copes with asking for more posts than exist', () => {
    const out = run(`print(json.dumps(len(m.newest([M("a",1), M("b",2)], 99))))`);
    expect(JSON.parse(out)).toBe(2);
  });

  it('does not crash on a post with no date', () => {
    // `or 0` here once mixed an int with a datetime and raised inside the sort,
    // which would have taken down an otherwise healthy pull.
    const out = run(`
feed = [M("nodate", 0, dated=False), M("dated", 5)]
print(json.dumps([x.code for x in m.newest(feed, 2)]))`);
    expect(JSON.parse(out)).toEqual(['dated', 'nodate']);
  });

  it('over-fetches past the pin limit so the cap is still honoured', () => {
    const src = execFileSync('cat', ['scrape.py'], { encoding: 'utf8' });
    expect(src).toMatch(/PIN_ALLOWANCE = 3/);
    // One page is one request whether you ask it for 3 items or 6, so the
    // allowance costs nothing.
    expect(src).toMatch(/amount=\(want \+ PIN_ALLOWANCE\) if want else 0/);
  });
});
