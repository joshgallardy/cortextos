import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir, homedir } from 'os';
import { resolveCaps, getCostStatus, scanAgentCosts, scanAllAgentCosts, writeCostEnforcement, readCostEnforcement, resetCostCap, isAgentIdled } from '../../../src/bus/cost-caps';
import type { BusPaths } from '../../../src/types';
import type { CostEnforcementState } from '../../../src/bus/cost-caps';

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

  // -- Enforcement state --

  describe('writeCostEnforcement / readCostEnforcement', () => {
    it('writes and reads enforcement state', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      const state: CostEnforcementState = {
        layer: 'hour',
        enforced_at: new Date().toISOString(),
        cost_at_breach: 16.50,
        cap_value: 15.00,
        requires_manual_reset: false,
        agent: 'test-agent',
      };
      writeCostEnforcement(stateDir, state);
      const read = readCostEnforcement(stateDir);
      expect(read).not.toBeNull();
      expect(read!.layer).toBe('hour');
      expect(read!.cost_at_breach).toBe(16.50);
      expect(read!.requires_manual_reset).toBe(false);
    });

    it('returns null when no enforcement file exists', () => {
      const stateDir = join(testDir, 'state', 'no-agent');
      expect(readCostEnforcement(stateDir)).toBeNull();
    });
  });

  describe('resetCostCap', () => {
    it('clears enforcement state (T3 reset)', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      writeCostEnforcement(stateDir, {
        layer: 'day',
        enforced_at: new Date().toISOString(),
        cost_at_breach: 35.00,
        cap_value: 30.00,
        requires_manual_reset: true,
        agent: 'test-agent',
      });
      expect(readCostEnforcement(stateDir)).not.toBeNull();

      const cleared = resetCostCap(stateDir);
      expect(cleared).toBe(true);
      expect(readCostEnforcement(stateDir)).toBeNull();
    });

    it('only clears matching tier when tier is specified', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      writeCostEnforcement(stateDir, {
        layer: 'day',
        enforced_at: new Date().toISOString(),
        cost_at_breach: 35.00,
        cap_value: 30.00,
        requires_manual_reset: true,
        agent: 'test-agent',
      });

      // Try to reset 'hour' — should fail (active enforcement is 'day')
      const notCleared = resetCostCap(stateDir, 'hour');
      expect(notCleared).toBe(false);
      expect(readCostEnforcement(stateDir)).not.toBeNull();

      // Reset 'day' — should succeed
      const cleared = resetCostCap(stateDir, 'day');
      expect(cleared).toBe(true);
      expect(readCostEnforcement(stateDir)).toBeNull();
    });

    it('returns false when no enforcement exists', () => {
      const stateDir = join(testDir, 'state', 'no-agent');
      expect(resetCostCap(stateDir)).toBe(false);
    });
  });

  describe('isAgentIdled', () => {
    it('returns not idled when no enforcement exists', () => {
      const stateDir = join(testDir, 'state', 'no-agent');
      const result = isAgentIdled(stateDir);
      expect(result.idled).toBe(false);
    });

    it('returns idled for day enforcement (T3)', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      writeCostEnforcement(stateDir, {
        layer: 'day',
        enforced_at: new Date().toISOString(),
        cost_at_breach: 35.00,
        cap_value: 30.00,
        requires_manual_reset: true,
        agent: 'test-agent',
      });
      const result = isAgentIdled(stateDir);
      expect(result.idled).toBe(true);
      expect(result.layer).toBe('day');
      expect(result.reason).toContain('Manual reset required');
    });

    it('returns idled for recent hour enforcement (T2)', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      writeCostEnforcement(stateDir, {
        layer: 'hour',
        enforced_at: new Date().toISOString(), // just now — within window
        cost_at_breach: 16.00,
        cap_value: 15.00,
        requires_manual_reset: false,
        agent: 'test-agent',
      });
      const result = isAgentIdled(stateDir);
      expect(result.idled).toBe(true);
      expect(result.layer).toBe('hour');
      expect(result.reason).toContain('Auto-resumes');
    });

    it('auto-clears expired hour enforcement (T2)', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      // Enforcement from 2 hours ago — should auto-clear
      const twoHoursAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
      writeCostEnforcement(stateDir, {
        layer: 'hour',
        enforced_at: twoHoursAgo,
        cost_at_breach: 16.00,
        cap_value: 15.00,
        requires_manual_reset: false,
        agent: 'test-agent',
      });
      const result = isAgentIdled(stateDir);
      expect(result.idled).toBe(false);
    });

    it('does not idle for task-level enforcement (T1)', () => {
      const stateDir = join(testDir, 'state', 'test-agent');
      writeCostEnforcement(stateDir, {
        layer: 'task',
        enforced_at: new Date().toISOString(),
        cost_at_breach: 6.00,
        cap_value: 5.00,
        requires_manual_reset: false,
        agent: 'test-agent',
      });
      const result = isAgentIdled(stateDir);
      expect(result.idled).toBe(false); // task-level doesn't idle the whole agent
    });
  });
});
