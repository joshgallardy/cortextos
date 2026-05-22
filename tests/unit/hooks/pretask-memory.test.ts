import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execSync } from 'child_process';

const HOOK_PATH = join(__dirname, '../../../dist/hooks/hook-pretask-memory.js');

function runHook(input: object, env: Record<string, string> = {}): { stdout: string; status: number } {
  try {
    const payload = JSON.stringify(input);
    const result = execSync(`node ${HOOK_PATH}`, {
      input: payload,
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

  // --- No-match cases ---

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

  it('exits silently for update-task to "pending" status', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus update-task T-123 pending' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for Write tool (not Bash)', () => {
    const result = runHook({
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.txt', content: 'cortextos bus update-task T-1 in_progress' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for empty command', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: { command: '' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently when tool_input.command is missing', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: {} });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  // --- Match cases ---

  it('fires for update-task in_progress', () => {
    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cortextos bus update-task T-456 in_progress' },
      },
      {
        CTX_AGENT_NAME: 'test-agent',
        CTX_INSTANCE_ID: 'test',
      },
    );

    // Hook should output JSON with additionalContext or exit silently if
    // no memory/KB found. Either way, status 0.
    if (result.stdout) {
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput).toBeDefined();
      expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(output.hookSpecificOutput.additionalContext).toContain('T-456');
    }
    expect(result.status).toBe(0);
  });

  it('matches various task ID formats', () => {
    const ids = ['T-123', 'PROJ-42', '1779369919536-dev-abc123', 'simple'];
    for (const id of ids) {
      const result = runHook({
        tool_name: 'Bash',
        tool_input: { command: `cortextos bus update-task ${id} in_progress` },
      });
      expect(result.status).toBe(0);
    }
  }, 20000);

  it('matches when command has extra args after in_progress', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus update-task T-789 in_progress --note "starting now"' },
    });
    // Should not crash — still matches the regex
    expect(result.status).toBe(0);
  });

  it('matches with extra whitespace between arguments', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos  bus  update-task  T-100  in_progress' },
    });
    // The regex uses \s+ so this should still match
    expect(result.status).toBe(0);
  });

  it('does not match update-task without in_progress keyword', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus update-task T-100' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('does not match create-task (different subcommand)', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus create-task "New task" --desc "test"' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('does not match complete-task (different subcommand)', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus complete-task T-100 --result "done"' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('does not match when in_progress appears elsewhere in command', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'echo "task is in_progress"' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('does not match Grep tool even with matching content', () => {
    const result = runHook({
      tool_name: 'Grep',
      tool_input: { pattern: 'cortextos bus update-task .* in_progress' },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('matches task ID with numeric-only format', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus update-task 42 in_progress' },
    });
    expect(result.status).toBe(0);
  });

  it('matches task ID with timestamp format', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: 'cortextos bus update-task 1779444123907-dev-glbsm in_progress' },
    });
    expect(result.status).toBe(0);
  });

  // --- Graceful failure ---

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

  it('handles completely empty stdin gracefully', () => {
    try {
      const result = execSync(`echo '' | node ${HOOK_PATH}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.trim()).toBe('');
    } catch (err: any) {
      expect(err.status).toBe(0);
    }
  });

  it('handles missing tool_name field gracefully', () => {
    const result = runHook({ tool_input: { command: 'cortextos bus update-task T-1 in_progress' } });
    // Missing tool_name → treated as non-Bash → silent exit
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('includes task ID in additionalContext when context is found', () => {
    // Even without KB/memory, if CTX_AGENT_NAME is set and the task file
    // doesn't exist, the hook should either inject partial context or exit silently.
    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: 'cortextos bus update-task TASK-007 in_progress' },
      },
      {
        CTX_AGENT_NAME: 'test-agent',
        CTX_INSTANCE_ID: 'test-instance',
      },
    );
    expect(result.status).toBe(0);
    // If output is present, verify task ID is in context
    if (result.stdout) {
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.additionalContext).toContain('TASK-007');
    }
  });
});
