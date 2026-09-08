import type { Db } from '../db/open.js';
import type { DiffResult } from './diff.js';
import type { RenameCandidate } from './rename.js';
import { accountId } from '../ingest/dbSink.js';

export function recordEvents(
  db: Db,
  snapshotId: number,
  diff: DiffResult,
  renames: RenameCandidate[],
): void {
  const at = Math.floor(Date.now() / 1000);
  const ins = db.prepare(
    `INSERT INTO graph_event (account_id, kind, snapshot_id, occurred_at, confidence)
     VALUES (?, ?, ?, ?, ?)`);

  const write = (users: string[], kind: string, confidence = 1.0) => {
    for (const u of users) ins.run(accountId(db, u), kind, snapshotId, at, confidence);
  };

  db.transaction(() => {
    write(diff.gainedFollowers, 'gained_follower');
    write(diff.lostFollowers, 'lost_follower');
    write(diff.iFollowed, 'i_followed');
    write(diff.iUnfollowed, 'i_unfollowed');

    for (const r of renames) {
      const oldId = accountId(db, r.from);
      const newId = accountId(db, r.to);
      ins.run(newId, 'probable_rename', snapshotId, at, r.confidence);
      db.prepare('UPDATE account SET merged_into = ? WHERE id = ?').run(newId, oldId);
    }
  })();
}
