import { describe, it, expect } from 'vitest';
import { decayedScore, WEIGHTS, DECAY_DAYS } from '../../src/derive/score.js';

const DAY = 86400;
const NOW = 1_800_000_000;

describe('decayedScore', () => {
  it('is zero with no interactions', () => {
    expect(decayedScore([], NOW)).toBe(0);
  });

  it('weights a DM above a like', () => {
    const dm = decayedScore([{ kind: 'dm', occurredAt: NOW }], NOW);
    const like = decayedScore([{ kind: 'like_post', occurredAt: NOW }], NOW);
    expect(dm).toBeGreaterThan(like);
    expect(dm).toBeCloseTo(WEIGHTS.dm, 5);
  });

  it('decays with age', () => {
    const fresh = decayedScore([{ kind: 'like_post', occurredAt: NOW }], NOW);
    const old = decayedScore([{ kind: 'like_post', occurredAt: NOW - 180 * DAY }], NOW);
    expect(old).toBeLessThan(fresh);
    expect(old).toBeGreaterThan(0);
  });

  it('decays by exactly 1/e at the decay constant', () => {
    const s = decayedScore([{ kind: 'like_post', occurredAt: NOW - DECAY_DAYS * DAY }], NOW);
    expect(s).toBeCloseTo(WEIGHTS.like_post * Math.exp(-1), 5);
  });

  it('ignores unknown kinds instead of throwing', () => {
    expect(decayedScore([{ kind: 'nonsense', occurredAt: NOW }], NOW)).toBe(0);
  });

  it('skips rows with no timestamp', () => {
    expect(decayedScore([{ kind: 'dm', occurredAt: null }], NOW)).toBe(0);
  });

  it('sums many interactions', () => {
    const rows = Array.from({ length: 10 }, () => ({ kind: 'like_post', occurredAt: NOW }));
    expect(decayedScore(rows, NOW)).toBeCloseTo(10 * WEIGHTS.like_post, 5);
  });
});
