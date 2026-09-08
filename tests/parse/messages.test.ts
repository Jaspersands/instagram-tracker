import { describe, it, expect } from 'vitest';
import {
  isMessageFile, usernameFromThreadPath, fixMojibake, parseMessageThread,
} from '../../src/parse/messages.js';
import { collectingSink } from '../../src/parse/parseArchive.js';

const thread = {
  participants: [{ name: 'Alice Smith' }, { name: 'Me Myself' }],
  title: 'Alice Smith',
  thread_path: 'inbox/alice_17842999',
  messages: [
    { sender_name: 'Alice Smith', timestamp_ms: 1700000000000, content: 'hey' },
    { sender_name: 'Me Myself', timestamp_ms: 1700000060000, content: 'hi' },
    { sender_name: 'Me Myself', timestamp_ms: 1700000120000, content: 'cafÃ©' },
  ],
};

describe('isMessageFile', () => {
  it('matches inbox message files', () => {
    expect(isMessageFile('your_instagram_activity/messages/inbox/alice_123/message_1.json')).toBe(true);
    expect(isMessageFile('messages/inbox/bob_9/message_2.json')).toBe(true);
  });
  it('does not match other json', () => {
    expect(isMessageFile('connections/followers_and_following/followers_1.json')).toBe(false);
  });
});

describe('usernameFromThreadPath', () => {
  it('strips the numeric thread suffix', () => {
    expect(usernameFromThreadPath('inbox/alice_17842999', 'Alice Smith')).toBe('alice');
  });
  it('handles usernames containing underscores', () => {
    expect(usernameFromThreadPath('inbox/some_cool_user_123456', null)).toBe('some_cool_user');
  });
  it('falls back to the title when there is no thread path', () => {
    expect(usernameFromThreadPath(null, 'Alice Smith')).toBe('alice smith');
  });
  it('returns null when it has nothing to work with', () => {
    expect(usernameFromThreadPath(null, null)).toBeNull();
  });
});

describe('fixMojibake', () => {
  it('repairs UTF-8 served as latin-1', () => {
    expect(fixMojibake('cafÃ©')).toBe('café');
  });
  it('leaves clean ascii untouched', () => {
    expect(fixMojibake('hello')).toBe('hello');
  });
});

describe('parseMessageThread', () => {
  it('emits one dm interaction per message with seconds and correct direction', () => {
    const sink = collectingSink();
    parseMessageThread(thread, sink);

    expect(sink.interactions).toHaveLength(3);
    expect(sink.interactions.every((i) => i.kind === 'dm')).toBe(true);
    expect(sink.interactions.every((i) => i.username === 'alice')).toBe(true);

    // milliseconds must become seconds
    expect(sink.interactions[0].occurredAt).toBe(1700000000);

    expect(sink.interactions.filter((i) => i.direction === 'in')).toHaveLength(1);
    expect(sink.interactions.filter((i) => i.direction === 'out')).toHaveLength(2);
  });

  it('skips group threads to keep them out of one-to-one scoring', () => {
    const sink = collectingSink();
    parseMessageThread({ ...thread, participants: [{ name: 'a' }, { name: 'b' }, { name: 'c' }] }, sink);
    expect(sink.interactions).toEqual([]);
  });

  it('tolerates a thread with no messages', () => {
    const sink = collectingSink();
    parseMessageThread({ ...thread, messages: [] }, sink);
    expect(sink.interactions).toEqual([]);
  });
});
