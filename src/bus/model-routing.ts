/**
 * model-routing.ts — Model resolution for per-cron model overrides.
 *
 * Resolution chain: cron.model > agent config.model > org context.json default > "sonnet"
 *
 * The daemon injects `/model <full-id>` before a cron prompt when the cron
 * specifies a model different from the agent's current session model.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Alias → full model ID mapping (latest models as of 2026-05)
const MODEL_ALIASES: Record<string, string> = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
  opus: 'claude-opus-4-6',
};

const FRAMEWORK_DEFAULT_MODEL = 'sonnet';

/**
 * Resolve a model alias or full ID to its canonical full model ID.
 * Returns the input unchanged if it's already a full ID.
 * Returns undefined if the input is empty/null.
 */
export function resolveModelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const lower = model.trim().toLowerCase();
  return MODEL_ALIASES[lower] ?? model;
}

/**
 * Check if a model string is a known alias or looks like a valid model ID.
 * Unknown models are allowed (graceful fallback) but logged as warnings.
 */
export function isKnownModel(model: string): boolean {
  const lower = model.trim().toLowerCase();
  if (MODEL_ALIASES[lower]) return true;
  // Accept any string that starts with "claude-" as a plausible full ID
  if (lower.startsWith('claude-')) return true;
  return false;
}

/**
 * Get the list of valid model aliases for CLI help/validation messages.
 */
export function getModelAliases(): string[] {
  return Object.keys(MODEL_ALIASES);
}

export interface ModelResolutionContext {
  /** The cron's model field (may be undefined) */
  cronModel?: string;
  /** The agent's config.json model field */
  agentModel?: string;
  /** Path to org context.json (for org-level default) */
  orgContextPath?: string;
}

/**
 * Resolve the effective model for a cron fire.
 *
 * Chain: cron.model > agent config.model > org context.json model_routing.default > framework default
 */
export function resolveEffectiveModel(ctx: ModelResolutionContext): string {
  // 1. Cron-level override
  if (ctx.cronModel) {
    return resolveModelId(ctx.cronModel) ?? ctx.cronModel;
  }

  // 2. Agent config model
  if (ctx.agentModel) {
    return resolveModelId(ctx.agentModel) ?? ctx.agentModel;
  }

  // 3. Org context.json model_routing.default
  if (ctx.orgContextPath && existsSync(ctx.orgContextPath)) {
    try {
      const content = JSON.parse(readFileSync(ctx.orgContextPath, 'utf-8'));
      const orgDefault = content?.model_routing?.default;
      if (orgDefault) {
        return resolveModelId(orgDefault) ?? orgDefault;
      }
    } catch { /* malformed — fall through */ }
  }

  // 4. Framework default
  return resolveModelId(FRAMEWORK_DEFAULT_MODEL)!;
}

/**
 * Determine if a model switch injection is needed for a cron fire.
 *
 * Returns the model ID to switch to, or null if no switch is needed
 * (cron uses same model as the running session).
 */
export function shouldSwitchModel(
  cronModel: string | undefined,
  sessionModel: string | undefined,
): string | null {
  if (!cronModel) return null;

  const cronResolved = resolveModelId(cronModel);
  const sessionResolved = sessionModel ? resolveModelId(sessionModel) : undefined;

  // If cron model is the same as session model, no switch needed
  if (cronResolved === sessionResolved) return null;

  // Return the alias form if it's a known alias (Claude Code accepts aliases)
  const lower = cronModel.trim().toLowerCase();
  if (MODEL_ALIASES[lower]) return lower;

  // Otherwise return full ID
  return cronResolved ?? cronModel;
}
