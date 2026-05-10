/**
 * Cost Enforcement Gates — Three-layer cost cap system.
 *
 * Layers (configurable via env vars or config.json):
 *   1. Per-task:  $5.00  — halt task, notify orchestrator + user
 *   2. Per-hour:  $15.00 — queue new tasks, Telegram alert
 *   3. Per-day:   $30.00 — kill switch, idle all agents until reset
 *
 * Cost data is read from Claude Code JSONL logs at ~/.claude/projects/.
 * Rolling windows: last 1h for hourly, last 24h for daily.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { BusPaths } from '../types/index.js';
import { logEvent } from './event.js';

// -- Pricing per million tokens (must match dashboard/src/lib/cost-parser.ts) --

interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
  cacheWritePerMillion: number;
  cacheReadPerMillion: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  opus: { inputPerMillion: 15, outputPerMillion: 75, cacheWritePerMillion: 3.75, cacheReadPerMillion: 1.50 },
  sonnet: { inputPerMillion: 3, outputPerMillion: 15, cacheWritePerMillion: 3.75, cacheReadPerMillion: 0.30 },
  haiku: { inputPerMillion: 0.8, outputPerMillion: 4, cacheWritePerMillion: 1.00, cacheReadPerMillion: 0.08 },
};

function resolvePricingKey(model: string): string {
  const lower = model.toLowerCase();
  if (lower.includes('opus')) return 'opus';
  if (lower.includes('haiku')) return 'haiku';
  return 'sonnet';
}

function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheWriteTokens: number = 0,
  cacheReadTokens: number = 0,
): number {
  const key = resolvePricingKey(model);
  const pricing = MODEL_PRICING[key] ?? MODEL_PRICING.sonnet;
  const inputCost = (inputTokens / 1_000_000) * pricing.inputPerMillion;
  const outputCost = (outputTokens / 1_000_000) * pricing.outputPerMillion;
  const cacheWriteCost = (cacheWriteTokens / 1_000_000) * pricing.cacheWritePerMillion;
  const cacheReadCost = (cacheReadTokens / 1_000_000) * pricing.cacheReadPerMillion;
  return Math.round((inputCost + outputCost + cacheWriteCost + cacheReadCost) * 1_000_000) / 1_000_000;
}

// -- Cost entry from JSONL parsing --

export interface CostRecord {
  timestamp: number; // epoch ms
  agent: string;
  model: string;
  cost_usd: number;
}

// -- Cap configuration --

export interface CostCaps {
  task: number;
  hour: number;
  day: number;
}

export type CostCapStatus = 'ok' | 'warning' | 'breached';
export type CostCapLayer = 'task' | 'hour' | 'day';

export interface CostStatusResult {
  agent: string;
  hour: number;
  day: number;
  caps: CostCaps;
  status: CostCapStatus;
  breached_layer?: CostCapLayer;
}

// -- Default caps --

const DEFAULT_CAPS: CostCaps = {
  task: 5.00,
  hour: 15.00,
  day: 30.00,
};

/**
 * Resolve cost caps from environment variables, then config.json, then defaults.
 */
export function resolveCaps(agentConfigPath?: string): CostCaps {
  const caps = { ...DEFAULT_CAPS };

  // Layer 1: config.json overrides
  if (agentConfigPath && existsSync(agentConfigPath)) {
    try {
      const config = JSON.parse(readFileSync(agentConfigPath, 'utf-8'));
      if (config.cost_caps) {
        if (typeof config.cost_caps.task === 'number') caps.task = config.cost_caps.task;
        if (typeof config.cost_caps.hour === 'number') caps.hour = config.cost_caps.hour;
        if (typeof config.cost_caps.day === 'number') caps.day = config.cost_caps.day;
      }
    } catch {
      // ignore malformed config
    }
  }

  // Layer 2: env vars override config.json
  const envTask = process.env.CTX_CAP_TASK;
  const envHour = process.env.CTX_CAP_HOUR;
  const envDay = process.env.CTX_CAP_DAY;
  if (envTask && !isNaN(parseFloat(envTask))) caps.task = parseFloat(envTask);
  if (envHour && !isNaN(parseFloat(envHour))) caps.hour = parseFloat(envHour);
  if (envDay && !isNaN(parseFloat(envDay))) caps.day = parseFloat(envDay);

  return caps;
}

// -- JSONL parsing (ported from dashboard/src/lib/cost-parser.ts) --

/**
 * Scan Claude Code JSONL logs for a specific agent and return cost records
 * within the specified time window.
 */
export function scanAgentCosts(agentName: string, windowMs: number): CostRecord[] {
  const claudeDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeDir)) return [];

  const cutoff = Date.now() - windowMs;
  const records: CostRecord[] = [];

  try {
    const projectDirs = readdirSync(claudeDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      if (!dir.name.includes('agents')) continue;

      // Match agent name in directory path
      const parts = dir.name.split('-');
      const agentsIdx = parts.lastIndexOf('agents');
      const dirAgentName = agentsIdx >= 0 && agentsIdx < parts.length - 1
        ? parts.slice(agentsIdx + 1).join('-')
        : '';

      if (dirAgentName !== agentName) continue;

      const projectPath = join(claudeDir, dir.name);
      const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = join(projectPath, file);

        // Skip files older than our window (optimization)
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;
        } catch {
          continue;
        }

        parseJsonlForCosts(filePath, agentName, cutoff, records);
      }
    }
  } catch {
    // Directory scan failed
  }

  return records;
}

