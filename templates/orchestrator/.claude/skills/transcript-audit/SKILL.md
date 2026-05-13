---
name: transcript-audit
description: "Audit a session transcript against a skill definition. Use when you need to verify whether an agent (including yourself) followed a defined procedure. Identifies compliance gaps, skipped steps, improvised actions, and generates optimization suggestions. Can be run ad-hoc or as part of a weekly self-improvement cycle."
triggers: ["audit transcript", "review session", "check compliance", "skill compliance", "did I follow", "session review", "self-audit", "skill audit", "weekly review", "transcript analysis"]
---

# Session Transcript Audit

> Point this skill at a session transcript + the skill definition it was supposed to follow. It identifies where the agent followed/didn't follow steps, optimizes the skill, and helps close the self-improvement loop.

## Quick Start

```bash
# Audit a specific transcript against a skill
cortextos bus audit-transcript <transcript.jsonl> <SKILL.md> [--json] [--summary]
```

## When to Use

- **Weekly self-improvement**: Audit your own past sessions against skills you struggled with
- **Post-incident**: After a failure, audit the session to find procedural gaps
- **Skill optimization**: When a skill seems too verbose or too vague, audit transcripts to see what's actually followed vs skipped
- **Quality check**: Verify a worker agent followed its assigned procedure

## Workflow

### 1. Identify what to audit

Choose a transcript + skill pair:

```bash
# Find recent transcripts for an agent
ls ~/.claude/projects/-Users-opieclaw-cortextos-orgs-life-os-agents-${CTX_AGENT_NAME}/*.jsonl

# List available skills
cortextos bus list-skills --format text
```

### 2. Run the audit

```bash
# Full report
cortextos bus audit-transcript \
  ~/.claude/projects/-Users-opieclaw-cortextos-orgs-life-os-agents-dev/<session-id>.jsonl \
  .claude/skills/heartbeat/SKILL.md

# Quick summary
cortextos bus audit-transcript <transcript> <skill> --summary

# Machine-readable
cortextos bus audit-transcript <transcript> <skill> --json
```

### 3. Interpret results

The audit produces:

| Field | Meaning |
|-------|---------|
| **Compliance Score** | % of skill steps that have evidence in the transcript |
| **Steps Followed** | Count of steps with matching actions |
| **Deviations** | List of gaps: SKIP (not done), PARTIAL (considered but not acted), IMPROV (done but not in skill) |
| **Suggestions** | Actionable recommendations for skill optimization |

### 4. Act on findings

Based on the audit:

- **Skipped required steps** → Add guardrails or pre-hooks to enforce them
- **High skip rate (>30%)** → Skill may be too verbose; consolidate steps
- **Many improvised actions** → Skill definition is incomplete; add missing steps
- **Partial steps** → Instructions too vague; make them more specific with exact commands

### 5. Update the skill (if optimizing)

Edit the SKILL.md to address findings:
- Remove steps that are consistently skipped and unneeded
- Add steps for consistently improvised patterns
- Make vague steps more specific
- Mark truly critical steps with "REQUIRED" or "NO EXCEPTIONS"

## Automated Weekly Audit (Cron Integration)

Add to agent's cron for weekly self-improvement:

```bash
cortextos bus add-cron $CTX_AGENT_NAME weekly-audit "0 3 * * 0" \
  "Run transcript-audit: pick your most recent session, audit against heartbeat skill and tasks skill. Report findings to memory. If compliance < 80%, add a guardrail for the most-skipped step."
```

## Output Format (--json)

```json
{
  "skillName": "heartbeat",
  "totalSteps": 12,
  "stepsFollowed": 10,
  "stepsSkipped": 2,
  "complianceScore": 83,
  "deviations": [
    {
      "step": { "index": 5, "text": "Check GOALS.md", "required": true },
      "type": "skipped",
      "detail": "No evidence of: \"Check GOALS.md\""
    }
  ],
  "suggestions": [
    "CRITICAL: 1 required step(s) were skipped..."
  ]
}
```

## Limitations

- Heuristic matching: uses keyword overlap, not semantic understanding. Complex steps may show false negatives.
- Thinking blocks are treated as partial evidence only (considered != done).
- Large transcripts (>5000 actions) are capped at first 50 in the summary view.
- Does not track temporal ordering (Step 3 before Step 2 won't flag out-of-order).
