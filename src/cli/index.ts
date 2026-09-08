import { inventory, formatInventory } from '../archive/inventory.js';
import { openDb } from '../db/open.js';
import { ingestAndDerive } from '../ingest/pipeline.js';
import { unfollowers, lurkGap } from '../report/reports.js';
import { watchFolder } from '../watch/watcher.js';

const DB_PATH = process.env.IG_DB ?? 'data/instagram.db';
const [cmd, ...args] = process.argv.slice(2);
const now = () => Math.floor(Date.now() / 1000);
const date = (t: number | null) => (t === null ? '—' : new Date(t * 1000).toISOString().slice(0, 10));

switch (cmd) {
  case 'inventory': {
    if (!args[0]) { console.error('usage: inventory <archive.zip>'); process.exit(1); }
    console.log(formatInventory(await inventory(args[0])));
    break;
  }

  case 'ingest': {
    if (!args[0]) { console.error('usage: ingest <archive.zip>'); process.exit(1); }
    const r = await ingestAndDerive(openDb(DB_PATH), args[0]);
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

  case 'watch': {
    const dir = args[0];
    if (!dir) { console.error('usage: watch <folder>'); process.exit(1); }
    const db = openDb(DB_PATH);
    console.log(`watching ${dir} for exports…`);
    await watchFolder(db, dir, ({ zipPath, lost }) => {
      console.log(`ingested ${zipPath}`);
      if (lost.length) console.log(`  ${lost.length} unfollower(s): ${lost.join(', ')}`);
    });
    break;
  }

  default:
    console.error(`unknown command: ${cmd ?? '(none)'}`);
    console.error('commands: inventory <zip> | ingest <zip> | report [unfollowers|lurkers] | watch <dir>');
    process.exit(1);
}
