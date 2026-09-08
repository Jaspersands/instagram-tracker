import { describe, it, expect } from 'vitest';
import { inventory, formatInventory } from '../../src/archive/inventory.js';
import { makeZip } from '../helpers/makeZip.js';

describe('inventory', () => {
  it('reports counts, matched source ids and sample keys', async () => {
    const zip = makeZip({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [
          { title: '', string_list_data: [{ href: 'h', value: 'alice', timestamp: 1 }] },
        ],
      },
      'unknown/mystery_file.json': { mystery: [{ a: 1 }, { a: 2 }] },
    });

    const rows = await inventory(zip);
    const followers = rows.find((r) => r.path.endsWith('followers_1.json'))!;
    const mystery = rows.find((r) => r.path.endsWith('mystery_file.json'))!;

    expect(followers.count).toBe(1);
    expect(followers.sourceId).toBe('followers');
    expect(followers.sampleKeys).toContain('string_list_data');

    // The whole point: unrecognised files are surfaced, not silently dropped.
    expect(mystery.count).toBe(2);
    expect(mystery.sourceId).toBeNull();
  });

  it('renders unmatched files so they are visible in the report', async () => {
    const zip = makeZip({ 'unknown/mystery_file.json': { mystery: [{ a: 1 }] } });
    const text = formatInventory(await inventory(zip));
    expect(text).toContain('mystery_file.json');
    expect(text).toMatch(/UNMATCHED/i);
  });
});
