/**
 * hook-prereply-recall.ts — PreToolUse hook (Bash matcher)
 *
 * Fires before any Bash call. If the command is `cortextos bus send-telegram`
 * or `cortextos bus send-message`, queries KB for context relevant to the
 * reply content and injects it via additionalContext.
 *
 * Covers recall gaps #1 (no KB query before Telegram replies) and #4
 * (no KB query before agent-to-agent replies) from the memory recall
 * evaluation (specs/memory-combo-evaluation.md, Phase 2).
 *
 * Non-blocking: exits 0 with JSON stdout on match, exits 0 silently on no-match.
 * Skips system messages (boot, heartbeat, restart notifications) to avoid
 * unnecessary KB queries on non-conversational output.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { readStdin, loadEnv } from './index';

/** Matches: cortextos bus send-telegram <chat_id> '<message>' or "<message>" */
const SEND_TELEGRAM_RE = /cortextos\s+bus\s+send-telegram\s+\S+\s+(['"])([\s\S]*?)\1/;

/** Matches: cortextos bus send-message <agent> <priority> '<message>' */
const SEND_MESSAGE_RE = /cortextos\s+bus\s+send-message\s+\S+\s+\S+\s+(['"])([\s\S]*?)\1/;

/** System messages that don't need recall — short status/boot messages */
const SKIP_PATTERNS = [
  /^booting up/i,
  /^back online/i,
  /^restarting/i,
  /^heartbeat/i,
  /^context window full/i,
  /^standing down/i,
  /^online\b/i,
  /^copy\./i,
  /^ack\b/i,
  /^got it\b/i,
];

/** Minimum message length worth querying KB for */
const MIN_MESSAGE_LENGTH = 30;

async function main(): Promise<void> {
  const input = await readStdin();

  let parsed: any;
  try {
    parsed = JSON.parse(input);
  } catch {
    process.exit(0);
  }

  const toolName = parsed.tool_name || '';
  const toolInput = parsed.tool_input || {};

  if (toolName !== 'Bash') {
    process.exit(0);
  }

  const command: string = toolInput.command || '';

  // Try to extract message text from send-telegram or send-message
  let messageText: string | null = null;
  let replyType: 'telegram' | 'agent' | null = null;

  const telegramMatch = command.match(SEND_TELEGRAM_RE);
  if (telegramMatch) {
    messageText = telegramMatch[2];
    replyType = 'telegram';
  }

  if (!messageText) {
    const agentMatch = command.match(SEND_MESSAGE_RE);
    if (agentMatch) {
      messageText = agentMatch[2];
      replyType = 'agent';
    }
  }

  if (!messageText || !replyType) {
    process.exit(0);
  }

  // Skip short system messages
  if (messageText.length < MIN_MESSAGE_LENGTH) {
    process.exit(0);
  }

  // Skip known system/status patterns
  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(messageText.trim())) {
      process.exit(0);
    }
  }

  const env = loadEnv();

  // Query KB for context relevant to this reply (best-effort, 3s timeout)
  const kbContext = queryKB(messageText, env.agentName);
  if (!kbContext) {
    process.exit(0);
  }

  const context = `[Pre-reply recall — ${replyType} message]\n\nRelevant KB context for your reply:\n${kbContext}\n\nUse this context to improve your reply if relevant. Ignore if not applicable.`;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: context,
    },
  };

  process.stdout.write(JSON.stringify(output) + '\n');
  process.exit(0);
}

/**
 * Query KB via cortextos CLI (best-effort, 3s timeout).
 * Extracts key terms from the message to form a focused query.
 */
function queryKB(message: string, agentName: string): string | null {
  const org = process.env.CTX_ORG;
  if (!org) return null;

  // Use first 200 chars of message as query — enough for semantic match
  const query = message.slice(0, 200).replace(/"/g, '\\"');

  try {
    const result = execSync(
      `cortextos bus kb-query "${query}" --org ${org} --agent ${agentName} --top-k 3 --threshold 0.6`,
      { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const trimmed = result.trim();
    if (!trimmed || trimmed.startsWith('No results')) return null;
    // Cap at 1000 chars to avoid bloating context on every reply
    return trimmed.length > 1000 ? trimmed.slice(0, 1000) + '...(truncated)' : trimmed;
  } catch {
    return null;
  }
}

main().catch(() => process.exit(0));
