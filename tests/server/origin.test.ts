import { describe, it, expect } from 'vitest';
import { isLocalOrigin } from '../../src/server/origin.js';

describe('isLocalOrigin', () => {
  it('allows the dashboard itself', () => {
    for (const o of ['http://127.0.0.1:4317', 'http://localhost:4317', 'http://[::1]:4317']) {
      expect(isLocalOrigin(o)).toBe(true);
    }
  });

  it('allows a request with no Origin, so curl and the CLI still work', () => {
    expect(isLocalOrigin(undefined)).toBe(true);
  });

  it('refuses a page on the open web', () => {
    // Binding to loopback stops a site reading the response, not triggering the
    // request — a plain form post is never preflighted.
    expect(isLocalOrigin('https://evil.example')).toBe(false);
    expect(isLocalOrigin('http://127.0.0.1.evil.example')).toBe(false);
    expect(isLocalOrigin('null')).toBe(false);
    expect(isLocalOrigin('not a url')).toBe(false);
  });
});
