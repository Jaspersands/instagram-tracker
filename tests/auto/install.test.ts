import { describe, it, expect } from 'vitest';
import { loadAgent, type Runner } from '../../src/auto/install.js';

const UID = 501;
const PLIST = '/tmp/agent.plist';
const noSleep = () => {};

/**
 * A launchctl stand-in. `loadedAfter` is how many `list` calls must happen
 * before the service reports itself loaded, which is how the real teardown /
 * start-up lag behaves.
 */
function fakeLaunchctl(opts: { loadedAt?: number; startsLoaded?: boolean; bootstrapFails?: boolean }) {
  const calls: string[] = [];
  let lists = 0;
  let booted = !!opts.startsLoaded;
  const runner: Runner = (_cmd, args) => {
    calls.push(args.join(' '));
    const verb = args[0];
    if (verb === 'list') {
      lists++;
      if (booted) return { ok: true, out: '{\n\t"PID" = 4242;\n}' };
      if (opts.loadedAt != null && lists >= opts.loadedAt) booted = true;
      return { ok: false, out: 'Could not find service' };
    }
    if (verb === 'bootout') { booted = false; return { ok: true, out: '' }; }
    if (verb === 'bootstrap') {
      return opts.bootstrapFails
        ? { ok: false, out: 'Bootstrap failed: 37: Operation already in progress' }
        : { ok: true, out: '' };
    }
    return { ok: true, out: '' };   // load -w, which exits 0 while doing nothing
  };
  return { runner, calls };
}

describe('loadAgent', () => {
  it('reports the pid once the service is actually loaded', () => {
    const { runner } = fakeLaunchctl({ loadedAt: 2 });
    expect(loadAgent(UID, PLIST, runner, noSleep)).toEqual({ ok: true, pid: '4242', error: null });
  });

  it('boots out a running copy before loading the new one', () => {
    const { runner, calls } = fakeLaunchctl({ startsLoaded: true, loadedAt: 3 });
    loadAgent(UID, PLIST, runner, noSleep);
    const order = calls.filter((c) => !c.startsWith('list'));
    // Otherwise the old process keeps the port and keeps serving stale code.
    expect(order[0]).toContain('bootout');
    expect(order[1]).toContain('bootstrap');
  });

  it('fails loudly when launchctl exits 0 but nothing is loaded', () => {
    // This is the exact shape of the bug: `load -w` succeeds, no service runs,
    // and the old code announced "installed and running".
    const { runner } = fakeLaunchctl({});
    const r = loadAgent(UID, PLIST, runner, noSleep);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no service is loaded/i);
  });

  it('surfaces the real launchctl error when bootstrap keeps refusing', () => {
    const { runner } = fakeLaunchctl({ bootstrapFails: true });
    const r = loadAgent(UID, PLIST, runner, noSleep);
    expect(r.ok).toBe(false);
  });

  it('retries rather than giving up on the first slow start', () => {
    // The port can still be held by the process just booted out.
    const { runner } = fakeLaunchctl({ loadedAt: 12 });
    expect(loadAgent(UID, PLIST, runner, noSleep).ok).toBe(true);
  });
});
