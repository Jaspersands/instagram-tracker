import { execFile } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Escape a string for an AppleScript double-quoted literal. Usernames come from
 * an Instagram export — untrusted text that ends up inside a shell-invoked
 * script — so a name containing a quote must not be able to close the literal
 * and append its own AppleScript.
 *
 * Backslashes are escaped first; doing it after would double the backslash that
 * was just added in front of a quote.
 */
export function escapeAppleScript(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r\n|[\r\n]/g, ' ');
}

export function notifyScript(title: string, body: string): string {
  return `display notification "${escapeAppleScript(body)}" ` +
         `with title "${escapeAppleScript(title)}"`;
}

/** A short, readable line naming who left without overflowing the banner. */
export function unfollowerMessage(lost: string[]): string | null {
  if (lost.length === 0) return null;
  if (lost.length === 1) return `${lost[0]} unfollowed you`;
  if (lost.length === 2) return `${lost[0]} and ${lost[1]} unfollowed you`;
  if (lost.length === 3) return `${lost[0]}, ${lost[1]} and ${lost[2]} unfollowed you`;
  return `${lost.slice(0, 3).join(', ')} and ${lost.length - 3} others unfollowed you`;
}

/**
 * Fire-and-forget desktop notification. Never throws and never rejects: a
 * notification failing must not take down an ingest that already succeeded.
 * A no-op off macOS rather than an error.
 */
export function notify(title: string, body: string): void {
  if (platform() !== 'darwin') return;
  try {
    execFile('osascript', ['-e', notifyScript(title, body)], () => { /* ignore */ });
  } catch {
    /* ignore */
  }
}
