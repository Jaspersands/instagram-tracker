export type UsernameSource = 'title' | 'value';

export interface NormalizedEntry {
  username: string;
  href: string | null;
  timestamp: number | null;
  value: string | null;
}

/**
 * Instagram export files are either a bare array of items, or an object with a
 * single array-valued key whose name varies per file (relationships_followers,
 * likes_media_likes, ...). Unwrap both without hardcoding the key name.
 */
export function collectItems(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json === null || typeof json !== 'object') return [];
  for (const v of Object.values(json as Record<string, unknown>)) {
    if (Array.isArray(v)) return v;
  }
  return [];
}

/**
 * Normalize one raw item. Returns null when no username can be resolved, so
 * callers can skip junk without exception handling. parseArchive streams items
 * one at a time and calls this directly.
 */
export function normalizeEntry(
  raw: unknown,
  usernameFrom: UsernameSource,
): NormalizedEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;

  const sld = Array.isArray(item.string_list_data)
    ? (item.string_list_data[0] as Record<string, unknown> | undefined)
    : undefined;

  const title = typeof item.title === 'string' ? item.title : null;
  const value = sld && typeof sld.value === 'string' ? sld.value : null;
  const href = sld && typeof sld.href === 'string' ? sld.href : null;
  const timestamp = sld && typeof sld.timestamp === 'number' ? sld.timestamp : null;

  const username = (usernameFrom === 'title' ? title : value)?.trim().toLowerCase();
  if (!username) return null;

  return { username, href, timestamp, value };
}

export function normalizeEntries(
  json: unknown,
  usernameFrom: UsernameSource,
): NormalizedEntry[] {
  const out: NormalizedEntry[] = [];
  for (const raw of collectItems(json)) {
    const e = normalizeEntry(raw, usernameFrom);
    if (e) out.push(e);
  }
  return out;
}
