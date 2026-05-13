import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  parseTranscript,
  parseSkillSteps,
  auditTranscript,
  formatAuditReport,
} from '../../../src/bus/transcript-audit';

describe('transcript-audit', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'cortextos-audit-'));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  describe('parseTranscript', () => {
    it('parses tool_use blocks from assistant messages', () => {
      const transcript = [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }),
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'ls -la' } },
              { type: 'tool_use', id: '2', name: 'Read', input: { file_path: '/tmp/test.txt' } },
            ],
          },
        }),
      ].join('\n');

      const path = join(testDir, 'test.jsonl');
      writeFileSync(path, transcript);
      const actions = parseTranscript(path);

      expect(actions).toHaveLength(2);
      expect(actions[0].type).toBe('tool_use');
      expect(actions[0].tool).toBe('Bash');
      expect(actions[0].summary).toContain('ls -la');
      expect(actions[1].tool).toBe('Read');
      expect(actions[1].summary).toContain('/tmp/test.txt');
    });

    it('parses text output blocks', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Here is my analysis of the code.' }],
        },
      });

      const path = join(testDir, 'test.jsonl');
      writeFileSync(path, transcript);
      const actions = parseTranscript(path);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('text_output');
      expect(actions[0].summary).toContain('analysis');
    });

    it('parses thinking blocks', () => {
      const transcript = JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'thinking', thinking: 'Let me think about this carefully.' }],
        },
      });

      const path = join(testDir, 'test.jsonl');
      writeFileSync(path, transcript);
      const actions = parseTranscript(path);

      expect(actions).toHaveLength(1);
      expect(actions[0].type).toBe('thinking');
    });

    it('skips non-assistant entries', () => {
      const transcript = [
        JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions' }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
        JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      ].join('\n');

      const path = join(testDir, 'test.jsonl');
      writeFileSync(path, transcript);
      const actions = parseTranscript(path);

      expect(actions).toHaveLength(0);
    });

    it('throws on missing file', () => {
      expect(() => parseTranscript('/nonexistent/path.jsonl')).toThrow('Transcript not found');
    });
  });

  describe('parseSkillSteps', () => {
    it('extracts steps from numbered code comments', () => {
      const skill = `---
name: test-skill
description: "test"
triggers: []
---

# Test Skill

\`\`\`bash
# 1. Update the heartbeat
cortextos bus update-heartbeat "active"

# 2. Check inbox
cortextos bus check-inbox

# 3. Log event
cortextos bus log-event heartbeat agent_heartbeat info
\`\`\`
`;
      const path = join(testDir, 'SKILL.md');
      writeFileSync(path, skill);
      const { name, steps } = parseSkillSteps(path);

      expect(name).toBe('test-skill');
      expect(steps).toHaveLength(3);
      expect(steps[0].text).toBe('Update the heartbeat');
      expect(steps[0].command).toContain('update-heartbeat');
      expect(steps[1].text).toBe('Check inbox');
      expect(steps[2].text).toBe('Log event');
    });

    it('extracts steps from numbered lists outside code blocks', () => {
      const skill = `---
name: numbered-skill
---

# Steps

1. Create the task before starting
2. Mark it in progress
3. Complete with result summary
`;
      const path = join(testDir, 'SKILL.md');
      writeFileSync(path, skill);
      const { steps } = parseSkillSteps(path);

      expect(steps).toHaveLength(3);
      expect(steps[0].text).toBe('Create the task before starting');
      expect(steps[1].text).toBe('Mark it in progress');
    });

    it('marks required steps correctly', () => {
      const skill = `---
name: required-test
---

# Steps

1. You must always update heartbeat
2. Optionally check the logs
`;
      const path = join(testDir, 'SKILL.md');
      writeFileSync(path, skill);
      const { steps } = parseSkillSteps(path);

      expect(steps[0].required).toBe(true);
      expect(steps[1].required).toBe(false);
    });

    it('handles missing frontmatter gracefully', () => {
      const skill = `# No Frontmatter Skill

1. Do something
`;
      const path = join(testDir, 'SKILL.md');
      writeFileSync(path, skill);
      const { name, steps } = parseSkillSteps(path);

      // Falls back to directory name
      expect(name).toBeDefined();
      expect(steps).toHaveLength(1);
    });

    it('throws on missing file', () => {
      expect(() => parseSkillSteps('/nonexistent/SKILL.md')).toThrow('Skill file not found');
    });
  });

  describe('auditTranscript', () => {
    it('scores 100% when all steps have evidence', () => {
      const actions = [
        { index: 0, type: 'tool_use' as const, tool: 'Bash', summary: 'Bash: cortextos bus update-heartbeat "working"' },
        { index: 1, type: 'tool_use' as const, tool: 'Bash', summary: 'Bash: cortextos bus check-inbox' },
        { index: 2, type: 'tool_use' as const, tool: 'Bash', summary: 'Bash: cortextos bus log-event heartbeat agent_heartbeat info' },
      ];

      const steps = [
        { index: 0, text: 'Update the heartbeat', command: 'cortextos bus update-heartbeat', required: true },
        { index: 1, text: 'Check inbox', command: 'cortextos bus check-inbox', required: true },
        { index: 2, text: 'Log heartbeat event', command: 'cortextos bus log-event heartbeat', required: false },
      ];

      const result = auditTranscript(actions, 'heartbeat', steps);

      expect(result.complianceScore).toBe(100);
      expect(result.stepsFollowed).toBe(3);
      expect(result.stepsSkipped).toBe(0);
    });

    it('detects skipped steps', () => {
      const actions = [
        { index: 0, type: 'tool_use' as const, tool: 'Bash', summary: 'Bash: cortextos bus update-heartbeat "idle"' },
      ];

      const steps = [
        { index: 0, text: 'Update heartbeat', command: 'cortextos bus update-heartbeat', required: true },
        { index: 1, text: 'Check inbox', command: 'cortextos bus check-inbox', required: true },
      ];

      const result = auditTranscript(actions, 'test', steps);

      expect(result.complianceScore).toBe(50);
      expect(result.stepsSkipped).toBe(1);
      expect(result.deviations.some(d => d.type === 'skipped')).toBe(true);
    });

    it('generates suggestions for required skipped steps', () => {
      const actions: any[] = [];
      const steps = [
        { index: 0, text: 'You must always update heartbeat', command: 'cortextos bus update-heartbeat', required: true },
      ];

      const result = auditTranscript(actions, 'test', steps);

      expect(result.suggestions.some(s => s.includes('CRITICAL'))).toBe(true);
    });

    it('handles empty steps gracefully', () => {
      const actions = [
        { index: 0, type: 'tool_use' as const, tool: 'Bash', summary: 'Bash: ls -la' },
      ];

      const result = auditTranscript(actions, 'empty', []);

      expect(result.complianceScore).toBe(100);
      expect(result.totalSteps).toBe(0);
    });
  });

  describe('formatAuditReport', () => {
    it('produces readable markdown output', () => {
      const result = {
        skillName: 'test-skill',
        totalSteps: 3,
        stepsFollowed: 2,
        stepsSkipped: 1,
        complianceScore: 67,
        deviations: [
          {
            step: { index: 2, text: 'Log event', required: false },
            type: 'skipped' as const,
            detail: 'No evidence of: "Log event"',
          },
        ],
        actionSummary: [
          { index: 0, type: 'tool_use' as const, tool: 'Bash', summary: 'Bash: update-heartbeat' },
        ],
        suggestions: ['No significant deviations detected.'],
      };

      const report = formatAuditReport(result);

      expect(report).toContain('# Transcript Audit Report: test-skill');
      expect(report).toContain('67%');
      expect(report).toContain('2/3');
      expect(report).toContain('[SKIP]');
      expect(report).toContain('Suggestions');
    });
  });
});
