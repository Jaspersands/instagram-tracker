import { inventory, formatInventory } from '../archive/inventory.js';
import { openDb } from '../db/open.js';
import { ingestAndDerive } from '../ingest/pipeline.js';
import { ingestCapture } from '../ingest/ingest.js';
import { isCaptureFile } from '../parse/capture.js';
import { unfollowers, lurkGap } from '../report/reports.js';
import { watchFolder } from '../watch/watcher.js';
import { buildServer } from '../server/server.js';
import { status, formatStatus } from '../report/status.js';
import { notify, unfollowerMessage } from '../notify/notify.js';
import { resolveIdentities, applyIdentities } from '../derive/identity.js';
import { candidateDirs, findInputs } from '../auto/discover.js';
import { refreshAll } from '../auto/refresh.js';
import { localCopyOf, needsStaging } from '../auto/staging.js';
import { importApiCsv } from '../ingest/apiCsv.js';
import { isApiCsv } from '../auto/discover.js';
import { proposeRegistry } from '../archive/inventory.js';
import { installAgent, uninstallAgent, agentStatus } from '../auto/install.js';
import { backfillAllThreads } from '../ingest/backfill.js';
import { setPassword, loadAuth, authPath } from '../server/auth.js';
import { backupDb, listBackups } from '../backup/backup.js';

const DB_PATH = process.env.IG_DB ?? 'data/instagram.db';

/**
 * Where to listen. Loopback unless IG_HOST asks for more — and then only with a
 * password set, because this serves the full social graph and every DM. The
 * interlock is the point: it makes "expose it" and "protect it" the same step.
 */
function bindHost(): string {
  const want = process.env.IG_HOST;
  if (!want || want === '127.0.0.1' || want === 'localhost') return '127.0.0.1';
  if (!loadAuth()) {
    console.error(
      `Refusing to bind ${want} with no password set — that would publish your DM history\n` +
      'to anything that can reach this machine. Set one first:\n\n  npm run set-password\n');
    process.exit(1);
  }
  return want;
}
const [cmd, ...args] = process.argv.slice(2);
const now = () => Math.floor(Date.now() / 1000);
const date = (t: number | null) => (t === null ? '—' : new Date(t * 1000).toISOString().slice(0, 10));

