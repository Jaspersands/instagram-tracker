import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { ingestAndDerive } from '../../src/ingest/pipeline.js';
import { status, formatStatus } from '../../src/report/status.js';
import { makeZip } from '../helpers/makeZip.js';

const NOW = 1_800_000_000;
const DAY = 86400;
const f = (v: string, ts: number) =>
  ({ title: '', string_list_data: [{ href: 'h', value: v, timestamp: ts }] });
const archive = (name: string, users: string[]) => {
  const zip = makeZip({
    'connections/followers_and_following/followers_1.json':
      { relationships_followers: users.map((u, i) => f(u, 100 + i)) },
  });
  return { zip, name };
};

describe('status', () => {
  it('tells you nothing is ingested yet', () => {
    const s = status(openDb(':memory:'), NOW);
    expect(s.snapshots).toBe(0);
    expect(s.lastExport).toBeNull();
    expect(s.warnings.join(' ')).toMatch(/no exports/i);
  });

  it('warns that unfollower detection needs a second export', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, archive('a', ['alice']).zip);
    const s = status(db, NOW);
    expect(s.snapshots).toBe(1);
    expect(s.warnings.join(' ')).toMatch(/second export/i);
  });

  it('stops warning about a second export once there are two', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, archive('a', ['alice', 'bob']).zip);
    await ingestAndDerive(db, archive('b', ['alice']).zip);
    const s = status(db, NOW);
    expect(s.snapshots).toBe(2);
    expect(s.warnings.join(' ')).not.toMatch(/second export/i);
  });

  it('nudges when the last export is stale', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, archive('a', ['alice']).zip);
    db.prepare('UPDATE snapshot SET taken_at = ?').run(NOW - 45 * DAY);
    const s = status(db, NOW);
    expect(s.daysSinceExport).toBe(45);
    expect(s.warnings.join(' ')).toMatch(/45 days/);
  });

  it('does not nudge when the export is recent', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, archive('a', ['alice']).zip);
    db.prepare('UPDATE snapshot SET taken_at = ?').run(NOW - 3 * DAY);
    expect(status(db, NOW).warnings.join(' ')).not.toMatch(/days ago/);
  });

  it('mentions that inbound engagement is unmeasured with no captures', async () => {
    const db = openDb(':memory:');
    await ingestAndDerive(db, archive('a', ['alice']).zip);
    expect(status(db, NOW).warnings.join(' ')).toMatch(/captur/i);
  });

  it('formats without throwing on an empty database', () => {
    expect(() => formatStatus(status(openDb(':memory:'), NOW))).not.toThrow();
  });
});
