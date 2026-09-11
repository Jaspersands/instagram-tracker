/**
 * Instagram's stand-in for a deleted or deactivated account. It appears as the
 * display name "Instagram User" in DM folders and as a liker, and 99 dead
 * threads collapsed into one "person" with 2,315 messages here. It is not a
 * person and must never be ranked, matched, or merged into anyone.
 */
export function isTombstone(username: string | null | undefined): boolean {
  if (!username) return false;
  return username.trim().toLowerCase().replace(/[\s._-]/g, '') === 'instagramuser';
}
