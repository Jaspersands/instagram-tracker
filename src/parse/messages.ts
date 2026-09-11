import type { RowSink } from './parseArchive.js';

export function isMessageFile(path: string): boolean {
  // Message requests are real threads too — often the only record of someone
  // who contacted you and was never accepted.
  return /messages\/(inbox|message_requests)\/[^/]+\/message_\d+\.json$/i.test(path);
}

/**
 * Thread paths look like `inbox/alice_17842999`. The trailing `_<digits>` is the
 * thread id, and everything before it is the username — which may itself contain
 * underscores, so only the final numeric segment is stripped.
 */
/** The numeric thread id from a folder like inbox/marcus_612189326440592. */
export function threadIdFromPath(threadPath: string | null): string | null {
  if (!threadPath) return null;
  const last = threadPath.split('/').pop() ?? '';
  // Usually <displayname>_<id>. When the person has no display name at all
  // the folder is the bare id, and 45 messages went unstamped because of it.
  const m = /(?:^|_)(\d{6,})$/.exec(last);
  return m ? m[1] : null;
}

export function usernameFromThreadPath(
  threadPath: string | null,
  title: string | null,
): string | null {
  if (threadPath) {
    const last = threadPath.split('/').pop() ?? '';
    const m = /^(.*)_\d+$/.exec(last);
    if (m && m[1]) return m[1].trim().toLowerCase();
    if (last) return last.trim().toLowerCase();
  }
  return title ? title.trim().toLowerCase() : null;
}

/** Instagram serves UTF-8 bytes as latin-1. Round-trip to repair. */
export function fixMojibake(s: string): string {
  try {
    return Buffer.from(s, 'latin1').toString('utf8');
  } catch {
    return s;
  }
}

export function parseMessageThread(json: unknown, sink: RowSink): number {
  if (!json || typeof json !== 'object') return 0;
  const t = json as Record<string, unknown>;

  const participants = Array.isArray(t.participants) ? t.participants : [];
  if (participants.length !== 2) return 0;   // group threads would swamp scoring

  const title = typeof t.title === 'string' ? t.title : null;
  const threadPath = typeof t.thread_path === 'string' ? t.thread_path : null;
  const username = usernameFromThreadPath(threadPath, title);
  if (!username) return 0;

  const threadId = threadIdFromPath(threadPath);
  if (threadId) {
    sink.dmThread({
      threadId,
      folderName: (threadPath ?? '').split('/').pop() ?? null,
      placeholder: username,
    });
  }

  // In a 1:1 thread the counterpart is whoever matches the title; anyone else is me.
  const counterpartName = title ?? null;
  const messages = Array.isArray(t.messages) ? t.messages : [];
  let emitted = 0;

  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Record<string, unknown>;

    const ms = typeof m.timestamp_ms === 'number' ? m.timestamp_ms : null;
    const sender = typeof m.sender_name === 'string' ? m.sender_name : null;
    const content = typeof m.content === 'string' ? m.content : null;

    sink.interaction({
      username,
      kind: 'dm',
      direction: sender !== null && sender === counterpartName ? 'in' : 'out',
      occurredAt: ms === null ? null : Math.floor(ms / 1000),
      permalink: null,
      text: content === null ? null : fixMojibake(content),
      threadId,
    });
    emitted++;
  }

  return emitted;
}
