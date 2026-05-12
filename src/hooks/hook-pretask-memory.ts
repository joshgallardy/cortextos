/**
 * hook-pretask-memory.ts — PreToolUse hook (Bash matcher)
 *
 * Fires before any Bash call. If the command is `cortextos bus update-task <id> in_progress`,
 * queries KB + daily memory for context relevant to the task, then injects that
 * context via additionalContext so the agent has recall before starting work.
 *
 * Community Call source: James + David (5/4/2026) — independently arrived at the
 * same conclusion that agents skip recall when given the choice; forcing it at
 * task boundaries is the best current tradeoff.
 *
 * Non-blocking: exits 0 with JSON stdout on match, exits 0 silently on no-match.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { readStdin, loadEnv } from './index';

/** Matches: cortextos bus update-task <id> in_progress */
const TASK_START_RE = /cortextos\s+bus\s+update-task\s+(\S+)\s+in_progress/;

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

  // Only fire on Bash commands that start a task
  if (toolName !== 'Bash') {
    process.exit(0);
  }

  const command: string = toolInput.command || '';
  const match = command.match(TASK_START_RE);
  if (!match) {
    process.exit(0);
  }

  const taskId = match[1];
  const env = loadEnv();

  // --- Gather context ---
  const chunks: string[] = [];

  // 1. Try to read the task itself for its title/description
  const taskTitle = readTaskTitle(taskId);
  if (taskTitle) {
    chunks.push(`Task: ${taskTitle}`);
  }

  // 2. Query KB for relevant context (best-effort, 3s timeout)
  const kbContext = queryKB(taskTitle || taskId, env.agentName);
  if (kbContext) {
    chunks.push(`--- KB results ---\n${kbContext}`);
  }

  // 3. Read today's daily memory (best-effort)
  const dailyMemory = readDailyMemory();
  if (dailyMemory) {
    chunks.push(`--- Today's memory ---\n${dailyMemory}`);
  }

  if (chunks.length === 0) {
    // Nothing to inject
    process.exit(0);
  }

  // Output additionalContext
  const context = `[Pre-task recall for ${taskId}]\n\n${chunks.join('\n\n')}`;
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
 * Read the task JSON to get its title.
 * Looks in the standard cortextOS task dirs.
 */
function readTaskTitle(taskId: string): string | null {
  const agentName = process.env.CTX_AGENT_NAME;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  if (!agentName) return null;

  const { homedir } = require('os');
  const taskDir = join(
    homedir(),
    '.cortextos',
    instanceId,
    'state',
    agentName,
    'tasks',
  );

  const taskFile = join(taskDir, `${taskId}.json`);
  try {
    if (!existsSync(taskFile)) return null;
    const data = JSON.parse(readFileSync(taskFile, 'utf-8'));
    const parts = [data.title];
    if (data.description) parts.push(data.description);
    return parts.join(' — ');
  } catch {
    return null;
  }
}

/**
 * Query KB via cortextos CLI (best-effort, 3s timeout).
 */
function queryKB(query: string, agentName: string): string | null {
  const org = process.env.CTX_ORG;
  if (!org || !query) return null;

  try {
    const result = execSync(
      `cortextos bus kb-query "${query.replace(/"/g, '\\"')}" --org ${org} --agent ${agentName} --top-k 3 --threshold 0.6`,
      { timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const trimmed = result.trim();
    if (!trimmed || trimmed.startsWith('No results')) return null;
    // Cap at 1500 chars to avoid bloating context
    return trimmed.length > 1500 ? trimmed.slice(0, 1500) + '...(truncated)' : trimmed;
  } catch {
    return null;
  }
}

/**
 * Read today's daily memory file (best-effort).
 */
function readDailyMemory(): string | null {
  try {
    const today = new Date().toISOString().slice(0, 10);
    // Look in the agent's working directory
    const cwd = process.cwd();
    const memPath = join(cwd, 'memory', `${today}.md`);
    if (!existsSync(memPath)) return null;
    const content = readFileSync(memPath, 'utf-8').trim();
    if (!content) return null;
    // Cap at 1000 chars — just the recent entries matter
    return content.length > 1000 ? content.slice(-1000) : content;
  } catch {
    return null;
  }
}

main().catch(() => process.exit(0));
