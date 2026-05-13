/**
 * transcript-audit.ts — Parse and audit a Claude Code session transcript
 * against a skill definition to identify compliance gaps.
 *
 * Community Call source: James (5/4/2026, classroom skill).
 */

import { readFileSync, existsSync } from 'fs';

// --- Types ---

export interface TranscriptAction {
  index: number;
  type: 'tool_use' | 'text_output' | 'thinking';
  tool?: string;
  summary: string;
  timestamp?: string;
}

export interface SkillStep {
  index: number;
  text: string;
  command?: string;        // extracted bash command if present
  required: boolean;       // steps with "must", "always", "required" etc.
}

export interface AuditDeviation {
  step: SkillStep;
  type: 'skipped' | 'partial' | 'out_of_order' | 'improvised';
  detail: string;
}

export interface AuditResult {
  skillName: string;
  totalSteps: number;
  stepsFollowed: number;
  stepsSkipped: number;
  complianceScore: number; // 0-100
  deviations: AuditDeviation[];
  actionSummary: TranscriptAction[];
  suggestions: string[];
}

// --- Transcript Parsing ---

export function parseTranscript(jsonlPath: string): TranscriptAction[] {
  if (!existsSync(jsonlPath)) {
    throw new Error(`Transcript not found: ${jsonlPath}`);
  }

  const raw = readFileSync(jsonlPath, 'utf-8');
  const lines = raw.split('\n').filter(l => l.trim());
  const actions: TranscriptAction[] = [];
  let idx = 0;

  for (const line of lines) {
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;

      for (const block of content) {
        if (block.type === 'tool_use') {
          const input = block.input || {};
          let summary: string;
          switch (block.name) {
            case 'Bash':
              summary = `Bash: ${truncate(input.command || '', 120)}`;
              break;
            case 'Read':
              summary = `Read: ${input.file_path || 'unknown'}`;
              break;
            case 'Edit':
              summary = `Edit: ${input.file_path || 'unknown'}`;
              break;
            case 'Write':
              summary = `Write: ${input.file_path || 'unknown'}`;
              break;
            case 'Grep':
              summary = `Grep: "${truncate(input.pattern || '', 60)}" in ${input.path || 'cwd'}`;
              break;
            case 'Glob':
              summary = `Glob: ${input.pattern || 'unknown'}`;
              break;
            default:
              summary = `${block.name}: ${truncate(JSON.stringify(input), 100)}`;
          }
          actions.push({ index: idx++, type: 'tool_use', tool: block.name, summary });
        } else if (block.type === 'text' && block.text) {
          const text = block.text.trim();
          if (text.length > 0) {
            actions.push({ index: idx++, type: 'text_output', summary: truncate(text, 150) });
          }
        } else if (block.type === 'thinking' && block.thinking) {
          actions.push({
            index: idx++,
            type: 'thinking',
            summary: truncate(block.thinking, 150),
          });
        }
      }
    }
  }

  return actions;
}

// --- Skill Parsing ---

