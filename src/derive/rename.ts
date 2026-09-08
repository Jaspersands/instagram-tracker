import type { DiffResult, FollowState } from './diff.js';

export interface RenameCandidate {
  from: string;
  to: string;
  since: number;
  confidence: number;
}

function byTimestamp(names: string[], state: Map<string, number | null>) {
  const buckets = new Map<number, string[]>();
  for (const n of names) {
    const ts = state.get(n);
    if (ts === null || ts === undefined) continue;   // null timestamps carry no signal
    const list = buckets.get(ts) ?? [];
    list.push(n);
    buckets.set(ts, list);
  }
  return buckets;
}

export function detectRenames(
  diff: DiffResult,
  prev: FollowState,
  next: FollowState,
): RenameCandidate[] {
  const lost = byTimestamp(diff.lostFollowers, prev.followsMe);
  const gained = byTimestamp(diff.gainedFollowers, next.followsMe);

  const out: RenameCandidate[] = [];
  for (const [ts, lostNames] of lost) {
    const gainedNames = gained.get(ts);
    // Only an unambiguous 1:1 match is safe. A wrong merge is worse than a miss.
    if (!gainedNames || lostNames.length !== 1 || gainedNames.length !== 1) continue;
    out.push({ from: lostNames[0], to: gainedNames[0], since: ts, confidence: 0.9 });
  }
  return out;
}

export function applyRenames(diff: DiffResult, renames: RenameCandidate[]): DiffResult {
  const from = new Set(renames.map((r) => r.from));
  const to = new Set(renames.map((r) => r.to));
  return {
    ...diff,
    lostFollowers: diff.lostFollowers.filter((u) => !from.has(u)),
    gainedFollowers: diff.gainedFollowers.filter((u) => !to.has(u)),
  };
}
