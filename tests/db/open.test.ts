import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db/open.js';

describe('openDb', () => {
  it('creates every table on a fresh database', () => {
    const db = openDb(':memory:');
    const names = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r: any) => r.name);

    for (const t of [
      'snapshot', 'account', 'follow_edge', 'graph_event',
      'interaction', 'impression', 'list_membership',
      'my_post', 'topic', 'search_event', 'inbound_capture',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('is safe to open twice', () => {
    const db = openDb(':memory:');
    expect(() => openDb(':memory:')).not.toThrow();
    db.close();
  });
});
