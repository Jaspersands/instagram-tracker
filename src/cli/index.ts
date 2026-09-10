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

const DB_PATH = process.env.IG_DB ?? 'data/instagram.db';
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

  case 'daemon': {
    // Dashboard and watcher in one process, so a single LaunchAgent keeps both
    // alive. Running only the watcher meant the dashboard died with whatever
    // shell started it, and the site simply could not be reached.
    const port = Number(process.env.PORT ?? 4317);
    const dirs = args.length ? args : candidateDirs();
    const db = openDb(DB_PATH);

    const app = buildServer(db);
    await app.listen({ port, host: '127.0.0.1' });
    console.log(`dashboard on http://127.0.0.1:${port}`);
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
    const app = buildServer(openDb(DB_PATH));
    // Loopback only: this serves your DM history and full social graph.
    await app.listen({ port, host: '127.0.0.1' });
    console.log(`dashboard on http://127.0.0.1:${port}`);
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
      '  serve                    dashboard on 127.0.0.1',
      '  daemon                   dashboard + watcher together (what the agent runs)',
      '  watch <dir...>           ingest anything that lands, forever',
      '  install-agent            run the watcher at login, permanently',
      '  uninstall-agent          stop and remove it',
      '  agent-status             is the background agent running?',
    ].join('\n'));
    process.exit(1);
}
