import { describe, it, expect } from 'vitest';
import { escapeAppleScript, notifyScript, unfollowerMessage } from '../../src/notify/notify.js';

describe('escapeAppleScript', () => {
  it('escapes the two characters that break an AppleScript string literal', () => {
    expect(escapeAppleScript('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAppleScript('back\\slash')).toBe('back\\\\slash');
  });

  it('escapes the backslash before the quote, not after', () => {
    // Getting this order wrong turns \" into \\" and breaks the literal.
    expect(escapeAppleScript('a\\"b')).toBe('a\\\\\\"b');
  });

  it('flattens newlines so the script stays one statement', () => {
    expect(escapeAppleScript('one\ntwo\r\nthree')).toBe('one two three');
  });

  it('leaves a username with dots and underscores alone', () => {
    expect(escapeAppleScript('some.user_name')).toBe('some.user_name');
  });
});

describe('notifyScript', () => {
  it('builds a well-formed display notification statement', () => {
    expect(notifyScript('Title', 'Body'))
      .toBe('display notification "Body" with title "Title"');
  });

  it('survives a username crafted to break out of the string', () => {
    const s = notifyScript('T', 'user" & (do shell script "echo pwned") & "');
    // The injected quotes must be neutralised, leaving exactly two real
    // delimiters around the body.
    expect(s).not.toMatch(/do shell script"/);
    expect(s.match(/(?<!\\)"/g)!.length).toBe(4);   // two per argument
  });
});

describe('unfollowerMessage', () => {
  it('names a single unfollower', () => {
    expect(unfollowerMessage(['alice'])).toBe('alice unfollowed you');
  });

  it('names a short list', () => {
    expect(unfollowerMessage(['alice', 'bob'])).toBe('alice and bob unfollowed you');
    expect(unfollowerMessage(['a', 'b', 'c'])).toBe('a, b and c unfollowed you');
  });

  it('summarises a long list rather than overflowing the notification', () => {
    expect(unfollowerMessage(['a', 'b', 'c', 'd', 'e']))
      .toBe('a, b, c and 2 others unfollowed you');
  });

  it('returns null when nobody left, so no notification fires', () => {
    expect(unfollowerMessage([])).toBeNull();
  });
});
