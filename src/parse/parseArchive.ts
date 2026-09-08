import { eachJsonEntry } from '../archive/reader.js';
import { matchSource } from './registry.js';
import { normalizeEntry } from './entries.js';

export interface FollowEdgeRow { username: string; direction: 'follows_me' | 'i_follow'; since: number | null }
export interface ListRow { username: string; list: string }
export interface InteractionRow { username: string; kind: string; direction: 'out' | 'in'; occurredAt: number | null; permalink: string | null }
export interface ImpressionRow { username: string; kind: string; occurredAt: number | null }
export interface FileRow { path: string; sourceId: string | null; count: number }

export interface RowSink {
  followEdge(r: FollowEdgeRow): void;
  list(r: ListRow): void;
  interaction(r: InteractionRow): void;
  impression(r: ImpressionRow): void;
  file(r: FileRow): void;
}

export async function parseArchive(zipPath: string, sink: RowSink): Promise<void> {
  await eachJsonEntry(zipPath, async (src) => {
    const def = matchSource(src.path);
    let count = 0;

    try {
      for await (const raw of src.items()) {
        if (!def) { count++; continue; }
        const e = normalizeEntry(raw, def.usernameFrom);
        if (!e) continue;
        count++;

        switch (def.target.kind) {
          case 'follow_edge':
            sink.followEdge({ username: e.username, direction: def.target.direction, since: e.timestamp });
            break;
          case 'list':
            sink.list({ username: e.username, list: def.target.list });
            break;
          case 'interaction':
            sink.interaction({
              username: e.username,
              kind: def.target.interactionKind,
              direction: def.target.direction,
              occurredAt: e.timestamp,
              permalink: e.href,
            });
            break;
          case 'impression':
            sink.impression({ username: e.username, kind: def.target.impressionKind, occurredAt: e.timestamp });
            break;
        }
      }
    } catch {
      // A single unreadable file must not abort the archive.
    }

    sink.file({ path: src.path, sourceId: def?.id ?? null, count });
  });
}

export function collectingSink() {
  const s = {
    followEdges: [] as FollowEdgeRow[],
    lists: [] as ListRow[],
    interactions: [] as InteractionRow[],
    impressions: [] as ImpressionRow[],
    files: [] as FileRow[],
    followEdge(r: FollowEdgeRow) { s.followEdges.push(r); },
    list(r: ListRow) { s.lists.push(r); },
    interaction(r: InteractionRow) { s.interactions.push(r); },
    impression(r: ImpressionRow) { s.impressions.push(r); },
    file(r: FileRow) { s.files.push(r); },
  };
  return s;
}