switch (cmd) {
  case 'inventory': {
    // No path given: find the newest export yourself rather than making the
    // user go looking for it.
    let target = args[0];
    if (!target) {
      const { archives } = findInputs();
      if (!archives.length) {
        console.error('No Instagram export found in: ' + candidateDirs().join(', '));
        console.error('Request one from the app, or pass a path explicitly.');
        process.exit(1);
      }
      target = archives[0].path;
      console.log(`using ${target}`);
    }
    if (needsStaging(target)) {
      console.log('copying out of the cloud mount first (one-off; every read there is a network fetch)…');
    }
    target = localCopyOf(target);
    console.log('');
    const rows = await inventory(target);
    console.log(formatInventory(rows));
    console.log('\n' + proposeRegistry(rows));
    break;
  }

  case 'ingest': {
    if (!args[0]) {
      console.error('usage: ingest <archive.zip | ig-capture-*.json>');
      console.error('  (or run `npm run auto` to find and ingest everything automatically)');
      process.exit(1);
    }
    const db = openDb(DB_PATH);

    if (/\.csv$/i.test(args[0])) {
      const r = importApiCsv(db, args[0]);
      console.log(`${r.kind}: ${r.summary}`);
      const linked = applyIdentities(db, resolveIdentities(db));
      if (linked) console.log(`  ${linked} DM thread(s) linked by display name`);
      break;
    }

    // Accept bookmarklet captures here too, not only through the watcher.
    if (isCaptureFile(args[0])) {
      const c = await ingestCapture(db, args[0]);
      console.log(c.skipped
        ? 'not a valid capture file'
        : `capture ${c.captureId}: ${c.rows} new inbound row(s)`);
      break;
    }

    const r = await ingestAndDerive(db, args[0]);
    console.log(r.skipped
      ? 'already ingested, nothing to do'
      : `snapshot ${r.snapshotId}: +${r.gained.length} followers, -${r.lost.length}`);
    break;
  }

  case 'report': {
    const db = openDb(DB_PATH);
    if (args[0] === 'lurkers') {
      for (const r of lurkGap(db, 25)) {
        console.log(`${r.username.padEnd(24)} ${String(r.views).padStart(6)} views  ${r.engagements} engagements`);
      }
      break;
    }
    const rows = unfollowers(db, now());
    if (rows.length === 0) { console.log('No unfollowers detected. Two snapshots are needed before this works.'); break; }
    for (const r of rows) {
      console.log(
        `${r.username.padEnd(24)} left ~${date(r.detectedAt)}  ` +
        `followed ${date(r.followedSince)} (${r.daysLasted ?? '—'}d)  ` +
        `myScore ${r.myScore.toFixed(1)}${r.iStillFollow ? '  [you still follow them]' : ''}`);
    }
    break;
  }

  case 'auto': {
    const db = openDb(DB_PATH);
    const dirs = args.length ? args : candidateDirs();
    console.log(`scanning: ${dirs.join(', ')}`);

    const r = await refreshAll(db, dirs);
    if (r.found === 0) {
      console.log('\nNothing found yet. Request an export from the Instagram app —');
      console.log('Settings > Accounts Center > Your information and permissions >');
      console.log('Download your information > All available information, JSON, All time.');
      break;
    }

    for (const a of r.archives) {
      console.log(a.skipped
        ? `  = ${a.name} (already ingested)`
        : `  + ${a.name}: +${a.gained} followers, -${a.lost.length}`);
    }
    for (const c of r.captures) {
      console.log(`  + ${c.name}: ${c.skipped ? 'invalid' : c.rows + ' inbound rows'}`);
    }

    const msg = unfollowerMessage(r.newUnfollowers);
    if (msg) notify('Instagram Tracker', msg);

    console.log('\n' + formatStatus(status(db, now())));
    break;
  }

  case 'install-agent': {
    console.log(installAgent(candidateDirs(), DB_PATH));
    break;
  }

  case 'uninstall-agent': {
    console.log(uninstallAgent());
    break;
  }

  case 'agent-status': {
    console.log(agentStatus());
    break;
  }

  case 'status': {
    console.log(formatStatus(status(openDb(DB_PATH), now())));
    break;
  }

  case 'set-password': {
    // Read from stdin, never argv: a command line is visible to every process
    // on this machine via `ps`, the same reason the scraper takes stdin.
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const ask = (q: string): Promise<string> => new Promise((res) => {
      // Hide the typing.
      const out = process.stdout as unknown as { write(s: string): boolean };
      const onData = () => { out.write('\x1b[2K\r' + q); };
      process.stdin.on('data', onData);
      rl.question(q, (a) => { process.stdin.off('data', onData); res(a); });
    });
    const pw = (await ask('New dashboard password: ')).trim();
    const again = (await ask('\nAgain: ')).trim();
    rl.close();
    process.stdout.write('\n');
    if (pw !== again) { console.error('They do not match. Nothing changed.'); process.exit(1); }
    try {
      setPassword(pw);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    console.log([
      `Password set. Stored as a scrypt hash in ${authPath()} (mode 0600), never in the repo.`,
      'Every page and every API route now needs it. Restart to apply:  npm run restart-agent',
    ].join('\n'));
    break;
  }

  case 'backup': {
    const b = backupDb(openDb(DB_PATH));
    console.log(b.path ? `Backed up to ${b.path}` : `Backup failed: ${b.reason}`);
    if (b.pruned.length) console.log(`  pruned ${b.pruned.length} older backup(s)`);
    const all = listBackups();
    for (const f of all) {
      console.log(`  ${f.name}  ${(f.size / 1048576).toFixed(1)} MB`);
    }
    if (!all.length) console.log('  (none yet)');
    break;
  }

  case 'backfill': {
    // Re-register DM threads for exports ingested before dm_thread existed.
    // Refresh does this on its own; the command is for doing it right now.
    const r = await backfillAllThreads(openDb(DB_PATH));
    console.log(`${r.archives} export(s) · ${r.threads} thread(s) registered · ${r.messages} message(s) stamped`);
    for (const m of r.missing) console.log(`  missing: ${m}`);
    break;
  }

  case 'daemon': {
    // Dashboard and watcher in one process, so a single LaunchAgent keeps both
    // alive. Running only the watcher meant the dashboard died with whatever
    // shell started it, and the site simply could not be reached.
    const port = Number(process.env.PORT ?? 4317);
    const dirs = args.length ? args : candidateDirs();
    const db = openDb(DB_PATH);

    const host = bindHost();
    const app = buildServer(db, { secureCookies: process.env.IG_HTTPS === '1' });
    await app.listen({ port, host });
    console.log(`dashboard on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
      + (loadAuth() ? '  (password required)' : '  (loopback only, no password set)'));
    console.log(`watching:\n  ${dirs.join('\n  ')}`);

    await watchFolder(db, dirs, ({ zipPath, lost, captured, linked }) => {
      console.log(`ingested ${zipPath}`);
      if (captured !== undefined) console.log(`  ${captured} inbound row(s) captured`);
      if (linked) console.log(`  ${linked} DM thread(s) linked to a profile`);
      if (lost.length) {
        console.log(`  ${lost.length} unfollower(s): ${lost.join(', ')}`);
        const msg = unfollowerMessage(lost);
        if (msg) notify('Instagram Tracker', msg);
      }
    });
    break;
  }

  case 'serve': {
    const port = Number(process.env.PORT ?? 4317);
    const host = bindHost();
    const app = buildServer(openDb(DB_PATH), { secureCookies: process.env.IG_HTTPS === '1' });
    await app.listen({ port, host });
    console.log(`dashboard on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`
      + (loadAuth() ? '  (password required)' : '  (loopback only, no password set)'));
    break;
  }

  case 'watch': {
    // No folders given: watch everywhere an export or capture plausibly lands.
    const dirs = args.length ? args : candidateDirs();
    if (!dirs.length) { console.error('usage: watch <folder...>'); process.exit(1); }
    const db = openDb(DB_PATH);
    console.log(`watching for exports and captures:\n  ${dirs.join('\n  ')}`);
    await watchFolder(db, dirs, ({ zipPath, lost, captured, linked }) => {
      console.log(`ingested ${zipPath}`);
      if (captured !== undefined) console.log(`  ${captured} inbound row(s) captured`);
      if (linked) console.log(`  ${linked} DM thread(s) linked to a profile`);
      if (lost.length) {
        console.log(`  ${lost.length} unfollower(s): ${lost.join(', ')}`);
        const msg = unfollowerMessage(lost);
        if (msg) notify('Instagram Tracker', msg);
      }
    });
    break;
  }

  default:
    console.error(`unknown command: ${cmd ?? '(none)'}`);
    console.error([
      'commands:',
      '  auto                     find and ingest everything, then show status',
      '  status                   where things stand',
      '  inventory [zip]          what is in an archive (finds the newest if omitted)',
      '  ingest <zip|capture>     ingest one file',
      '  report [unfollowers|lurkers]',
      '  backup                   snapshot the database and list existing backups',
      '  set-password             require a password for the dashboard (needed to expose it)',
      '  backfill                 register DM threads from exports ingested before that table existed',
      '  serve                    dashboard on 127.0.0.1',
      '  daemon                   dashboard + watcher together (what the agent runs)',
      '  watch <dir...>           ingest anything that lands, forever',
      '  install-agent            run the watcher at login, permanently',
      '  uninstall-agent          stop and remove it',
      '  agent-status             is the background agent running?',
    ].join('\n'));
    process.exit(1);
}
