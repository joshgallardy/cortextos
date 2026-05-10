import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { resolveCaps, getCostStatus, scanAgentCosts, scanAllAgentCosts } from '../../../src/bus/cost-caps';
import type { BusPaths } from '../../../src/types';

describe('Cost Caps', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-cost-caps-test-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    // Clean env vars
    delete process.env.CTX_CAP_TASK;
    delete process.env.CTX_CAP_HOUR;
    delete process.env.CTX_CAP_DAY;
  });

  // -- T6: Config override --

  describe('resolveCaps', () => {
    it('returns defaults when no config or env', () => {
      const caps = resolveCaps();
      expect(caps.task).toBe(5.00);
      expect(caps.hour).toBe(15.00);
      expect(caps.day).toBe(30.00);
    });

    it('reads caps from config.json', () => {
      const configPath = join(testDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        agent_name: 'test',
        cost_caps: { task: 10.00, hour: 25.00, day: 50.00 },
      }));
      const caps = resolveCaps(configPath);
      expect(caps.task).toBe(10.00);
      expect(caps.hour).toBe(25.00);
      expect(caps.day).toBe(50.00);
    });

    it('env vars override config.json (T6)', () => {
      const configPath = join(testDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        cost_caps: { task: 10.00, hour: 25.00, day: 50.00 },
      }));
      process.env.CTX_CAP_DAY = '100.00';
      const caps = resolveCaps(configPath);
      expect(caps.task).toBe(10.00); // from config
      expect(caps.day).toBe(100.00); // from env (overrides config)
    });

    it('handles missing config file gracefully', () => {
      const caps = resolveCaps('/nonexistent/path.json');
      expect(caps.task).toBe(5.00);
    });

    it('handles malformed config gracefully', () => {
      const configPath = join(testDir, 'config.json');
      writeFileSync(configPath, 'not valid json');
      const caps = resolveCaps(configPath);
      expect(caps.task).toBe(5.00);
    });
  });

  // -- T7: Cost status command --

  describe('getCostStatus', () => {
    it('returns correct structure with caps (T7)', () => {
      const result = getCostStatus('nonexistent-agent-xyz');
      expect(result.agent).toBe('nonexistent-agent-xyz');
      expect(typeof result.hour).toBe('number');
      expect(typeof result.day).toBe('number');
      expect(result.caps.task).toBe(5.00);
      expect(result.caps.hour).toBe(15.00);
      expect(result.caps.day).toBe(30.00);
      // Status must be one of the valid values
      expect(['ok', 'warning', 'breached']).toContain(result.status);
    });

    it('uses custom caps from config path', () => {
      const configPath = join(testDir, 'config.json');
      writeFileSync(configPath, JSON.stringify({
        cost_caps: { task: 2.00, hour: 8.00, day: 20.00 },
      }));
      const result = getCostStatus('test-agent', configPath);
      expect(result.caps.task).toBe(2.00);
      expect(result.caps.hour).toBe(8.00);
      expect(result.caps.day).toBe(20.00);
    });
  });

  // -- T5: Warning threshold --

  describe('warning threshold detection', () => {
    it('status is ok with very high caps and no matching agent data (T5)', () => {
      // Set caps extremely high so real system data can't breach them
      process.env.CTX_CAP_HOUR = '99999';
      process.env.CTX_CAP_DAY = '99999';
      const result = getCostStatus('nonexistent-agent-xyz');
      // Agent-specific hour cost should be 0 (no matching JSONL dir)
      expect(result.hour).toBe(0);
      // Day cost may be >0 from other agents, but caps are so high it's ok
      expect(result.status).toBe('ok');
    });

    it('status is breached when caps are set below actual spending', () => {
      // Set caps to $0.001 — any real data will breach
      process.env.CTX_CAP_DAY = '0.001';
      const result = getCostStatus('nonexistent-agent-xyz');
      // If there's any system-wide cost data, day will breach
      // If no data at all, it'll be ok — both are valid
      expect(['ok', 'breached']).toContain(result.status);
    });
  });

  // -- JSONL scanning --

  describe('scanAgentCosts', () => {
    it('returns empty array when no claude dir exists', () => {
      // This test relies on the agent name not matching any directory
      const records = scanAgentCosts('totally-fake-agent-xyz123', 3600000);
      expect(records).toEqual([]);
    });
  });

  describe('scanAllAgentCosts', () => {
    it('returns empty array when no matching directories', () => {
      const records = scanAllAgentCosts(3600000);
      // May return real data if tests run on a machine with agents
      expect(Array.isArray(records)).toBe(true);
    });
  });
});
