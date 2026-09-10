import { describe, it, expect } from 'vitest';
import { parseCsv } from '../../src/parse/csv.js';

describe('parseCsv', () => {
  it('reads a simple table', () => {
    expect(parseCsv('a,b\n1,2\n3,4\n')).toEqual([
      { a: '1', b: '2' }, { a: '3', b: '4' },
    ]);
  });

  it('keeps commas inside quoted fields', () => {
    // A display name like "Sands, Kate" would otherwise shift every column.
    expect(parseCsv('username,full_name\nks,"Sands, Kate"\n')).toEqual([
      { username: 'ks', full_name: 'Sands, Kate' },
    ]);
  });

  it('handles escaped quotes and newlines inside fields', () => {
    expect(parseCsv('a,b\n1,"say ""hi"""\n')).toEqual([{ a: '1', b: 'say "hi"' }]);
    expect(parseCsv('a,b\n1,"two\nlines"\n')[0].b).toBe('two\nlines');
  });

  it('tolerates a missing trailing newline and blank lines', () => {
    expect(parseCsv('a,b\n1,2')).toEqual([{ a: '1', b: '2' }]);
    expect(parseCsv('a,b\n1,2\n\n3,4\n')).toHaveLength(2);
  });

  it('returns nothing for an empty file', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b\n')).toEqual([]);
  });
});