export function parseSkillSteps(skillPath: string): { name: string; steps: SkillStep[] } {
  if (!existsSync(skillPath)) {
    throw new Error(`Skill file not found: ${skillPath}`);
  }

  const raw = readFileSync(skillPath, 'utf-8');
  // Parse YAML frontmatter manually (avoid gray-matter dependency)
  let content = raw;
  let name = skillPath.split('/').slice(-2, -1)[0] || 'unknown';
  if (raw.startsWith('---')) {
    const endIdx = raw.indexOf('---', 3);
    if (endIdx !== -1) {
      const fm = raw.slice(3, endIdx);
      content = raw.slice(endIdx + 3).trim();
      const nameMatch = fm.match(/^name:\s*["']?([^"'\n]+)["']?/m);
      if (nameMatch) name = nameMatch[1].trim();
    }
  }

  const steps: SkillStep[] = [];
  const lines = content.split('\n');
  let stepIdx = 0;
  let inCodeBlock = false;
  let pendingCommand = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        // Closing — attach command to the previous step
        if (pendingCommand && steps.length > 0) {
          steps[steps.length - 1].command = pendingCommand.trim();
        }
        pendingCommand = '';
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        pendingCommand = '';
      }
      continue;
    }

    if (inCodeBlock) {
      // Extract numbered comments as steps (e.g. "# 1. Update heartbeat")
      const codeComment = line.match(/^#\s+(\d+)[.)]\s+(.+)/);
      if (codeComment) {
        const text = codeComment[2].trim();
        steps.push({
          index: stepIdx++,
          text,
          required: isRequired(text),
        });
      }
      pendingCommand += line + '\n';
      // Attach non-comment lines as command to the most recent step
      if (!codeComment && line.trim() && !line.trim().startsWith('#') && steps.length > 0 && !steps[steps.length - 1].command) {
        steps[steps.length - 1].command = line.trim();
      }
      continue;
    }

    // Numbered steps: "### 1. Title" or "1. Text" or "**Step N:**"
    const numberedMatch = line.match(/^(?:#{1,4}\s+)?(\d+)[.)]\s+(.+)/);
    const boldStepMatch = line.match(/^\*\*(?:Step\s+)?\d+[:.]\*\*\s*(.*)/i);
    // Bullet steps with action verbs
    const bulletMatch = line.match(/^[-*]\s+\*?\*?(.+)/);

    if (numberedMatch) {
      const text = numberedMatch[2].replace(/\*\*/g, '').trim();
      steps.push({
        index: stepIdx++,
        text,
        required: isRequired(text),
      });
    } else if (boldStepMatch) {
      const text = boldStepMatch[1].replace(/\*\*/g, '').trim();
      if (text) {
        steps.push({
          index: stepIdx++,
          text,
          required: isRequired(text),
        });
      }
    } else if (bulletMatch && hasActionVerb(bulletMatch[1])) {
      const text = bulletMatch[1].replace(/\*\*/g, '').replace(/\*([^*]+)\*/g, '$1').trim();
      if (text.length > 10) { // Skip very short bullets (likely sub-details)
        steps.push({
          index: stepIdx++,
          text,
          required: isRequired(text),
        });
      }
    }
  }

  return { name, steps };
}

// --- Auditing ---

export function auditTranscript(
  actions: TranscriptAction[],
  skillName: string,
  steps: SkillStep[],
): AuditResult {
  const deviations: AuditDeviation[] = [];
  const followed: Set<number> = new Set();

  // For each skill step, check if there's evidence in the transcript
  for (const step of steps) {
    const evidence = findEvidence(step, actions);

    if (evidence.found) {
      followed.add(step.index);
    } else if (evidence.partial) {
      followed.add(step.index); // Count partial as followed but flag it
      deviations.push({
        step,
        type: 'partial',
        detail: evidence.detail || 'Step was partially followed',
      });
    } else {
      deviations.push({
        step,
        type: 'skipped',
        detail: `No evidence of: "${step.text}"`,
      });
    }
  }

  // Check for improvised actions (tool calls not matching any step)
  const toolActions = actions.filter(a => a.type === 'tool_use');
  const stepCommands = steps.filter(s => s.command).map(s => s.command!.toLowerCase());
  const stepTexts = steps.map(s => s.text.toLowerCase());

  for (const action of toolActions) {
    const actionLower = action.summary.toLowerCase();
    const matchesAnyStep = stepCommands.some(cmd => {
      const cmdParts = extractKeyTerms(cmd);
      return cmdParts.some(part => actionLower.includes(part));
    }) || stepTexts.some(text => {
      const terms = extractKeyTerms(text);
      return terms.some(t => actionLower.includes(t));
    });

    if (!matchesAnyStep && !isBoilerplate(action)) {
      deviations.push({
        step: { index: -1, text: 'N/A', required: false },
        type: 'improvised',
        detail: `Action not in skill: ${action.summary}`,
      });
    }
  }

  const stepsFollowed = followed.size;
  const stepsSkipped = steps.length - stepsFollowed;
  const complianceScore = steps.length > 0
    ? Math.round((stepsFollowed / steps.length) * 100)
    : 100;

  // Generate suggestions
  const suggestions = generateSuggestions(deviations, steps, actions);

  return {
    skillName,
    totalSteps: steps.length,
    stepsFollowed,
    stepsSkipped,
    complianceScore,
    deviations,
    actionSummary: actions.slice(0, 50), // Cap for readability
    suggestions,
  };
}

// --- Helpers ---

function findEvidence(
  step: SkillStep,
  actions: TranscriptAction[],
): { found: boolean; partial: boolean; detail?: string } {
  const stepLower = step.text.toLowerCase();
  const terms = extractKeyTerms(stepLower);

  // If step has a command, look for that command in tool_use actions
  if (step.command) {
    const cmdTerms = extractKeyTerms(step.command.toLowerCase());
    // Filter out generic terms that appear in every bus command
    const genericTerms = new Set(['cortextos', 'bus', 'ctx', 'agent', 'name']);
    const distinctTerms = cmdTerms.filter(t => !genericTerms.has(t));
    const termsToMatch = distinctTerms.length > 0 ? distinctTerms : cmdTerms;
    for (const action of actions) {
      if (action.type !== 'tool_use') continue;
      const actionLower = action.summary.toLowerCase();
      const matchCount = termsToMatch.filter(t => actionLower.includes(t)).length;
      if (matchCount >= Math.ceil(termsToMatch.length * 0.6)) {
        return { found: true, partial: false };
      }
    }
  }

  // Look for key terms from the step text in actions
  for (const action of actions) {
    const actionLower = action.summary.toLowerCase();
    const matchCount = terms.filter(t => actionLower.includes(t)).length;
    if (terms.length > 0 && matchCount >= Math.ceil(terms.length * 0.5)) {
      return { found: true, partial: false };
    }
  }

  // Check thinking blocks for evidence of consideration
  for (const action of actions) {
    if (action.type !== 'thinking') continue;
    const thinkLower = action.summary.toLowerCase();
    const matchCount = terms.filter(t => thinkLower.includes(t)).length;
    if (terms.length > 0 && matchCount >= Math.ceil(terms.length * 0.5)) {
      return { found: false, partial: true, detail: 'Considered in thinking but no action taken' };
    }
  }

  return { found: false, partial: false };
}

function extractKeyTerms(text: string): string[] {
  // Remove common words, keep meaningful terms
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'need', 'must', 'ought',
    'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
    'into', 'through', 'during', 'before', 'after', 'above', 'below',
    'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
    'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
    'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
    'not', 'only', 'own', 'same', 'than', 'too', 'very', 'and', 'but',
    'or', 'if', 'it', 'its', 'this', 'that', 'these', 'those', 'your',
    'you', 'we', 'they', 'their', 'what', 'which', 'who', 'whom',
  ]);

  return text
    .replace(/[^a-z0-9\s_-]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));
}

