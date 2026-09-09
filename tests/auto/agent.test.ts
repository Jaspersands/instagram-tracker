import { describe, it, expect } from 'vitest';
import { launchAgentPlist, AGENT_LABEL, escapeXml } from '../../src/auto/agent.js';

describe('escapeXml', () => {
  it('escapes the characters that would break the plist', () => {
    expect(escapeXml('a & b')).toBe('a &amp; b');
    expect(escapeXml('<tag>')).toBe('&lt;tag&gt;');
    expect(escapeXml('say "hi"')).toBe('say &quot;hi&quot;');
  });

  it('escapes ampersands before the entities it just introduced', () => {
    // Wrong order turns < into &amp;lt;
    expect(escapeXml('<&>')).toBe('&lt;&amp;&gt;');
  });
});

describe('launchAgentPlist', () => {
  const opts = {
    projectDir: '/Users/j/Desktop/vibes/instagramtracker',
    nodeBin: '/usr/local/bin/node',
    tsxBin: '/Users/j/p/node_modules/.bin/tsx',
    watchDirs: ['/Users/j/Downloads', '/Users/j/Google Drive'],
    dbPath: '/Users/j/p/data/instagram.db',
    logPath: '/Users/j/Library/Logs/igtracker.log',
  };

  it('produces a plist with the label, RunAtLoad and KeepAlive', () => {
    const p = launchAgentPlist(opts);
    expect(p).toContain('<?xml version="1.0"');
    expect(p).toContain(AGENT_LABEL);
    expect(p).toContain('<key>RunAtLoad</key>');
    expect(p).toContain('<key>KeepAlive</key>');
  });

  it('passes every watch directory as an argument', () => {
    const p = launchAgentPlist(opts);
    expect(p).toContain('<string>/Users/j/Downloads</string>');
    expect(p).toContain('<string>/Users/j/Google Drive</string>');
  });

  it('sets the database path in the environment so the agent and CLI agree', () => {
    expect(launchAgentPlist(opts)).toContain('<string>/Users/j/p/data/instagram.db</string>');
  });

  it('escapes a path containing XML metacharacters', () => {
    const p = launchAgentPlist({ ...opts, watchDirs: ['/Users/j/A & B'] });
    expect(p).toContain('<string>/Users/j/A &amp; B</string>');
    expect(p).not.toContain('/Users/j/A & B<');
  });
});
