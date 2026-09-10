/**
 * Any website you visit can POST to http://127.0.0.1:<port> cross-origin — a
 * simple form post is not preflighted, so binding to loopback alone does not
 * stop a page from *triggering* things here, only from reading the response.
 *
 * A missing Origin is allowed: curl and the CLI send none, and a browser always
 * sends one on a POST. So this blocks the browser-driven case, which is the
 * only one an attacker controls, without breaking scripted use.
 */
export function isLocalOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  if (origin === 'null') return false; // sandboxed iframe or file:// page
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}
