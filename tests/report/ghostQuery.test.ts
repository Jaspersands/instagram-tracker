import { describe, it, expect } from 'vitest';
import { openDb, type Db } from '../../src/db/open.js';
import { inbound } from '../../src/report/queries.js';

const NOW = 1_800_000_000;

/**
 * Build the graph directly. The ghost query was rewritten for speed (6.7s to
 * 6ms), and these pin the semantics that rewrite had to preserve — especially
 * the merged-account case, which is the part a naive rewrite loses.
 */
function graph(): Db {
  const db = openDb(':memory:');
  db.exec("INSERT INTO snapshot (id, taken_at, ingested_at, source, sha256)\n"
          + "          VALUES (1, 1800000000, 1800000000, 'test', 'sha-ghost-test')");
  const acct = db.prepare('INSERT INTO account (username) VALUES (?)');
  const edge = db.prepare(
    `INSERT INTO follow_edge (snapshot_id, account_id, direction, since)
     VALUES (1, ?, 'follows_me', ?)`);
  const inter = db.prepare(
    `INSERT INTO interaction (account_id, kind, direction, occurred_at, dedupe_key)
     VALUES (?, ?, ?, ?, ?)`);

  const id = (u: string) => Number(acct.run(u).lastInsertRowid);
  const engaged = id('engaged');
  const quiet = id('quiet');
  const outboundOnly = id('outbound_only');
  const oldname = id('oldname');
  const newname = id('newname');

  for (const a of [engaged, quiet, outboundOnly, newname]) edge.run(a, 1000);
  // A complete capture is what licenses the ghost claim at all.
  db.exec(`INSERT INTO inbound_capture (captured_at, kind, permalink, complete, expected, raw_json)
           VALUES (${NOW}, 'post_likes', 'https://ig/p/A/', 1, 1, '{}')`);

  inter.run(engaged, 'like_received', 'in', NOW - 100, 'k1');
  // Outbound only: I liked them, they never touched me. Still a ghost.
  inter.run(outboundOnly, 'like', 'out', NOW - 100, 'k2');
  // The person renamed; their inbound history sits on the dead username.
  inter.run(oldname, 'like_received', 'in', NOW - 200, 'k3');
  db.prepare('UPDATE account SET merged_into = ? WHERE id = ?').run(newname, oldname);
  return db;
}

describe('ghost detection after the query rewrite', () => {
  const names = () => inbound(graph(), NOW).ghosts.map((g) => g.username);

  it('names a follower with no inbound interaction', () => {
    expect(names()).toContain('quiet');
  });

  it('does not count your own outbound engagement as theirs', () => {
    expect(names()).toContain('outbound_only');
  });

  it('spares a follower who has engaged', () => {
    expect(names()).not.toContain('engaged');
  });

  it('follows a merge, so a renamed account keeps its history', () => {
    // This is the case the fast rewrite had to keep: the inbound interaction is
    // recorded against 'oldname', which is merged into the follower 'newname'.
    expect(names()).not.toContain('newname');
    expect(names()).not.toContain('oldname');
  });

  it('answers quickly enough to render inline', () => {
    const db = graph();
    const t = Date.now();
    inbound(db, NOW);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});
