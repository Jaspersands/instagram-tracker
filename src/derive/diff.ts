import type { Db } from '../db/open.js';

export interface FollowState {
  followsMe: Map<string, number | null>;
  iFollow: Map<string, number | null>;
}

export interface DiffResult {
  gainedFollowers: string[];
  lostFollowers: string[];
  iFollowed: string[];
  iUnfollowed: string[];
}

const added = (prev: Map<string, unknown>, next: Map<string, unknown>) =>
  [...next.keys()].filter((k) => !prev.has(k)).sort();

const removed = (prev: Map<string, unknown>, next: Map<string, unknown>) =>
  [...prev.keys()].filter((k) => !next.has(k)).sort();

export function diffFollowState(prev: FollowState, next: FollowState): DiffResult {
  return {
    gainedFollowers: added(prev.followsMe, next.followsMe),
    lostFollowers: removed(prev.followsMe, next.followsMe),
    iFollowed: added(prev.iFollow, next.iFollow),
    iUnfollowed: removed(prev.iFollow, next.iFollow),
  };
}

export function loadFollowState(db: Db, snapshotId: number): FollowState {
  const rows = db.prepare(
    `SELECT a.username AS username, e.direction AS direction, e.since AS since
       FROM follow_edge e JOIN account a ON a.id = e.account_id
      WHERE e.snapshot_id = ?`,
  ).all(snapshotId) as { username: string; direction: string; since: number | null }[];

  const state: FollowState = { followsMe: new Map(), iFollow: new Map() };
  for (const r of rows) {
    (r.direction === 'follows_me' ? state.followsMe : state.iFollow).set(r.username, r.since);
  }
  return state;
}

export function previousSnapshotId(db: Db, snapshotId: number): number | null {
  const row = db.prepare(
    `SELECT id FROM snapshot WHERE id < ? ORDER BY id DESC LIMIT 1`,
  ).get(snapshotId) as { id: number } | undefined;
  return row?.id ?? null;
}
