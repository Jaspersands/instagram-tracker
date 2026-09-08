export type CaptureKind = 'post_likes' | 'post_comments' | 'story_viewers';

export interface CaptureItem { username: string; text: string | null }
export interface ParsedCapture {
  kind: CaptureKind;
  permalink: string | null;
  capturedAt: number;
  items: CaptureItem[];
}

/** post_likes -> like_received, etc. These land as interaction.direction = 'in'. */
export const CAPTURE_KIND_MAP: Record<CaptureKind, string> = {
  post_likes: 'like_received',
  post_comments: 'comment_received',
  story_viewers: 'story_view',
};

export function isCaptureFile(path: string): boolean {
  return /(^|\/)ig-capture-[^/]*\.json$/i.test(path);
}

export function parseCapture(json: unknown): ParsedCapture | null {
  if (!json || typeof json !== 'object') return null;
  const c = json as Record<string, unknown>;
  if (c.v !== 1) return null;

  const kind = c.kind as CaptureKind;
  if (!(typeof kind === 'string' && kind in CAPTURE_KIND_MAP)) return null;
  if (!Array.isArray(c.items)) return null;

  const items: CaptureItem[] = [];
  for (const raw of c.items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const username = typeof it.username === 'string' ? it.username.trim().toLowerCase() : '';
    if (!username) continue;
    items.push({ username, text: typeof it.text === 'string' ? it.text : null });
  }

  return {
    kind,
    permalink: typeof c.permalink === 'string' ? c.permalink : null,
    capturedAt: typeof c.capturedAt === 'number' ? c.capturedAt : Math.floor(Date.now() / 1000),
    items,
  };
}
