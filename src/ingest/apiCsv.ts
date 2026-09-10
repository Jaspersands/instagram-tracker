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
      return { kind, summary: `${s.threads} threads · ${s.linked} linked · ${s.unmatched} not in any export · ` +
        `${s.groupsSkipped} groups skipped` };
    }
    default:
      return { kind, summary: 'unrecognised CSV header — see docs/api-imports.md' };
  }
}
