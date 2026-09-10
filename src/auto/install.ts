import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_LABEL, agentPlistPath, launchAgentPlist } from './agent.js';

const projectDir = () => resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: 'pipe' }) };
  } catch (e: unknown) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, out: (err.stderr || err.message || '').trim() };
  }
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

  const uid = userInfo().uid;
  // Replace any previous copy before loading, or bootstrap refuses.
  run('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`]);
  let r = run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  if (!r.ok) r = run('launchctl', ['load', '-w', plistPath]);   // older macOS

  return [
    r.ok ? 'Background agent installed and running.' : `Plist written but launchctl failed: ${r.out}`,
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
