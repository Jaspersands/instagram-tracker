/**
 * A third shape in the export, alongside string_list_data and string_map_data:
 * a bare array of items carrying a top-level `timestamp` and a `label_values`
 * list of {label, value} pairs.
 *
 *   {"timestamp":1788867376,"label_values":[{"label":"Username","value":"known"}]}
 *
 * Used by recently_unfollowed_profiles and suggested_profiles_viewed, among
 * others. Only some of these carry a Username — stories_viewed and polls do
 * not, so they cannot be attributed to a person at all.
 */
export function labelValue(item: unknown, label: string): string | null {
  if (!item || typeof item !== 'object') return null;
  const lv = (item as Record<string, unknown>).label_values;
  if (!Array.isArray(lv)) return null;
  for (const raw of lv) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    if (e.label === label && typeof e.value === 'string') return e.value;
  }
  return null;
}

export function labelTimestamp(item: unknown): number | null {
  if (!item || typeof item !== 'object') return null;
  const t = (item as Record<string, unknown>).timestamp;
  return typeof t === 'number' ? t : null;
}

export function labelUsername(item: unknown): string | null {
  const u = labelValue(item, 'Username');
  return u ? u.trim().toLowerCase() : null;
}

/**
 * A story URL carries the author: instagram.com/stories/<username>/<id>.
 * This is the only surviving attribution for story likes now that the file has
 * moved to label_values — post and reel URLs are just shortcodes with no author
 * anywhere in the record.
 */
export function usernameFromStoryUrl(url: string | null): string | null {
  if (!url) return null;
  const m = /instagram\.com\/stories\/([A-Za-z0-9._]+)\//.exec(url);
  return m ? m[1].toLowerCase() : null;
}

/** The post/reel permalink, for records that carry one. */
export function labelUrl(item: unknown): string | null {
  return labelValue(item, 'URL');
}

/**
 * Some records nest their labels inside grouped dicts, e.g. note_and_repost
 * carries the person under an "Author" group two levels down:
 *   label_values: [{ title: 'Author', dict: [{ dict: [{label:'Username', ...}] }] }]
 * A flat scan misses them entirely.
 */
export function labelValueDeep(node: unknown, label: string, depth = 0): string | null {
  if (depth > 6 || !node || typeof node !== 'object') return null;

  if (Array.isArray(node)) {
    for (const child of node) {
      const found = labelValueDeep(child, label, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const o = node as Record<string, unknown>;
  if (o.label === label && typeof o.value === 'string') return o.value;

  for (const key of ['label_values', 'dict']) {
    const found = labelValueDeep(o[key], label, depth + 1);
    if (found) return found;
  }
  return null;
}
