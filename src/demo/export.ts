/**
 * Build the static GitHub Pages demo from the synthetic demo database.
 *
 * The dashboard is a vanilla SPA that reads nine GET /api/* endpoints. This
 * calls the very same query functions the server calls, writes their output as
 * flat JSON, and rewrites index.html to fetch those files instead of a live
 * server — so the published demo is faithful to the real UI, running entirely
 * in the browser on invented data (user236, "nice one 3"). No server, nothing
 * real, and the write-only Data tab is replaced by an honest explanation.
 */
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb } from '../db/open.js';
import { people, overview, decay, habits, taste, person, inbound, postCount, capturedPostCount }
  from '../report/queries.js';
import { unfollowers, lurkGap } from '../report/reports.js';
import { status } from '../report/status.js';

const SRC_DB = process.env.DEMO_DB ?? 'data/demo.db';
const OUT = process.env.DEMO_OUT ?? 'docs';
// Freeze the clock just after the newest demo snapshot so "3 days ago" is stable
// across rebuilds and never drifts into "2 years ago" as real time passes.
const NOW = Math.floor(new Date('2026-09-06T12:00:00Z').getTime() / 1000);

function main(): void {
  const db = openDb(SRC_DB);
  const apiDir = join(OUT, 'api');
  rmSync(apiDir, { recursive: true, force: true });
  mkdirSync(apiDir, { recursive: true });

  const write = (name: string, data: unknown) =>
    writeFileSync(join(apiDir, name + '.json'), JSON.stringify(data));

  const ppl = people(db, NOW);

  write('overview', overview(db));
  write('people', ppl);
  write('unfollowers', unfollowers(db, NOW));
  write('lurkers', lurkGap(db, 200));
  write('habits', habits(db));
  write('taste', taste(db));
  write('inbound', inbound(db, NOW));
  write('status', status(db, NOW));
  // The pull endpoint describes a server that does not exist here; the demo
  // shows the form disabled with a note, so ready is false and there is no run.
  write('pull', {
    ready: false, python: null,
    problem: 'This is the static demo — there is no server to pull from.',
    fix: null, posts: postCount(db), capturedPosts: capturedPostCount(db),
    jobs: [
      { id: 'threads', label: 'DM threads', note: 'Names the real account behind each DM thread.', perPost: false },
      { id: 'likers', label: 'Post likers', note: 'Who liked each of your posts.', perPost: true },
      { id: 'comments', label: 'Post comments', note: 'Comments on your posts.', perPost: true },
    ],
    run: null, busy: null,
  });

  // decay is parameterised by a day window; snapshot each option the UI offers.
  for (const days of [30, 90, 180, 365]) write('decay-' + days, decay(db, NOW, days));

  // person is one file per username, keyed, so a row click resolves offline.
  const persons: Record<string, unknown> = {};
  for (const p of ppl) persons[p.username] = person(db, p.username, NOW);
  write('person', persons);

  writeIndex();
  writeConfig();
  console.log(`demo written to ${OUT}/ — ${ppl.length} people, frozen at ${new Date(NOW * 1000).toISOString()}`);
}

/** Rewrite the live dashboard into a static one. */
function writeIndex(): void {
  let html = readFileSync('src/server/public/index.html', 'utf8');

  // 1. get(): map every live endpoint to a static JSON file.
  html = html.replace(
    "const get = (u) => fetch(u).then((r) => r.json());",
    STATIC_GET);

  // 2. post(): there is no server. Refresh and pull both funnel through it.
  html = html.replace(
    /const post = async \(u, body\) => \{[\s\S]*?\n\};/,
    STATIC_POST);

  // 3. The "Check folders" button has nothing to check.
  html = html.replace(
    '<button class="btn sm" id="refresh">Check folders for new data</button>',
    '<a class="btn sm" href="https://github.com/__REPO__" target="_blank" rel="noopener">View the code on GitHub →</a>');

  // 4. The refresh handler binds to a button we just removed; guard it so the
  //    single throw does not halt the rest of the script.
  html = html.replace(
    "$('#refresh').onclick = async () => {",
    "if ($('#refresh')) $('#refresh').onclick = async () => {");

  // 5. A banner so no one mistakes the demo for their own data.
  html = html.replace('<main>', DEMO_BANNER + '\n<main>');

  // 6. The PIN curtain and its styles.
  html = html.replace('</style>', PIN_STYLES + '\n</style>');
  html = html.replace(/<script>\n/, PIN_GATE + '\n<script>\n');

  writeFileSync(join(OUT, 'index.html'), html);
}

