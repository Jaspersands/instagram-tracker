/**
 * Did a snapshot lose an implausible share of followers?
 *
 * Two ways this happens and neither is a real mass unfollowing: an export that
 * is incremental rather than a full snapshot (Instagram's scheduled transfers
 * warn that they "include information that wasn't in the last export"), or an
 * archive that is not an Instagram export at all. Both look identical to the
 * diff engine — the followers are simply absent — and both would otherwise
 * produce a notification naming a thousand people who never left.
 *
 * Requires both a large proportion and real volume, so a small account losing
 * one of three followers is still reported normally.
 */
const COLLAPSE_RATIO = 0.5;
const MIN_VOLUME = 25;

export function looksIncomplete(previousFollowers: number, currentFollowers: number): boolean {
  if (previousFollowers < MIN_VOLUME) return false;
  if (currentFollowers >= previousFollowers) return false;
  const lost = previousFollowers - currentFollowers;
  return lost / previousFollowers > COLLAPSE_RATIO;
}
