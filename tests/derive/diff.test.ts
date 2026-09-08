import { describe, it, expect } from 'vitest';
import { diffFollowState, loadFollowState, previousSnapshotId } from '../../src/derive/diff.js';
import type { FollowState } from '../../src/derive/diff.js';
import { openDb } from '../../src/db/open.js';
import { ingestArchive } from '../../src/ingest/ingest.js';
import { makeZip } from '../helpers/makeZip.js';

const state = (followsMe: string[], iFollow: string[] = []): FollowState => ({
  followsMe: new Map(followsMe.map((u) => [u, 1])),
  iFollow: new Map(iFollow.map((u) => [u, 1])),
});

describe('diffFollowState', () => {
  it('reports nothing when nothing changed', () => {
    const d = diffFollowState(state(['a', 'b']), state(['a', 'b']));
    expect(d).toEqual({ gainedFollowers: [], lostFollowers: [], iFollowed: [], iUnfollowed: [] });
  });

  it('detects a pure gain', () => {
    expect(diffFollowState(state(['a']), state(['a', 'b'])).gainedFollowers).toEqual(['b']);
  });

  it('detects a pure loss — the headline feature', () => {
    expect(diffFollowState(state(['a', 'b']), state(['a'])).lostFollowers).toEqual(['b']);
  });

  it('detects a simultaneous add and remove', () => {
    const d = diffFollowState(state(['a', 'b']), state(['a', 'c']));
    expect(d.lostFollowers).toEqual(['b']);
    expect(d.gainedFollowers).toEqual(['c']);
  });

  it('tracks my own following changes independently', () => {
    const d = diffFollowState(state([], ['x', 'y']), state([], ['y', 'z']));
    expect(d.iUnfollowed).toEqual(['x']);
    expect(d.iFollowed).toEqual(['z']);
    expect(d.lostFollowers).toEqual([]);
  });

  it('treats an empty previous state as all-new, not as churn', () => {
    const d = diffFollowState(state([]), state(['a', 'b']));
    expect(d.gainedFollowers.sort()).toEqual(['a', 'b']);
    expect(d.lostFollowers).toEqual([]);
  });
});

describe('loadFollowState / previousSnapshotId', () => {
  it('round-trips through the database', async () => {
    const db = openDb(':memory:');
    const { snapshotId: s1 } = await ingestArchive(db, makeZip({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [
          { title: '', string_list_data: [{ href: 'h', value: 'alice', timestamp: 100 }] },
          { title: '', string_list_data: [{ href: 'h', value: 'bob', timestamp: 200 }] },
        ],
      },
    }));
    const { snapshotId: s2 } = await ingestArchive(db, makeZip({
      'connections/followers_and_following/followers_1.json': {
        relationships_followers: [
          { title: '', string_list_data: [{ href: 'h', value: 'alice', timestamp: 100 }] },
        ],
      },
    }));

    expect(previousSnapshotId(db, s2)).toBe(s1);
    const d = diffFollowState(loadFollowState(db, s1), loadFollowState(db, s2));
    expect(d.lostFollowers).toEqual(['bob']);
  });

  it('returns null for the first snapshot, which has no baseline', async () => {
    const db = openDb(':memory:');
    const { snapshotId } = await ingestArchive(db, makeZip({ 'x.json': { a: [] } }));
    expect(previousSnapshotId(db, snapshotId)).toBeNull();
  });
});
