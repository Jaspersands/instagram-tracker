import { describe, it, expect } from 'vitest';
import { labelValue, labelTimestamp, labelUsername } from '../../src/parse/labels.js';

// Shape taken verbatim from a real export.
const unfollowed = {
  timestamp: 1788867376,
  media: [],
  label_values: [
    { label: 'URL', value: 'http://known.com/try' },
    { label: 'Name', value: 'Known' },
    { label: 'Username', value: 'Known' },
  ],
  fbid: '17841408362423274',
};

describe('label_values extraction', () => {
  it('finds a labelled value', () => {
    expect(labelValue(unfollowed, 'Username')).toBe('Known');
    expect(labelValue(unfollowed, 'Name')).toBe('Known');
  });

  it('returns null for a missing label or malformed item', () => {
    expect(labelValue(unfollowed, 'Nope')).toBeNull();
    expect(labelValue(null, 'Username')).toBeNull();
    expect(labelValue({}, 'Username')).toBeNull();
    expect(labelValue({ label_values: 'nope' }, 'Username')).toBeNull();
  });

  it('reads the top-level timestamp', () => {
    expect(labelTimestamp(unfollowed)).toBe(1788867376);
    expect(labelTimestamp({})).toBeNull();
  });

  it('lowercases the username', () => {
    expect(labelUsername(unfollowed)).toBe('known');
  });

  it('returns null when there is no Username label at all', () => {
    // stories_viewed and polls carry only URL/Caption/Title — not attributable.
    expect(labelUsername({ timestamp: 1, label_values: [{ label: 'Caption', value: 'x' }] })).toBeNull();
  });
});
