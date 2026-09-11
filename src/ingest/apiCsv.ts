import { readFileSync } from 'node:fs';
import type { Db } from '../db/open.js';
import { importLikersCsv, isLikersCsv } from './likers.js';
import { importThreadsCsv, isThreadsCsv } from './threads.js';
import { importCommentsCsv, isCommentsCsv } from './comments.js';

export type ApiCsvKind = 'likers' | 'threads' | 'comments' | 'unknown';

/**
 * Which importer a CSV belongs to, decided by its header rather than its
 * filename — the filename is whatever the script that produced it chose.
 */
export function classifyApiCsv(filePath: string): ApiCsvKind {
  let head: string;
  try { head = readFileSync(filePath, 'utf8').slice(0, 600); } catch { return 'unknown'; }
  if (isLikersCsv(head)) return 'likers';
  if (isCommentsCsv(head)) return 'comments';
  if (isThreadsCsv(head)) return 'threads';
  return 'unknown';
}

export function importApiCsv(db: Db, filePath: string): { kind: ApiCsvKind; summary: string } {
  const kind = classifyApiCsv(filePath);
  switch (kind) {
    case 'likers': {
      const s = importLikersCsv(db, filePath);
      return { kind, summary: `${s.posts} posts · ${s.likeEvents} new likes · ${s.people} people · ` +
        `${s.displayNames} names · ${s.completePosts} complete / ${s.partialPosts} partial` };
    }
    case 'comments': {
      const s = importCommentsCsv(db, filePath);
      return { kind, summary: `${s.posts} posts · ${s.comments} new comments · ${s.people} people · ` +
        `${s.withTimestamps} with real timestamps` };
    }
    case 'threads': {
      const s = importThreadsCsv(db, filePath);
      if (s.wrongIdForm) {
        return { kind, summary: `${s.threads} threads, none linkable: thread_id holds the API's 39-digit ` +
          'id, but the export uses thread_v2_id (DirectThread.pk, 15-16 digits). Names and ids were ' +
          'still recorded; re-run the pull to link threads.' };
      }
      return { kind, summary: `${s.threads} threads · ${s.linked} linked · ${s.messagesMoved} messages re-attributed · ` +
        `${s.unmatched} not in any export · ${s.groupsSkipped} groups skipped` +
        (s.ambiguous ? ` · ${s.ambiguous} left on a shared name` : '') +
        (s.tombstones ? ` · ${s.tombstones} deleted accounts ignored` : '') };
    }
    default:
      return { kind, summary: 'unrecognised CSV header — see docs/api-imports.md' };
  }
}
