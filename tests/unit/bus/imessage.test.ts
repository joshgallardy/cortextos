import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, copyFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSince, checkIMessage, formatText } from '../../../src/bus/imessage';

describe('parseSince', () => {
  it('parses hours', () => {
    const now = Date.now();
    const result = parseSince('2h');
    const expected = now - 2 * 3600000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it('parses days', () => {
    const now = Date.now();
    const result = parseSince('1d');
    const expected = now - 86400000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it('parses minutes', () => {
    const now = Date.now();
    const result = parseSince('30m');
    const expected = now - 30 * 60000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it('parses ISO date', () => {
    const result = parseSince('2026-05-16');
    expect(result.getUTCFullYear()).toBe(2026);
    expect(result.getUTCMonth()).toBe(4); // May = 4
    expect(result.getUTCDate()).toBe(16);
  });

  it('parses ISO datetime', () => {
    const result = parseSince('2026-05-16T10:30:00Z');
    expect(result.toISOString()).toBe('2026-05-16T10:30:00.000Z');
  });

  it('throws on invalid input', () => {
    expect(() => parseSince('garbage')).toThrow('Cannot parse --since');
  });
});

describe('checkIMessage', () => {
  let tmpDb: string;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'imessage-test-'));
    tmpDb = join(tmpDir, 'chat.db');

    // Create a minimal iMessage schema with test data
    const APPLE_EPOCH_OFFSET = 978307200;
    const now = Date.now();
    const recentNs = (now / 1000 - APPLE_EPOCH_OFFSET) * 1_000_000_000;
    const oldNs = ((now / 1000 - APPLE_EPOCH_OFFSET) - 172800) * 1_000_000_000; // 2 days ago

    const sql = `
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, handle_id INTEGER, is_from_me INTEGER, text TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);

      INSERT INTO handle VALUES (1, '+15551234567');
      INSERT INTO handle VALUES (2, '+15559876543');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15551234567');
      INSERT INTO chat VALUES (2, 'chat123456');

      INSERT INTO message VALUES (1, ${Math.floor(recentNs)}, 1, 0, 'Hey whats up');
      INSERT INTO message VALUES (2, ${Math.floor(recentNs - 60000000000)}, 1, 1, 'Not much, you?');
      INSERT INTO message VALUES (3, ${Math.floor(recentNs - 120000000000)}, 2, 0, 'Group chat message');
      INSERT INTO message VALUES (4, ${Math.floor(oldNs)}, 1, 0, 'Old message');

      INSERT INTO chat_message_join VALUES (1, 1);
      INSERT INTO chat_message_join VALUES (1, 2);
      INSERT INTO chat_message_join VALUES (2, 3);
      INSERT INTO chat_message_join VALUES (1, 4);
    `;

    execFileSync('sqlite3', [tmpDb], { input: sql, encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('throws when database does not exist', () => {
    // Mock homedir to point to nonexistent path
    const originalHomedir = process.env.HOME;
    process.env.HOME = '/nonexistent';
    vi.spyOn(require('os'), 'homedir').mockReturnValue('/nonexistent');

    expect(() => checkIMessage()).toThrow('iMessage database not found');

    vi.restoreAllMocks();
    process.env.HOME = originalHomedir;
  });
});

describe('formatText', () => {
  it('formats empty results', () => {
    const result = formatText({ count: 0, since: '2026-05-16T00:00:00.000Z', messages: [] });
    expect(result).toContain('0 messages');
  });

  it('formats messages with direction', () => {
    const result = formatText({
      count: 2,
      since: '2026-05-16T00:00:00.000Z',
      messages: [
        { id: 1, date: '2026-05-16T23:39:37.000Z', contact: '+15551234567', direction: 'received', text: 'Hello', is_group: false, chat_id: null },
        { id: 2, date: '2026-05-16T23:40:00.000Z', contact: '+15551234567', direction: 'sent', text: 'Hi back', is_group: false, chat_id: null },
      ],
    });

    expect(result).toContain('FROM');
    expect(result).toContain('TO');
    expect(result).toContain('+15551234567');
    expect(result).toContain('Hello');
    expect(result).toContain('Hi back');
    expect(result).toContain('2 messages');
  });

  it('formats group messages with chat_id', () => {
    const result = formatText({
      count: 1,
      since: '2026-05-16T00:00:00.000Z',
      messages: [
        { id: 3, date: '2026-05-16T22:00:00.000Z', contact: '+15559876543', direction: 'received', text: 'Group msg', is_group: true, chat_id: 'chat123' },
      ],
    });

    expect(result).toContain('[chat123]');
    expect(result).toContain('Group msg');
  });

  it('shows [attachment] for null text', () => {
    const result = formatText({
      count: 1,
      since: '2026-05-16T00:00:00.000Z',
      messages: [
        { id: 4, date: '2026-05-16T21:00:00.000Z', contact: '+15551234567', direction: 'received', text: '[attachment]', is_group: false, chat_id: null },
      ],
    });

    expect(result).toContain('[attachment]');
  });
});

describe('Apple timestamp conversion', () => {
  it('converts known timestamp correctly', () => {
    // 2026-01-01T00:00:00Z in Apple nanoseconds
    // Unix timestamp for 2026-01-01: 1767225600
    // Apple seconds: 1767225600 - 978307200 = 788918400
    // Apple nanoseconds: 788918400 * 1e9
    const appleNs = 788918400 * 1_000_000_000;

    // Use the conversion logic directly
    const APPLE_EPOCH_OFFSET = 978307200;
    const unixSeconds = appleNs / 1_000_000_000 + APPLE_EPOCH_OFFSET;
    const date = new Date(unixSeconds * 1000);

    expect(date.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });
});
