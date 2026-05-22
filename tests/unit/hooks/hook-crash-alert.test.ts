import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const execFileMock = vi.fn();
vi.mock('child_process', () => ({
  execFile: (...args: unknown[]) => execFileMock(...args),
}));

import {
  readMaxCrashesPerDay,
  notifyAgents,
  isQuietHoursLA,
  detectRateLimitInLog,
  shouldSuppressDedup,
} from '../../../src/hooks/hook-crash-alert';

// ---------------------------------------------------------------------------
// readMaxCrashesPerDay
// ---------------------------------------------------------------------------
describe('readMaxCrashesPerDay', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'crashalert-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null when agentDir is undefined', () => {
    expect(readMaxCrashesPerDay(undefined)).toBeNull();
  });

  it('returns null when config.json is missing', () => {
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when config.json is malformed', () => {
    writeFileSync(join(tmp, 'config.json'), '{ not valid json', 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns null when max_crashes_per_day is missing', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ agent_name: 'x' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });

  it('returns the configured number when present', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 10 }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBe(10);
  });

  it('returns null when max_crashes_per_day is not a number', () => {
    writeFileSync(join(tmp, 'config.json'), JSON.stringify({ max_crashes_per_day: 'ten' }), 'utf-8');
    expect(readMaxCrashesPerDay(tmp)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// notifyAgents
// ---------------------------------------------------------------------------
describe('notifyAgents', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it('sends one bus send-message per recipient', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'uncaught exception',
      lastTask: 'building hooks',
      crashCount: 2,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('uses cortextos bus send-message with priority high', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: 'r',
      lastTask: 't',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const [cmd, args] = execFileMock.mock.calls[0];
    expect(cmd).toBe('cortextos');
    expect(args.slice(0, 4)).toEqual(['bus', 'send-message', 'chief', 'high']);
  });

  it('body includes all required fields', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'daemon-crashed',
      reason: 'PTY null write',
      lastTask: 'idle',
      crashCount: 3,
      restartAttempted: false,
      recipients: ['analyst'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('agent=dev');
    expect(body).toContain('type=daemon-crashed');
    expect(body).toContain('reason: PTY null write');
    expect(body).toContain('last status: idle');
    expect(body).toContain('crashes today: 3');
    expect(body).toContain('restart attempted: no');
  });

  it('marks restart attempted yes when crashCount under limit', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    expect(execFileMock.mock.calls[0][1][4]).toContain('restart attempted: yes');
  });

  it('uses fallback strings when reason and lastTask are empty', () => {
    notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief'],
    });
    const body: string = execFileMock.mock.calls[0][1][4];
    expect(body).toContain('reason: none');
    expect(body).toContain('last status: unknown');
  });

  it('does not throw when execFile throws synchronously', () => {
    execFileMock.mockImplementationOnce(() => { throw new Error('exec failed'); });
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 1,
      restartAttempted: true,
      recipients: ['chief', 'analyst'],
    })).not.toThrow();
    // Second recipient still attempted
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('sends to empty recipients list without error', () => {
    expect(() => notifyAgents({
      agentName: 'dev',
      endType: 'crash',
      reason: '',
      lastTask: '',
      crashCount: 0,
      restartAttempted: true,
      recipients: [],
    })).not.toThrow();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// detectRateLimitInLog
// ---------------------------------------------------------------------------
describe('detectRateLimitInLog', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ratelimit-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false for missing file', () => {
    expect(detectRateLimitInLog(join(tmp, 'nonexistent.log'))).toBe(false);
  });

  it('returns false for normal log content', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'Agent started successfully\nProcessing task T-123\nDone.\n');
    expect(detectRateLimitInLog(logPath)).toBe(false);
  });

  it('returns false for empty file', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, '');
    expect(detectRateLimitInLog(logPath)).toBe(false);
  });

  it('detects overloaded_error', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'some output\n{"type":"overloaded_error","message":"overloaded"}\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects rate_limit_error', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'Error: rate_limit_error - too many requests\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "rate limit" (space-separated)', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'You have hit a rate limit. Please wait.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "too many requests"', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'HTTP 429 Too Many Requests\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "weekly limit"', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'You have reached your weekly limit.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "5-hour limit"', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'You have reached your 5-hour limit for this model.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "5h limit"', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'Exceeded 5h limit. Waiting for reset.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "usage limit"', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'You have exceeded your usage limit.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects "quota exceeded"', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'API quota exceeded. Try again later.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('detects percentage usage pattern', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'You have used 95% of your daily allocation.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('is case-insensitive (RATE LIMIT in mixed case)', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, 'RATE LIMIT ERROR: Please slow down.\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });

  it('strips ANSI escape codes before matching', () => {
    const logPath = join(tmp, 'stdout.log');
    writeFileSync(logPath, '\x1b[31mrate_limit_error\x1b[0m: throttled\n');
    expect(detectRateLimitInLog(logPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isQuietHoursLA
// ---------------------------------------------------------------------------
describe('isQuietHoursLA', () => {
  // isQuietHoursLA uses toLocaleString with America/Los_Angeles timezone.
  // We construct dates where the LA time is deterministic.

  function makeDateAtLAHour(hour: number): Date {
    // Build a date string at the given hour in LA timezone, then parse it.
    // LA is UTC-7 (PDT) or UTC-8 (PST). Use a known PDT date: July 1, 2026.
    // PDT = UTC-7, so LA hour H = UTC hour H+7.
    const utcHour = (hour + 7) % 24;
    return new Date(`2026-07-01T${String(utcHour).padStart(2, '0')}:30:00Z`);
  }

  it('returns true at 23:00 LA (within quiet window)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(23))).toBe(true);
  });

  it('returns true at 22:00 LA (start of quiet window)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(22))).toBe(true);
  });

  it('returns true at 3:00 LA (middle of night)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(3))).toBe(true);
  });

  it('returns true at 0:00 LA (midnight)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(0))).toBe(true);
  });

  it('returns true at 6:00 LA (still in quiet window)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(6))).toBe(true);
  });

  it('returns false at 7:00 LA (end of quiet window)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(7))).toBe(false);
  });

  it('returns false at 12:00 LA (midday)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(12))).toBe(false);
  });

  it('returns false at 21:00 LA (just before quiet starts)', () => {
    expect(isQuietHoursLA(makeDateAtLAHour(21))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldSuppressDedup
// ---------------------------------------------------------------------------
describe('shouldSuppressDedup', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'dedup-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false on first call (no prior dedup file)', () => {
    expect(shouldSuppressDedup(tmp, 'crash')).toBe(false);
  });

  it('returns true on second immediate call with same endType', () => {
    shouldSuppressDedup(tmp, 'crash');
    expect(shouldSuppressDedup(tmp, 'crash')).toBe(true);
  });

  it('returns false for different endType even after first call', () => {
    shouldSuppressDedup(tmp, 'crash');
    expect(shouldSuppressDedup(tmp, 'daemon-crashed')).toBe(false);
  });

  it('writes dedup state to .crash_alert_dedup.json', () => {
    shouldSuppressDedup(tmp, 'crash');
    const dedupFile = join(tmp, '.crash_alert_dedup.json');
    const data = JSON.parse(readFileSync(dedupFile, 'utf-8'));
    expect(data).toHaveProperty('crash');
    expect(typeof data.crash).toBe('number');
  });

  it('handles corrupt dedup file gracefully (treats as first call)', () => {
    writeFileSync(join(tmp, '.crash_alert_dedup.json'), 'not json', 'utf-8');
    expect(shouldSuppressDedup(tmp, 'crash')).toBe(false);
  });

  it('allows re-alert after dedup window expires', () => {
    // Write a dedup entry from 11 minutes ago (window is 10 min)
    const dedupFile = join(tmp, '.crash_alert_dedup.json');
    const elevenMinAgo = Date.now() - 11 * 60 * 1000;
    writeFileSync(dedupFile, JSON.stringify({ crash: elevenMinAgo }), 'utf-8');
    expect(shouldSuppressDedup(tmp, 'crash')).toBe(false);
  });

  it('still suppresses within the dedup window', () => {
    const dedupFile = join(tmp, '.crash_alert_dedup.json');
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    writeFileSync(dedupFile, JSON.stringify({ crash: fiveMinAgo }), 'utf-8');
    expect(shouldSuppressDedup(tmp, 'crash')).toBe(true);
  });
});