/**
 * Scan ALL agents' costs within a time window. Used for daily cap (system-wide).
 */
export function scanAllAgentCosts(windowMs: number): CostRecord[] {
  const claudeDir = join(homedir(), '.claude', 'projects');
  if (!existsSync(claudeDir)) return [];

  const cutoff = Date.now() - windowMs;
  const records: CostRecord[] = [];

  try {
    const projectDirs = readdirSync(claudeDir, { withFileTypes: true });

    for (const dir of projectDirs) {
      if (!dir.isDirectory()) continue;
      if (!dir.name.includes('agents')) continue;

      const parts = dir.name.split('-');
      const agentsIdx = parts.lastIndexOf('agents');
      const agentName = agentsIdx >= 0 && agentsIdx < parts.length - 1
        ? parts.slice(agentsIdx + 1).join('-')
        : dir.name;

      const projectPath = join(claudeDir, dir.name);
      const files = readdirSync(projectPath).filter(f => f.endsWith('.jsonl'));

      for (const file of files) {
        const filePath = join(projectPath, file);
        try {
          const stat = statSync(filePath);
          if (stat.mtimeMs < cutoff) continue;
        } catch {
          continue;
        }
        parseJsonlForCosts(filePath, agentName, cutoff, records);
      }
    }
  } catch {
    // Directory scan failed
  }

  return records;
}

function parseJsonlForCosts(
  filePath: string,
  agentName: string,
  cutoffMs: number,
  records: CostRecord[],
): void {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return;
  }

  const lines = content.split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      const raw = parsed.message ?? parsed;
      const model = raw.model;
      if (!model) continue;

      const inputTokens = raw.input_tokens ?? raw.usage?.input_tokens ?? 0;
      const outputTokens = raw.output_tokens ?? raw.usage?.output_tokens ?? 0;
      const cacheWriteTokens = raw.usage?.cache_creation_input_tokens ?? 0;
      const cacheReadTokens = raw.usage?.cache_read_input_tokens ?? 0;

      if (inputTokens === 0 && outputTokens === 0 && cacheWriteTokens === 0 && cacheReadTokens === 0) continue;

      const timestamp = parsed.timestamp ?? raw.timestamp;
      const tsMs = timestamp ? new Date(timestamp).getTime() : 0;
      if (tsMs < cutoffMs) continue;

      const cost = raw.costUSD ?? calculateCost(model, inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens);

      records.push({
        timestamp: tsMs,
        agent: agentName,
        model,
        cost_usd: cost,
      });
    } catch {
      // Skip malformed lines
    }
  }
}

// -- Cost status query --

const ONE_HOUR_MS = 3600 * 1000;
const ONE_DAY_MS = 86400 * 1000;

/**
 * Get current cost status for an agent.
 * Scans JSONL logs and computes rolling window totals.
 */
export function getCostStatus(agentName: string, agentConfigPath?: string): CostStatusResult {
  const caps = resolveCaps(agentConfigPath);

  // Scan costs for this agent in the last hour
  const hourRecords = scanAgentCosts(agentName, ONE_HOUR_MS);
  const hourTotal = hourRecords.reduce((sum, r) => sum + r.cost_usd, 0);

  // Scan ALL agents for daily cap (system-wide)
  const dayRecords = scanAllAgentCosts(ONE_DAY_MS);
  const dayTotal = dayRecords.reduce((sum, r) => sum + r.cost_usd, 0);

  // Determine status
  let status: CostCapStatus = 'ok';
  let breached_layer: CostCapLayer | undefined;

  if (dayTotal >= caps.day) {
    status = 'breached';
    breached_layer = 'day';
  } else if (hourTotal >= caps.hour) {
    status = 'breached';
    breached_layer = 'hour';
  } else if (hourTotal >= caps.hour * 0.8 || dayTotal >= caps.day * 0.8) {
    status = 'warning';
  }

  return {
    agent: agentName,
    hour: Math.round(hourTotal * 100) / 100,
    day: Math.round(dayTotal * 100) / 100,
    caps,
    status,
    ...(breached_layer ? { breached_layer } : {}),
  };
}

/**
 * Check cost status and log events / return breach info.
 * Called by the fast-checker on every poll cycle.
 */
export function checkCostCaps(
  agentName: string,
  paths: BusPaths,
  org: string,
  agentConfigPath?: string,
): CostStatusResult {
  const result = getCostStatus(agentName, agentConfigPath);

  if (result.status === 'warning') {
    logEvent(paths, agentName, org, 'action', 'cost_cap_warning', 'warning', {
      agent: agentName,
      hour: result.hour,
      day: result.day,
      caps: result.caps,
    });
  } else if (result.status === 'breached') {
    logEvent(paths, agentName, org, 'error', 'cost_cap_breached', 'error', {
      agent: agentName,
      layer: result.breached_layer,
      hour: result.hour,
      day: result.day,
      caps: result.caps,
    });
  }

  return result;
}
