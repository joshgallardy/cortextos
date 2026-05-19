import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSince, checkIMessage, formatText } from '../../../src/bus/imessage';

// ── parseSince ──────────────────────────────────────────────────────

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

  it('handles zero-value relative time', () => {
    const now = Date.now();
    const result = parseSince('0h');
    expect(Math.abs(result.getTime() - now)).toBeLessThan(100);
  });

  it('handles large relative values', () => {
    const now = Date.now();
    const result = parseSince('365d');
    const expected = now - 365 * 86400000;
    expect(Math.abs(result.getTime() - expected)).toBeLessThan(100);
  });

  it('is case-insensitive for units', () => {
    const now = Date.now();
    const lower = parseSince('2h');
    const upper = parseSince('2H');
    expect(Math.abs(lower.getTime() - upper.getTime())).toBeLessThan(100);
  });
});

// ── checkIMessage with temp DB ──────────────────────────────────────

describe('checkIMessage', () => {
  let tmpDb: string;
  let tmpDir: string;
  const APPLE_EPOCH_OFFSET = 978307200;

  function nowAppleNs(): number {
    return (Date.now() / 1000 - APPLE_EPOCH_OFFSET) * 1_000_000_000;
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'imessage-test-'));
    tmpDb = join(tmpDir, 'chat.db');

    const recentNs = nowAppleNs();
    const oneHourAgoNs = recentNs - 3600 * 1_000_000_000;
    const twoDaysAgoNs = recentNs - 172800 * 1_000_000_000;

    const sql = `
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, handle_id INTEGER, is_from_me INTEGER, text TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);

      INSERT INTO handle VALUES (1, '+15551234567');
      INSERT INTO handle VALUES (2, '+15559876543');
      INSERT INTO handle VALUES (3, 'user@example.com');
      INSERT INTO chat VALUES (1, 'iMessage;-;+15551234567');
      INSERT INTO chat VALUES (2, 'chat123456');
      INSERT INTO chat VALUES (3, 'iMessage;-;user@example.com');

      INSERT INTO message VALUES (1, ${Math.floor(recentNs)}, 1, 0, 'Hey whats up');
      INSERT INTO message VALUES (2, ${Math.floor(recentNs - 60 * 1e9)}, 1, 1, 'Not much, you?');
      INSERT INTO message VALUES (3, ${Math.floor(oneHourAgoNs)}, 2, 0, 'Group chat message');
      INSERT INTO message VALUES (4, ${Math.floor(twoDaysAgoNs)}, 1, 0, 'Old message');
      INSERT INTO message VALUES (5, ${Math.floor(recentNs - 30 * 1e9)}, 3, 0, 'Email contact msg');
      INSERT INTO message VALUES (6, ${Math.floor(recentNs - 10 * 1e9)}, 1, 0, NULL);

      INSERT INTO chat_message_join VALUES (1, 1);
      INSERT INTO chat_message_join VALUES (1, 2);
      INSERT INTO chat_message_join VALUES (2, 3);
      INSERT INTO chat_message_join VALUES (1, 4);
      INSERT INTO chat_message_join VALUES (3, 5);
      INSERT INTO chat_message_join VALUES (1, 6);
    `;

    execFileSync('sqlite3', [tmpDb], { input: sql, encoding: 'utf-8' });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  it('throws when database does not exist', () => {
    expect(() => checkIMessage({ dbPath: '/nonexistent/chat.db' })).toThrow('iMessage database not found');
  });

  it('returns recent messages from temp DB', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '1d', limit: 50 });
    // Should get messages from the last 24h (not the 2-day-old one)
    expect(result.count).toBeGreaterThanOrEqual(4); // recent + 1h ago + email + null text
    expect(result.messages.every(m => m.id !== 4)).toBe(true); // old message excluded
  });

  it('filters by contact phone number', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '2d', contact: '+15551234567' });
    expect(result.messages.every(m => m.contact === '+15551234567')).toBe(true);
    expect(result.count).toBeGreaterThanOrEqual(2);
  });

  it('filters by contact email', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '1d', contact: 'example.com' });
    expect(result.count).toBe(1);
    expect(result.messages[0].contact).toBe('user@example.com');
  });

  it('respects limit', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '2d', limit: 2 });
    expect(result.count).toBe(2);
  });

  it('returns correct direction for sent/received', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '1d', limit: 50 });
    const sent = result.messages.filter(m => m.direction === 'sent');
    const received = result.messages.filter(m => m.direction === 'received');
    expect(sent.length).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeGreaterThanOrEqual(1);
  });

  it('handles null text as [attachment]', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '1d', limit: 50 });
    const attachment = result.messages.find(m => m.id === 6);
    expect(attachment).toBeDefined();
    expect(attachment!.text).toBe('[attachment]');
  });

  it('detects group chats', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '2d', limit: 50 });
    const groupMsg = result.messages.find(m => m.id === 3);
    expect(groupMsg).toBeDefined();
    expect(groupMsg!.is_group).toBe(true);
    expect(groupMsg!.chat_id).toBe('chat123456');
  });

  it('returns empty results for future --since', () => {
    const result = checkIMessage({ dbPath: tmpDb, since: '2090-01-01' });
    expect(result.count).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it('clamps limit to valid range', () => {
    // Limit 0 should become 1
    const result = checkIMessage({ dbPath: tmpDb, since: '1d', limit: 0 });
    expect(result.count).toBeLessThanOrEqual(1);
  });

  it('sanitizes SQL injection in contact to harmless query', () => {
    // Dangerous chars are stripped, remaining alphanumeric chars just produce no matches
    const result = checkIMessage({
      dbPath: tmpDb,
      since: '1d',
      contact: "'; DROP TABLE message; --",
    });
    // Should succeed but find nothing (sanitized to "DROPTABLEmessage--" which matches no contact)
    expect(result.count).toBe(0);
  });

  it('rejects contact that is only special characters', () => {
    expect(() => checkIMessage({
      dbPath: tmpDb,
      since: '1d',
      contact: "'; \" ;",
    })).toThrow('Invalid --contact');
  });

  it('sanitizes contact to safe characters', () => {
    // Should not throw — valid chars pass through
    const result = checkIMessage({ dbPath: tmpDb, since: '1d', contact: '+1555' });
    expect(result.messages.every(m => m.contact.includes('+1555'))).toBe(true);
  });
});