/** A tiny config file so the PIN can change without a rebuild. */
function writeConfig(): void {
  writeFileSync(join(OUT, 'demo-config.js'),
    '// Soft curtain only: this file is public, so the PIN is not a secret and\n' +
    '// the data behind it is entirely synthetic. It just keeps casual visitors out.\n' +
    'window.DEMO_PIN = "2021";\n');
}

const STATIC_GET = `const get = (u) => {
  // Live server -> static files. decay carries a ?days window; person carries a
  // username after the path, resolved from one keyed file.
  if (u.startsWith('/api/decay')) {
    const days = new URLSearchParams(u.split('?')[1] || '').get('days') || '90';
    return fetch('./api/decay-' + days + '.json').then((r) => r.json());
  }
  if (u.startsWith('/api/person/')) {
    const who = decodeURIComponent(u.slice('/api/person/'.length));
    return fetch('./api/person.json').then((r) => r.json())
      .then((m) => m[who] || { row: null, events: [], timeline: [] });
  }
  return fetch('./api' + u.slice('/api'.length) + '.json').then((r) => r.json());
};`;

const STATIC_POST = `const post = async () => {
  // No server in the static demo. Nothing writes.
  throw new Error('This is the static demo — pulling and refreshing need the local app.');
};`;

const DEMO_BANNER = `<div style="background:var(--s1-soft);border-bottom:1px solid var(--line);
  padding:9px 22px;font-size:13px;color:var(--ink-2);text-align:center">
  <b style="color:var(--ink)">Live demo</b> on invented data — every name, DM and number here is synthetic.
  <a href="https://github.com/__REPO__" target="_blank" rel="noopener" style="color:var(--s1)">Get the real thing →</a>
</div>`;

const PIN_STYLES = `
#pin-gate { position:fixed; inset:0; z-index:1000; background:var(--plane);
  display:flex; align-items:center; justify-content:center; }
#pin-gate .box { background:var(--surface); border:1px solid var(--line);
  border-radius:16px; padding:30px 28px; width:min(340px,92vw); box-shadow:var(--shadow-2); text-align:center; }
#pin-gate h1 { font-size:18px; margin-bottom:4px; }
#pin-gate p { color:var(--muted); font-size:13px; margin-bottom:18px; }
#pin-gate input { width:100%; text-align:center; letter-spacing:.4em; font-size:20px;
  padding:11px; border:1px solid var(--line-2); border-radius:9px; background:var(--plane); color:var(--ink); }
#pin-gate .err { color:var(--bad); font-size:12.5px; height:16px; margin-top:8px; }
#pin-gate button { margin-top:10px; width:100%; }`;

const PIN_GATE = `<div id="pin-gate" hidden>
  <div class="box">
    <h1>Instagram Tracker</h1>
    <p>Enter the PIN to view the demo.</p>
    <input id="pin-in" type="password" inputmode="numeric" autocomplete="off" aria-label="PIN" placeholder="••••">
    <div class="err" id="pin-err"></div>
    <button class="btn primary" id="pin-go">Enter</button>
  </div>
</div>
<script src="./demo-config.js"></script>
<script>
(function () {
  var KEY = 'ig-demo-ok';
  var gate = document.getElementById('pin-gate');
  var body = document.body;
  var ok = false;
  try { ok = sessionStorage.getItem(KEY) === '1'; } catch (e) {}
  if (ok) return;                                  // already entered this session
  gate.hidden = false;
  body.style.overflow = 'hidden';
  var input = document.getElementById('pin-in');
  var err = document.getElementById('pin-err');
  input.focus();
  function submit() {
    if (input.value === (window.DEMO_PIN || '2021')) {
      try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
      gate.remove(); body.style.overflow = '';
    } else {
      err.textContent = 'Not quite.'; input.value = ''; input.focus();
    }
  }
  document.getElementById('pin-go').onclick = submit;
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
})();
</script>`;

main();
