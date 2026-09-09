import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';
import { normalizeDisplayName, resolveIdentities, applyIdentities } from '../../src/derive/identity.js';

function db() {
  const d = openDb(':memory:');
  d.exec(`INSERT INTO snapshot (ingested_at, source, sha256) VALUES (1,'export','x')`);
  return d;
}
const addAccount = (d: any, username: string, displayName: string | null = null) =>
  d.prepare('INSERT INTO account (username, display_name) VALUES (?,?)').run(username, displayName);
const addDm = (d: any, username: string, n = 1) => {
  const id = (d.prepare('SELECT id FROM account WHERE username=?').get(username) as any).id;
  for (let i = 0; i < n; i++) {
    d.prepare(`INSERT INTO interaction (account_id, kind, direction, occurred_at, dedupe_key)
               VALUES (?,'dm','out',?,?)`).run(id, 1000 + i, `${username}-${i}`);
  }
};

describe('normalizeDisplayName', () => {
  it('reproduces how Instagram names a thread folder', () => {
    // Both verified against real thread folders in a September 2026 export.
    expect(normalizeDisplayName('Marcus')).toBe('marcus');
    expect(normalizeDisplayName('Harriet Vale')).toBe('harrietvale');
  });

  it('keeps accented letters rather than deleting them', () => {
    // Dropping the letter outright would turn José into "jos" and never match.
    expect(normalizeDisplayName('José Núñez-Ruiz')).toBe('josenunezruiz');
    expect(normalizeDisplayName('Zoë')).toBe('zoe');
  });
});

describe('resolveIdentities', () => {
  it('links a DM thread to the account whose display name produced its folder name', () => {
    const d = db();
    addAccount(d, 'marcusdaley', 'Marcus');   // real account, from a captured list
    addAccount(d, 'marcus');                  // placeholder from inbox/marcus_612189326440592
    addDm(d, 'marcus', 3);

    const r = resolveIdentities(d);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ threadUsername: 'marcus', realUsername: 'marcusdaley' });
  });

  it('refuses to guess when two people share a display name', () => {
    const d = db();
    addAccount(d, 'marcusdaley', 'Marcus');
    addAccount(d, 'marcusotherguy', 'Marcus');
    addAccount(d, 'marcus');
    addDm(d, 'marcus');
    // Merging the wrong one attributes private messages to a stranger.
    expect(resolveIdentities(d)).toEqual([]);
  });

  it('leaves alone a thread whose folder name is already the username', () => {
    const d = db();
    addAccount(d, 'harrietvale', 'Harriet Vale');
    addDm(d, 'harrietvale');
    expect(resolveIdentities(d)).toEqual([]);
  });

  it('ignores accounts that have no DMs', () => {
    const d = db();
    addAccount(d, 'marcusdaley', 'Marcus');
    addAccount(d, 'marcus');
    expect(resolveIdentities(d)).toEqual([]);
  });

  it('applying a link routes the thread onto the real account', () => {
    const d = db();
    addAccount(d, 'marcusdaley', 'Marcus');
    addAccount(d, 'marcus');
    addDm(d, 'marcus', 2);

    expect(applyIdentities(d, resolveIdentities(d))).toBe(1);
    const row = d.prepare('SELECT merged_into FROM account WHERE username=?').get('marcus') as any;
    const real = d.prepare('SELECT id FROM account WHERE username=?').get('marcusdaley') as any;
    expect(row.merged_into).toBe(real.id);
  });
});
