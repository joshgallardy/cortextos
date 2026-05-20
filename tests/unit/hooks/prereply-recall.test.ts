import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { execSync } from 'child_process';

const HOOK_PATH = join(__dirname, '../../../dist/hooks/hook-prereply-recall.js');

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

describe('hook-prereply-recall', () => {
  it('exits silently for non-Bash tools', () => {
    const result = runHook({ tool_name: 'Read', tool_input: { file_path: '/tmp/foo' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for Bash commands that are not send-telegram or send-message', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for non-cortextos Bash commands', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: { command: 'git status' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for short system messages (send-telegram)', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: "cortextos bus send-telegram 12345 'Back online.'" },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for boot messages', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: "cortextos bus send-telegram 12345 'Booting up... one moment please wait'" },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for heartbeat notifications', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: "cortextos bus send-telegram 12345 'Heartbeat: all systems nominal and running'" },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for standing-down messages', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: "cortextos bus send-telegram 12345 'Standing down for the night, will check inbox in the morning'" },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for short ack messages (send-message)', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: "cortextos bus send-message chief normal 'Copy.' msg123" },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for "Got it" messages', () => {
    const result = runHook({
      tool_name: 'Bash',
      tool_input: { command: "cortextos bus send-message chief normal 'Got it, thanks'" },
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('attempts KB query for substantive Telegram messages', () => {
    // This will attempt a KB query which may or may not return results,
    // but should not crash. The hook exits cleanly either way.
    const longMessage = 'I analyzed the security scan results and found three open ports that need attention. Port 8080 is running an unknown service.';
    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cortextos bus send-telegram 12345 '${longMessage}'` },
      },
      { CTX_ORG: 'life-os', CTX_AGENT_NAME: 'dev' },
    );
    // Should exit 0 regardless of KB results
    expect(result.status).toBe(0);
    // If KB returned results, stdout should be valid JSON with additionalContext
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('Pre-reply recall');
    }
  });

  it('attempts KB query for substantive agent messages', () => {
    const longMessage = 'The iMessage bus command has been built and verified. It supports since, contact, limit, and format flags with full test coverage.';
    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cortextos bus send-message chief normal '${longMessage}'` },
      },
      { CTX_ORG: 'life-os', CTX_AGENT_NAME: 'dev' },
    );
    expect(result.status).toBe(0);
    if (result.stdout) {
      const parsed = JSON.parse(result.stdout);
      expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
      expect(parsed.hookSpecificOutput.additionalContext).toContain('Pre-reply recall');
    }
  });

  it('handles double-quoted messages', () => {
    const longMessage = 'Here is a detailed analysis of the memory recall gaps and recommended fixes for the knowledge base pipeline.';
    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cortextos bus send-telegram 12345 "${longMessage}"` },
      },
      { CTX_ORG: 'life-os', CTX_AGENT_NAME: 'dev' },
    );
    expect(result.status).toBe(0);
  });

  it('exits silently when CTX_ORG is not set', () => {
    const longMessage = 'This is a substantive message that would normally trigger a KB query for relevant context.';
    const result = runHook(
      {
        tool_name: 'Bash',
        tool_input: { command: `cortextos bus send-telegram 12345 '${longMessage}'` },
      },
      { CTX_ORG: '', CTX_AGENT_NAME: 'dev' },
    );
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('handles malformed JSON input gracefully', () => {
    try {
      const result = execSync(`echo 'not json' | node ${HOOK_PATH}`, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      expect(result.trim()).toBe('');
    } catch (err: any) {
      // Exit 0 is expected
      expect(err.status).toBe(0);
    }
  });

  it('handles empty stdin gracefully', () => {
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
});
