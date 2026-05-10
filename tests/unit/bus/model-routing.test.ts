import { describe, it, expect } from 'vitest';
import {
  resolveModelId,
  isKnownModel,
  getModelAliases,
  resolveEffectiveModel,
  shouldSwitchModel,
} from '../../../src/bus/model-routing';

describe('Model Routing', () => {
  describe('resolveModelId', () => {
    it('resolves "haiku" alias to full ID', () => {
      expect(resolveModelId('haiku')).toBe('claude-haiku-4-5-20251001');
    });

    it('resolves "sonnet" alias to full ID', () => {
      expect(resolveModelId('sonnet')).toBe('claude-sonnet-4-6');
    });

    it('resolves "opus" alias to full ID', () => {
      expect(resolveModelId('opus')).toBe('claude-opus-4-6');
    });

    it('is case-insensitive', () => {
      expect(resolveModelId('Haiku')).toBe('claude-haiku-4-5-20251001');
      expect(resolveModelId('OPUS')).toBe('claude-opus-4-6');
    });

    it('passes through full model IDs unchanged', () => {
      expect(resolveModelId('claude-sonnet-4-6')).toBe('claude-sonnet-4-6');
    });

    it('returns undefined for empty/null input', () => {
      expect(resolveModelId(undefined)).toBeUndefined();
      expect(resolveModelId('')).toBeUndefined();
    });
  });

  describe('isKnownModel', () => {
    it('recognizes aliases', () => {
      expect(isKnownModel('haiku')).toBe(true);
      expect(isKnownModel('sonnet')).toBe(true);
      expect(isKnownModel('opus')).toBe(true);
    });

    it('recognizes full claude-* IDs', () => {
      expect(isKnownModel('claude-sonnet-4-6')).toBe(true);
      expect(isKnownModel('claude-haiku-4-5-20251001')).toBe(true);
    });

    it('returns false for unknown models (T7 graceful fallback)', () => {
      expect(isKnownModel('gpt-4')).toBe(false);
      expect(isKnownModel('nonexistent')).toBe(false);
    });
  });

  describe('getModelAliases', () => {
    it('returns known aliases', () => {
      const aliases = getModelAliases();
      expect(aliases).toContain('haiku');
      expect(aliases).toContain('sonnet');
      expect(aliases).toContain('opus');
    });
  });

  describe('resolveEffectiveModel', () => {
    it('uses cron model when specified (T1/T2)', () => {
      const result = resolveEffectiveModel({
        cronModel: 'haiku',
        agentModel: 'opus',
      });
      expect(result).toBe('claude-haiku-4-5-20251001');
    });

    it('falls back to agent model when cron has no model (T3)', () => {
      const result = resolveEffectiveModel({
        cronModel: undefined,
        agentModel: 'opus',
      });
      expect(result).toBe('claude-opus-4-6');
    });

    it('falls back to framework default (sonnet) when nothing specified (T3)', () => {
      const result = resolveEffectiveModel({
        cronModel: undefined,
        agentModel: undefined,
      });
      expect(result).toBe('claude-sonnet-4-6');
    });

    it('handles full model IDs as cron model', () => {
      const result = resolveEffectiveModel({
        cronModel: 'claude-opus-4-6',
        agentModel: 'sonnet',
      });
      expect(result).toBe('claude-opus-4-6');
    });
  });

  describe('shouldSwitchModel', () => {
    it('returns null when cron has no model override', () => {
      expect(shouldSwitchModel(undefined, 'opus')).toBeNull();
    });

    it('returns null when cron model matches session model', () => {
      expect(shouldSwitchModel('opus', 'opus')).toBeNull();
      expect(shouldSwitchModel('claude-opus-4-6', 'opus')).toBeNull();
    });

    it('returns alias when switching to a different known model (T1)', () => {
      const result = shouldSwitchModel('haiku', 'opus');
      expect(result).toBe('haiku');
    });

    it('returns alias for sonnet switch (T2)', () => {
      const result = shouldSwitchModel('sonnet', 'opus');
      expect(result).toBe('sonnet');
    });

    it('returns full ID for non-alias model strings', () => {
      const result = shouldSwitchModel('claude-haiku-4-5-20251001', 'opus');
      expect(result).toBe('claude-haiku-4-5-20251001');
    });

    it('handles undefined session model', () => {
      const result = shouldSwitchModel('haiku', undefined);
      expect(result).toBe('haiku');
    });

    it('handles unknown model gracefully (T7)', () => {
      const result = shouldSwitchModel('nonexistent', 'opus');
      expect(result).toBe('nonexistent');
    });
  });
});
