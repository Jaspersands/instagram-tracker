import { homedir } from 'node:os';
import { join } from 'node:path';

export const AGENT_LABEL = 'com.jaspersands.instagramtracker';

export function agentPlistPath(home: string = homedir()): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

/** Ampersand first — escaping it later would mangle the entities just added. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface AgentOptions {
  projectDir: string;
  nodeBin: string;
  tsxBin: string;
  watchDirs: string[];
  dbPath: string;
  logPath: string;
}

/**
 * A LaunchAgent that runs the watcher at login and restarts it if it dies, so
 * exports and captures are ingested with no command ever typed again.
 */
export function launchAgentPlist(o: AgentOptions): string {
  const args = [o.nodeBin, o.tsxBin, join(o.projectDir, 'src/cli/index.ts'), 'watch', ...o.watchDirs];
  const argXml = args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${argXml}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(o.projectDir)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>IG_DB</key>
    <string>${escapeXml(o.dbPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(o.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(o.logPath)}</string>
</dict>
</plist>
`;
}
