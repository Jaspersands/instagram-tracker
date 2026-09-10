import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, agentPlistPath, launchAgentPlist } from './agent.js';

const projectDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export type Runner = (cmd: string, args: string[]) => { ok: boolean; out: string };

const run: Runner = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, out: (err.stderr || err.message || '').trim() };
  }
};

/** Block the CLI briefly. launchd's teardown is asynchronous and we must wait it out. */
const sleepSync = (ms: number) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

export interface LoadResult { ok: boolean; pid: string | null; error: string | null }

/**
 * Load the agent and *verify* it. Every piece of this is a lesson:
 *
 *  - `bootout` returns before launchd has finished unloading, so an immediate
 *    `bootstrap` fails with "Operation already in progress".
 *  - the `load -w` fallback then exits 0 while doing nothing at all.
 *
 * Together those made a restart report "installed and running" with no service
 * loaded, which is worse than an error: the dashboard just stops answering and
 * the reason is invisible. So the state is read back before anything is claimed.
 */
export function loadAgent(
  uid: number,
  plistPath: string,
  runner: Runner = run,
  sleep: (ms: number) => void = sleepSync,
): LoadResult {
  const label = `gui/${uid}/${AGENT_LABEL}`;
  const loaded = () => {
    const r = runner('launchctl', ['list', AGENT_LABEL]);
    return r.ok ? (/"PID"\s*=\s*(\d+)/.exec(r.out)?.[1] ?? 'loaded') : null;
  };

  if (loaded()) {
    runner('launchctl', ['bootout', label]);
    // Wait for the unload to actually take effect rather than assuming it did.
    for (let i = 0; i < 20 && loaded(); i++) sleep(250);
  }

  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let r = runner('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
    if (!r.ok) r = runner('launchctl', ['load', '-w', plistPath]);   // older macOS
    last = r.out;

    // The port it binds may still be held by the process we just booted out,
    // so give it a moment before deciding it did not come up.
    for (let i = 0; i < 8; i++) {
      const pid = loaded();
      if (pid) return { ok: true, pid: pid === 'loaded' ? null : pid, error: null };
      sleep(250);
    }
  }
  return { ok: false, pid: null, error: last || 'launchctl reported success but no service is loaded.' };
}

export function installAgent(watchDirs: string[], dbPath: string): string {
  if (process.platform !== 'darwin') {
    return 'Background agent is macOS-only. On Linux use a systemd user unit running `npm run watch`.';
  }
  if (watchDirs.length === 0) return 'No watchable directories found; nothing to install.';

  const dir = projectDir();
  const tsx = join(dir, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsx)) return `tsx not found at ${tsx} — run npm install first.`;

  const logPath = join(homedir(), 'Library', 'Logs', 'instagramtracker.log');
  mkdirSync(dirname(logPath), { recursive: true });

  const plistPath = agentPlistPath();
  mkdirSync(dirname(plistPath), { recursive: true });

  writeFileSync(plistPath, launchAgentPlist({
    projectDir: dir,
    nodeBin: process.execPath,
    tsxBin: tsx,
    watchDirs,
    dbPath: resolve(dbPath),
    logPath,
  }));

  const r = loadAgent(userInfo().uid, plistPath);

  return [
    r.ok
      ? `Background agent installed and running${r.pid ? ` (pid ${r.pid})` : ''}.`
      : `Plist written, but the agent is NOT running: ${r.error}`,
    `  plist    ${plistPath}`,
    `  watching ${watchDirs.join('\n           ')}`,
    `  database ${resolve(dbPath)}`,
    `  log      ${logPath}`,
    '',
    'It starts at login and restarts if it dies. Exports and captures dropped into',
    'those folders are ingested with no command typed, and you get a notification',
    'naming anyone who unfollowed you. Remove it with: npm run uninstall-agent',
    '',
    'The agent loads the source once at launch, so after changing any code run',
    'npm run restart-agent -- otherwise it keeps serving the old version.',
  ].join('\n');
}

export function uninstallAgent(): string {
  if (process.platform !== 'darwin') return 'Nothing to uninstall (macOS-only).';
  const plistPath = agentPlistPath();
  const uid = userInfo().uid;

  run('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`]);
  run('launchctl', ['unload', '-w', plistPath]);
  if (existsSync(plistPath)) unlinkSync(plistPath);

  return existsSync(plistPath)
    ? `Could not remove ${plistPath}`
    : 'Background agent stopped and removed.';
}

export function agentStatus(): string {
  if (process.platform !== 'darwin') return 'macOS-only.';
  const plistPath = agentPlistPath();
  if (!existsSync(plistPath)) return 'Not installed. Run: npm run install-agent';

  const r = run('launchctl', ['list', AGENT_LABEL]);
  if (!r.ok) return `Installed at ${plistPath} but not loaded. Run: npm run install-agent`;

  const pid = /"PID"\s*=\s*(\d+)/.exec(r.out)?.[1];
  return pid
    ? `Running (pid ${pid}). Log: ~/Library/Logs/instagramtracker.log`
    : `Loaded but not currently running — check ~/Library/Logs/instagramtracker.log`;
}
