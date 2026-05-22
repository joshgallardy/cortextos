import { describe, it, expect } from 'vitest';
import { join } from 'path';
import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';

const HOOK_PATH = join(__dirname, '../../../dist/hooks/hook-truncation-guard.js');

function runHook(input: object): { stdout: string; status: number } {
  try {
    const payload = JSON.stringify(input);
    const result = execSync(
      `node ${HOOK_PATH}`,
      {
        input: payload,
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return { stdout: result.trim(), status: 0 };
  } catch (err: any) {
    return { stdout: (err.stdout || '').trim(), status: err.status || 1 };
  }
}

function makeLines(count: number): string {
  return Array.from({ length: count }, (_, i) => `${i + 1}\tline content here`).join('\n');
}

describe('hook-truncation-guard', () => {
  // --- No-match: wrong tool ---

  it('exits silently for non-Read tools', () => {
    const result = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for Write tool', () => {
    const result = runHook({ tool_name: 'Write', tool_input: { file_path: '/tmp/f', content: 'x' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for Edit tool', () => {
    const result = runHook({ tool_name: 'Edit', tool_input: { file_path: '/tmp/f' } });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  // --- No-match: small/medium files ---

  it('exits silently for small files (well under limit)', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/small.txt' },
      tool_response: makeLines(50),
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('exits silently for files at 1000 lines (no truncation)', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/medium.txt' },
      tool_response: makeLines(1000),
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('does not warn when just under the limit (1990 lines)', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/justunder.txt' },
      tool_response: makeLines(1990),
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  // --- Match: truncation detected ---

  it('warns when response hits default 2000-line limit', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/big.txt' },
      tool_response: makeLines(2000),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe('');

    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.hookEventName).toBe('PostToolUse');
    expect(output.hookSpecificOutput.additionalContext).toContain('WARNING');
    expect(output.hookSpecificOutput.additionalContext).toContain('/tmp/big.txt');
    expect(output.hookSpecificOutput.additionalContext).toContain('2000');
    expect(output.hookSpecificOutput.additionalContext).toContain('offset: 2000');
  });

  it('warns when response hits explicit limit', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/custom.txt', limit: 500 },
      tool_response: makeLines(500),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('limit: 500');
    expect(output.hookSpecificOutput.additionalContext).toContain('offset: 500');
  });

  it('warns at the margin boundary (1996 lines, within +/-5)', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/margin.txt' },
      tool_response: makeLines(1996),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe('');
  });

  // --- Offset handling ---

  it('accounts for offset in the suggested next offset', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/offset.txt', offset: 100, limit: 500 },
      tool_response: makeLines(500),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    // offset 100 + 500 lines returned = suggest offset 600
    expect(output.hookSpecificOutput.additionalContext).toContain('offset: 600');
  });

  it('calculates correct offset with large initial offset', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/deep.txt', offset: 5000, limit: 200 },
      tool_response: makeLines(200),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('offset: 5200');
  });

  // --- Response format variants ---

  it('handles tool_response as object with content key', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/obj.txt' },
      tool_response: { content: makeLines(2000) },
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('WARNING');
  });

  it('handles tool_response as object with output key', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/obj2.txt' },
      tool_response: { output: makeLines(2000) },
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('WARNING');
  });

  // --- File size info ---

  it('includes file size info when file exists on disk', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'tguard-'));
    try {
      const filePath = join(tmp, 'large.txt');
      // Create a file large enough to report meaningful size
      writeFileSync(filePath, 'x'.repeat(50000));

      const result = runHook({
        tool_name: 'Read',
        tool_input: { file_path: filePath },
        tool_response: makeLines(2000),
      });
      expect(result.status).toBe(0);
      const output = JSON.parse(result.stdout);
      expect(output.hookSpecificOutput.additionalContext).toContain('file size:');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still warns even when file does not exist on disk (no size info)', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/nonexistent-truncguard-test.txt' },
      tool_response: makeLines(2000),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('WARNING');
    // No file size info since file doesn't exist
    expect(output.hookSpecificOutput.additionalContext).not.toContain('file size:');
  });

  // --- Edge cases / graceful failure ---

  it('handles empty response gracefully', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/empty.txt' },
      tool_response: '',
    });
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });

  it('handles missing file_path gracefully', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: {},
      tool_response: makeLines(2000),
    });
    // Missing file_path — should exit silently (empty filePath guard)
    expect(result.status).toBe(0);
  });

  it('handles missing tool_input gracefully', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_response: makeLines(2000),
    });
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
      expect(err.status).toBe(0);
    }
  });

  it('handles very small explicit limit (limit: 10)', () => {
    const result = runHook({
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/tiny-limit.txt', limit: 10 },
      tool_response: makeLines(10),
    });
    expect(result.status).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.hookSpecificOutput.additionalContext).toContain('limit: 10');
  });
});