function hasActionVerb(text: string): boolean {
  const actionVerbs = /^(read|write|check|create|update|send|log|run|execute|query|fetch|build|start|stop|mark|set|add|remove|delete|verify|confirm|test|deploy|review|approve|deny|process|parse|scan|audit|report|notify|escalate|complete|open|close|move|copy)/i;
  return actionVerbs.test(text.trim());
}

function isRequired(text: string): boolean {
  return /\b(must|always|required|mandatory|never skip|no exceptions|critical)\b/i.test(text);
}

function isBoilerplate(action: TranscriptAction): boolean {
  if (action.tool === 'Read' && action.summary.includes('SKILL.md')) return true;
  if (action.tool === 'Read' && action.summary.includes('AGENTS.md')) return true;
  if (action.tool === 'Read' && action.summary.includes('CLAUDE.md')) return true;
  if (action.tool === 'Read' && action.summary.includes('MEMORY.md')) return true;
  if (action.tool === 'Read' && action.summary.includes('SOUL.md')) return true;
  if (action.tool === 'Read' && action.summary.includes('GUARDRAILS.md')) return true;
  if (action.tool === 'Read' && action.summary.includes('HEARTBEAT.md')) return true;
  return false;
}

function generateSuggestions(
  deviations: AuditDeviation[],
  steps: SkillStep[],
  _actions: TranscriptAction[],
): string[] {
  const suggestions: string[] = [];

  const skipped = deviations.filter(d => d.type === 'skipped');
  const requiredSkipped = skipped.filter(d => d.step.required);
  const improvised = deviations.filter(d => d.type === 'improvised');

  if (requiredSkipped.length > 0) {
    suggestions.push(
      `CRITICAL: ${requiredSkipped.length} required step(s) were skipped. ` +
      `Consider adding guardrails or pre-hooks to enforce: ` +
      requiredSkipped.map(d => `"${truncate(d.step.text, 60)}"`).join(', '),
    );
  }

  if (skipped.length > steps.length * 0.3) {
    suggestions.push(
      `High skip rate (${skipped.length}/${steps.length}). ` +
      `The skill may be too verbose — consider consolidating into fewer, clearer steps.`,
    );
  }

  if (improvised.length > steps.length) {
    suggestions.push(
      `More improvised actions (${improvised.length}) than skill steps (${steps.length}). ` +
      `The skill definition may be incomplete — consider adding the improvised patterns as official steps.`,
    );
  }

  if (deviations.filter(d => d.type === 'partial').length > 0) {
    suggestions.push(
      `Some steps were considered but not acted on. ` +
      `Check if the skill's instructions are specific enough — ` +
      `vague steps ("check X") often get skipped.`,
    );
  }

  if (suggestions.length === 0) {
    suggestions.push('No significant deviations detected. Skill compliance is strong.');
  }

  return suggestions;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + '...' : text;
}

// --- Format Output ---

export function formatAuditReport(result: AuditResult): string {
  const lines: string[] = [];

  lines.push(`# Transcript Audit Report: ${result.skillName}`);
  lines.push('');
  lines.push(`**Compliance Score:** ${result.complianceScore}%`);
  lines.push(`**Steps Followed:** ${result.stepsFollowed}/${result.totalSteps}`);
  lines.push(`**Deviations:** ${result.deviations.length}`);
  lines.push('');

  if (result.deviations.length > 0) {
    lines.push('## Deviations');
    lines.push('');
    for (const d of result.deviations) {
      const icon = d.type === 'skipped' ? 'SKIP' :
                   d.type === 'partial' ? 'PARTIAL' :
                   d.type === 'improvised' ? 'IMPROV' : 'OOO';
      const stepRef = d.step.index >= 0 ? `Step ${d.step.index + 1}` : 'N/A';
      lines.push(`- [${icon}] ${stepRef}: ${d.detail}`);
    }
    lines.push('');
  }

  if (result.suggestions.length > 0) {
    lines.push('## Suggestions');
    lines.push('');
    for (const s of result.suggestions) {
      lines.push(`- ${s}`);
    }
    lines.push('');
  }

  lines.push('## Action Summary (first 50)');
  lines.push('');
  for (const a of result.actionSummary) {
    const tag = a.type === 'tool_use' ? `[${a.tool}]` :
                a.type === 'thinking' ? '[think]' : '[text]';
    lines.push(`${String(a.index).padStart(3)}. ${tag} ${a.summary}`);
  }

  return lines.join('\n');
}
