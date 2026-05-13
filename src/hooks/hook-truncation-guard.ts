/**
 * hook-truncation-guard.ts — PostToolUse hook (Read matcher)
 *
 * Detects when a Read tool call likely returned truncated content and injects
 * a warning so the agent knows to use offset/limit for chunked reads.
 *
 * Detection: The Read tool defaults to 2000 lines. If the returned content
 * ends at exactly the limit boundary, the file almost certainly has more
 * content that was silently dropped.
 *
 * Community Call source: James (5/4/2026) — "Claude hard-truncates content
 * over ~2000 chars. It opens the file path but silently skips content."
 * Chief suffered this exact problem analyzing transcripts.
 *
 * Non-blocking: exits 0 with JSON stdout when truncation detected, exits 0
 * silently otherwise.
 */

import { statSync } from 'fs';
import { readStdin } from './index';

/** Default Read tool line limit when no explicit limit is set. */
const DEFAULT_READ_LIMIT = 2000;

async function main(): Promise<void> {
  const input = await readStdin();

  let parsed: any;
  try {
    parsed = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = parsed.tool_name || '';
  if (toolName !== 'Read') {
    process.exit(0);
  }

  const toolInput = parsed.tool_input || {};
  const toolResponse = parsed.tool_response || {};

  const filePath: string = toolInput.file_path || '';
  const explicitLimit: number | undefined = toolInput.limit;
  const offset: number = toolInput.offset || 0;

  // Determine the effective limit used for this read
  const effectiveLimit = explicitLimit || DEFAULT_READ_LIMIT;

  // Extract the response content to count returned lines
  // tool_response can be a string or { content: string }
  const responseText: string =
    typeof toolResponse === 'string'
      ? toolResponse
      : toolResponse.content || toolResponse.output || '';

  if (!responseText || !filePath) {
    process.exit(0);
  }

  // Count the lines returned (Read tool output uses "lineNum\tcontent" format)
  const returnedLines = responseText.split('\n').length;

  // Check if we hit the limit boundary — strong signal of truncation
  // Allow a small margin (±5 lines) for edge cases
  const hitLimit = returnedLines >= effectiveLimit - 5;

  if (!hitLimit) {
    process.exit(0);
  }

  // Double-check: try to get file size for additional confirmation
  let fileSizeInfo = '';
  try {
    const stat = statSync(filePath);
    const totalBytes = stat.size;
    if (totalBytes > 0) {
      fileSizeInfo = ` (file size: ${formatBytes(totalBytes)})`;
    }
  } catch {
    // Can't stat — still warn based on line count alone
  }

  const lastLineRead = offset + returnedLines;
  const warning =
    `WARNING: Read of "${filePath}" returned ${returnedLines} lines (limit: ${effectiveLimit}).` +
    ` Content was likely truncated${fileSizeInfo}.` +
    ` To read the rest, use offset: ${lastLineRead} with an appropriate limit.` +
    ` Do NOT assume you have seen the full file.`;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: warning,
    },
  };

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

main().catch(() => process.exit(0));
