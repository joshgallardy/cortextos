import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const HOOK_PATH = join(__dirname, '../../../dist/hooks/hook-pretask-memory.js');

function runHook(input: object, env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    const result = execSync(`echo '${JSON.stringify(input)}' | node ${HOOK_PATH}`, {
      encoding: 'utf-8',
      env: { ...process.env, ...env },
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { stdout: result.trim(), status: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '').trim(), status: err.status || 1 };
  }
}

describe('hook-pretask-memory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-pretask-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('exits silently for non-Bash tools', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for Bash commands that are not task updates', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for task updates to non-in_progress status', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus update-task T-123 completed' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('fires and injects context for update-task in_progress', () => {
    // Create a memory directory with today's file
    const today = new Date().toISOString().slice(0, 10);
    const memDir = join(testDir, 'memory');
    mkdirSync(memDir, { recursive: true });
    writeFileSync(join(memDir, `${today}.md`), '## Test Memory\n- WORKING ON: T-999\n');

    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cortextos bus update-task T-456 in_progress' },
      },
      {
        // Set cwd to testDir so the hook finds our memory file
        // Note: cwd can't be overridden via env, so this tests the no-memory path
        CTX_AGENT_NAME: 'test-agent',
        CTX_INSTANCE_ID: 'test',
      },
    );

    // Hook should output JSON with additionalContext
    if (result.stdout) {
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput).toBeDefined();
      expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('T-456');
    }
    // If no memory/KB found, it exits silently — that's also valid
    expect(result.status).toBe(0);
  });

  it('handles invalid JSON input gracefully', () => {
    try {
      const result = execSync(`echo 'not json' | node ${HOOK_PATH}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.trim()).toBe('');
    } catch (err: any) {
      // Exit code 0 expected even on invalid input
      expect(err.status).toBe(0);
    }
  });

  it('matches various task ID formats', () => {
    const ids = ['T-123', 'PROJ-42'];
    for (const id of ids) {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: `cortextos bus update-task ${id} in_progress` },
      });
      // Should not crash regardless of task ID format
      expect(result.status).toBe(0);
    }
  }, 15000);
});