// ── formatText ──────────────────────────────────────────────────────

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

// ── Apple timestamp conversion ──────────────────────────────────────

describe('Apple timestamp conversion', () => {
  it('converts known timestamp correctly', () => {
    // 2026-01-01T00:00:00Z in Apple nanoseconds
    const appleNs = 788918400 * 1_000_000_000;
    const APPLE_EPOCH_OFFSET = 978307200;
    const unixSeconds = appleNs / 1_000_000_000 + APPLE_EPOCH_OFFSET;
    const date = new Date(unixSeconds * 1000);
    expect(date.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('converts Apple epoch zero to 2001-01-01', () => {
    const appleNs = 0;
    const APPLE_EPOCH_OFFSET = 978307200;
    const unixSeconds = appleNs / 1_000_000_000 + APPLE_EPOCH_OFFSET;
    const date = new Date(unixSeconds * 1000);
    expect(date.toISOString()).toBe('2001-01-01T00:00:00.000Z');
  });

  it('round-trips current time accurately', () => {
    const APPLE_EPOCH_OFFSET = 978307200;
    const now = new Date();
    // Convert to Apple ns
    const appleNs = (now.getTime() / 1000 - APPLE_EPOCH_OFFSET) * 1_000_000_000;
    // Convert back
    const unixSeconds = appleNs / 1_000_000_000 + APPLE_EPOCH_OFFSET;
    const roundTripped = new Date(unixSeconds * 1000);
    // Should be within 1ms
    expect(Math.abs(roundTripped.getTime() - now.getTime())).toBeLessThan(1);
  });
});
