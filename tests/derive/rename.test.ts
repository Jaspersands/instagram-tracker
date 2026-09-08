import { describe, it, expect } from 'vitest';
import { detectRenames, applyRenames } from '../../src/derive/rename.js';
import type { FollowState } from '../../src/derive/diff.js';
import { diffFollowState } from '../../src/derive/diff.js';

const st = (pairs: [string, number][]): FollowState => ({
  followsMe: new Map(pairs), iFollow: new Map(),
});

describe('detectRenames', () => {
  it('pairs a loss and a gain sharing an exact follow timestamp', () => {
    const prev = st([['oldname', 1700], ['stable', 100]]);
    const next = st([['newname', 1700], ['stable', 100]]);
    const r = detectRenames(diffFollowState(prev, next), prev, next);
    expect(r).toEqual([{ from: 'oldname', to: 'newname', since: 1700, confidence: 0.9 }]);
  });

  it('refuses to guess when the pairing is ambiguous', () => {
    const prev = st([['old1', 1700], ['old2', 1700]]);
    const next = st([['new1', 1700], ['new2', 1700]]);
    expect(detectRenames(diffFollowState(prev, next), prev, next)).toEqual([]);
  });

  it('does not pair a loss and gain with different timestamps', () => {
    const prev = st([['gone', 1700]]);
    const next = st([['arrived', 1800]]);
    expect(detectRenames(diffFollowState(prev, next), prev, next)).toEqual([]);
  });

  it('ignores null timestamps rather than matching them to each other', () => {
    const prev: FollowState = { followsMe: new Map([['a', null]]), iFollow: new Map() };
    const next: FollowState = { followsMe: new Map([['b', null]]), iFollow: new Map() };
    expect(detectRenames(diffFollowState(prev, next), prev, next)).toEqual([]);
  });
});

describe('applyRenames', () => {
  it('removes renamed pairs from both gained and lost', () => {
    const diff = {
      gainedFollowers: ['newname', 'realnew'],
      lostFollowers: ['oldname', 'realloss'],
      iFollowed: [], iUnfollowed: [],
    };
    const out = applyRenames(diff, [{ from: 'oldname', to: 'newname', since: 1, confidence: 0.9 }]);
    expect(out.gainedFollowers).toEqual(['realnew']);
    expect(out.lostFollowers).toEqual(['realloss']);
  });
});
