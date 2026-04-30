# External Persistent Crons System — Complete Phase Plan

**Project Vision**: Move cron scheduling from session-local fragile state to persistent, daemon-managed, human-understandable, reliable-through-failures system.

**Timeline**: 10-14 days total (Phases 1-5)

---

## PHASE 1: Core External Cron System (Days 1-4)

### Overview
Build the persistent storage layer, daemon scheduling engine, and foundational bus commands. At the end of Phase 1, the daemon can read, schedule, and fire external crons into agent PTY sessions with full execution logging.

---

### Subtask 1.1: Crons.json Schema Design & Atomic Operations

**Dependencies**: None (foundation task)

**Relevant Files**:
- `src/utils/atomic.ts` - existing atomic write patterns
- `src/bus/cron-state.ts` - fire record schema (reference for structure)
- `src/types/index.ts` - add CronDefinition interface
- `.cortextOS/state/agents/{agent}/crons.json` - new file

**Vision/Research Facts**:
- cortextOS uses atomic writes everywhere (see atomic.ts pattern)
- Current cron-state.json stores fire records, NOT definitions
- Per-agent isolation matches existing state structure
- Schema must be human-readable (operators may edit)
- Need to support both intervals (6h) and cron expressions (0 */6 * * *)

**Contracts with Other Subtasks**:
- 1.2 will use schema to read/write atomically
- 1.3 will parse this schema for scheduling
- 1.4 will CRUD this via bus commands
- 2.1 will migrate config.json crons to this schema

**Success Metrics**:
- [ ] Schema defined and documented
- [ ] TypeScript interface created
- [ ] Examples for common patterns (heartbeat, daily, weekly, etc.)
- [ ] Atomic read/write functions tested

**Validation/Testing**:
- Write test for atomic write + concurrent read (no corruption)
- Write 100 crons to file, verify all readable
- Verify schema survives process crash + restart
- Test malformed JSON recovery (must not corrupt state)

**Test Files to Create**:
- `tests/unit/bus/crons-schema.test.ts`

---

### Subtask 1.2: Crons File I/O Module (crons.ts)

**Dependencies**: 1.1 (schema defined)

**Relevant Files**:
- `src/bus/cron-state.ts` - reference for module patterns
- `src/utils/atomic.ts` - atomic write implementation
- `src/bus/crons.ts` - NEW FILE to create
- `src/types/index.ts` - import CronDefinition

**Vision/Research Facts**:
- Minimal dependencies: just fs + path (no external libs)
- Atomic writes via ensureDir + writeFileSync (cortextOS pattern)
- Read before write (verify state before mutation)
- Recovery: if read fails, return empty array (graceful degradation)
- Location: `.cortextOS/state/agents/{agent_name}/crons.json`

**Contracts**:
- 1.3 calls readCrons() and writeCrons()
- 1.4 uses these for all CRUD operations
- 2.1 migration uses readCrons + writeCrons

**Success Metrics**:
- [ ] readCrons(agentName) returns array of CronDefinition
- [ ] writeCrons(agentName, crons) atomically persists
- [ ] addCron/removeCron/updateCron helper functions
- [ ] getCronByName(agentName, name) for lookups
- [ ] All ops are atomic (no partial writes on crash)

**Validation/Testing**:
- Test read/write roundtrip (write 5 crons, read back, verify identical)
- Test concurrent writes from 2 threads (last-write-wins)
- Test recovery after unclean shutdown (crons.json.bak or similar)
- Test missing directory (ensureDir creates it)
- Test corrupted JSON recovery (logs error, returns empty)

**Test Files**:
- `tests/unit/bus/crons-io.test.ts`

---

### Subtask 1.3: Daemon Cron Scheduling Engine

**Dependencies**: 1.1, 1.2 (schema + I/O)

**Relevant Files**:
- `src/daemon/agent-process.ts` - existing 10-min gap detection loop (will extend)
- `src/daemon/index.ts` - daemon main loop
- `src/bus/cron-state.ts` - cronExpressionMinIntervalMs() function (reuse)
- `src/pty/inject.ts` - message injection mechanism (reuse)
- `src/bus/crons.ts` - new I/O module from 1.2
- `src/daemon/cron-scheduler.ts` - NEW FILE to create

**Vision/Research Facts**:
- Daemon already runs 24/7 (no new infrastructure)
- Current gap detection polls every 10 minutes (can reuse cadence)
- Prompt injection via inject.ts already works (used for gap-nudges)
- Cron fire prefix: `[CRON: {name}]` for clarity to operators
- Minimal dependencies: just cron evaluation logic
- Must be reproducible: same cron schedule always fires at same absolute times (daemon clock only)

**Contracts**:
- Reads from crons.ts (1.2)
- Writes to cron-state.ts for fire records (existing system)
- Injects prompts via pty/inject.ts (existing system)
- Logs execution to per-agent cron-execution.log
- 1.4 hooks into this for test-cron-fire command

**Success Metrics**:
- [ ] CronScheduler class evaluates all crons every 10 min
- [ ] calculateNextFireTime(cron) returns ISO timestamp
- [ ] Supports both intervals (6h) and cron expressions (0 */6 * * *)
- [ ] Fires with [CRON: name] prefix injected into PTY
- [ ] Records fire in cron-state.json + cron-execution.log
- [ ] Handles timezone correctly (uses daemon clock)
- [ ] Retries on injection failure (3x with backoff: 1s, 5s, 30s)

**Validation/Testing**:
- Test calculateNextFireTime() for 10+ cron patterns
  - Every 6h: verify 6h between fires
  - Every 24h at specific time: verify correct time
  - Cron expression: verify cronExpressionMinIntervalMs() reused correctly
- Simulate 48h running: fire at least 8 heartbeat crons (every 6h)
- Test PTY injection failure + retry logic
- Test daemon crash/restart: crons still fire on schedule
- Verify execution logged to cron-execution.log

**Test Files**:
- `tests/unit/daemon/cron-scheduler.test.ts`
- `tests/integration/cron-scheduler.test.ts` (48h simulation)

---

### Subtask 1.4: Bus Commands for External Crons

**Dependencies**: 1.2, 1.3 (I/O + scheduler)

**Relevant Files**:
- `src/cli/bus.ts` - add 5 new commands here
- `src/bus/crons.ts` - import functions from 1.2
- `src/daemon/cron-scheduler.ts` - import scheduler from 1.3
- `src/types/index.ts` - ensure CronDefinition exported

**Vision/Research Facts**:
- cortextOS bus is the control plane (all ops go through here)
- Current commands: send-message, update-cron-fire, send-telegram, etc.
- Operators use CLI: `cortextos bus add-cron boris heartbeat 6h "Read HEARTBEAT.md..."`
- Skills use these same commands (e.g., /loop skill)
- Simple, CLI-friendly syntax essential for operator understanding

**Contracts**:
- `/loop` skill (Phase 2) calls `cortextos bus add-cron` instead of CronCreate
- `cron-management` skill (Phase 2) calls these for CRUD
- Dashboard (Phase 4) calls these via IPC
- Migration script (Phase 2) calls `add-cron` for each migrated cron

**Success Metrics**:
- [ ] `cortextos bus add-cron {agent} {name} {interval|cron-expr} {prompt}`
- [ ] `cortextos bus remove-cron {agent} {name}`
- [ ] `cortextos bus list-crons {agent}` (shows schedule + last fire)
- [ ] `cortextos bus update-cron {agent} {name} --interval {new-interval}` (or --cron-expr)
- [ ] `cortextos bus test-cron-fire {agent} {name}` (fire immediately for testing)
- [ ] All commands validate input (agent exists, cron exists, interval format, etc.)
- [ ] Error messages are clear (e.g., "Cron 'heartbeat' already exists")

**Validation/Testing**:
- Add 5 crons via CLI, verify in crons.json
- Remove cron via CLI, verify gone
- Update cron interval, verify scheduler uses new interval
- Test-fire cron, verify prompt injected immediately
- Error cases: invalid agent, duplicate name, bad interval, nonexistent cron
- List output human-readable + includes schedule info

**Test Files**:
- `tests/unit/cli/bus-crons.test.ts`

---

### Subtask 1.5: Cron Execution Logging

**Dependencies**: 1.3, 1.4 (scheduler + commands)

**Relevant Files**:
- `src/daemon/cron-scheduler.ts` - logs here when fire happens
- `.cortextOS/state/agents/{agent}/cron-execution.log` - new file
- `src/bus/crons.ts` - add getExecutionLog() function

**Vision/Research Facts**:
- Full audit trail essential for debugging + compliance
- Log format: structured but human-readable
- Each fire records: timestamp, cron name, success/failure, retry count, any errors
- Log rotation: keep last 1000 entries per agent (prevent unbounded growth)
- Operators need visibility: "Why didn't heartbeat fire at 12:00?"

**Contracts**:
- Scheduler writes to log on every fire attempt
- Bus command `get-cron-log {agent} {name}` reads log for specific cron
- Dashboard (Phase 4) displays execution history from this log
- Backtest (1.6) validates log accuracy + completeness

**Success Metrics**:
- [ ] Log entry on every fire (success or failure)
- [ ] Format: ISO timestamp, cron name, status (fired/retried/failed), duration, any errors
- [ ] Log rotation at 1000 entries per agent (oldest pruned)
- [ ] `cortextos bus get-cron-log {agent} {name}` returns last 50 entries
- [ ] Log survives agent restart + daemon crash

**Validation/Testing**:
- Fire 10 crons, verify all logged
- Force injection failure, verify retry logged
- Verify log entries match actual fires (no false positives)
- Test log rotation (add 1100 entries, verify oldest 100 gone)
- Test log survives daemon restart

**Test Files**:
- `tests/unit/daemon/cron-execution-log.test.ts`

---

### Subtask 1.6: Phase 1 Full Backtesting

**Dependencies**: 1.1 through 1.5 (all Phase 1 components)

**Relevant Files**:
- All files from 1.1-1.5
- New test: `tests/integration/phase1-backtesting.test.ts`

**Vision/Research Facts**:
- Backtesting = comprehensive validation that all components work together
- Simulates 72 hours (3 days) of real cron operation
- Verifies reliability through simulated failures

**Test Scenarios**:
1. **Normal operation**: 5 agents, 10 crons total, verify all fire on schedule (72h sim)
2. **Daemon crash recovery**: Kill daemon during cron fire, restart, verify fires resume
3. **Corrupted crons.json**: Corrupt file mid-operation, verify recovery + no lost crons
4. **PTY injection failure**: Simulate PTY not accepting input, verify retries + eventual success
5. **Concurrent cron fires**: Multiple crons fire simultaneously, verify no race conditions
6. **Log integrity**: Verify execution log matches actual fires (no orphans or missing entries)

**Success Metrics**:
- [ ] All 10 crons fire at expected times (within 1 minute tolerance)
- [ ] Daemon crash doesn't lose crons
- [ ] Corrupted state recovers without losing cron definitions
- [ ] PTY failures don't cause cron loss (retries work)
- [ ] Concurrent fires don't corrupt state
- [ ] Execution log 100% accurate

**Validation Output**:
- Comprehensive report: 72h simulation results, all scenarios passed
- Metrics: cron fire accuracy, recovery time, log completeness
- Sign-off: Phase 1 ready for production use

---

## PHASE 2: Agent Integration (Days 4-7)

### Overview
Integrate external crons into agent bootstrap, migrate users from config.json, update skills to use external system, and verify all agents work correctly with new system.

---

### Subtask 2.1: Agent Bootstrap Update (AGENTS.md Step 6)

**Dependencies**: Phase 1 complete (1.6)

**Relevant Files**:
- `templates/agent/AGENTS.md` - rewrite step 6
- `templates/orchestrator/AGENTS.md` - same
- `templates/analyst/AGENTS.md` - same
- `src/daemon/agent-process.ts` - add cron auto-load on boot

**Vision/Research Facts**:
- Current step 6: "Restore crons from config.json — run CronList first..."
- New step 6: "External crons auto-load on boot (daemon-managed)"
- No manual cron restoration needed anymore
- Bootstrap simplified: remove CronCreate, remove CronList

**Contracts**:
- 2.2 migration script populates crons.json
- 2.3 `/loop` skill calls new bus commands
- Agent boot sees crons ready (already in crons.json)

**Success Metrics**:
- [ ] AGENTS.md step 6 rewritten (auto-load, no manual restore)
- [ ] Agent boot logs: "Loaded 4 external crons from crons.json"
- [ ] All bootstrap steps 1-13 still work (no regressions)
- [ ] Bootstrap tests pass for all 3 templates

**Validation/Testing**:
- Boot agent, verify crons load from crons.json
- Boot without crons.json, verify graceful (empty array)
- Boot with corrupted crons.json, verify recovery + logging

**Test Files**:
- Update existing bootstrap tests in `tests/`

---

### Subtask 2.2: Migration Script (config.json → crons.json)

**Dependencies**: Phase 1 (1.2 I/O operations), 2.1 (bootstrap updated)

**Relevant Files**:
- `src/daemon/agent-manager.ts` - add migration logic on daemon start
- `src/bus/crons.ts` - use I/O functions
- `src/cli/bus.ts` - optional `migrate-crons` command
- `orgs/*/agents/*/config.json` - source of crons to migrate

**Vision/Research Facts**:
- Auto-migration on daemon startup (zero friction for users)
- Read `config.json` crons array
- For each cron: convert to CronDefinition, write to crons.json
- Mark as migrated (don't re-migrate on next boot)
- Fallback: if crons.json missing, look in config.json (graceful)

**Contracts**:
- Runs on daemon startup (before agents boot)
- 2.1 (bootstrap) trusts migration happened
- 2.3 (skills) assume crons are in crons.json post-migration

**Success Metrics**:
- [ ] Daemon detects unmigrated agents (check for crons.json)
- [ ] Migrates all crons from config.json
- [ ] Sets migration flag to prevent re-migration
- [ ] No data loss: migrated crons identical in crons.json
- [ ] Works for 100+ existing agents across all orgs

**Validation/Testing**:
- Migrate 50 test agents with various cron patterns
- Verify crons.json matches config.json source
- Test idempotency: migrate again, no duplicates
- Test partial migration recovery (some agents already migrated)

**Test Files**:
- `tests/integration/crons-migration.test.ts`

---

### Subtask 2.3: /loop Skill Rewrite

**Dependencies**: Phase 1 (1.4 bus commands), 2.1, 2.2

**Relevant Files**:
- `.claude/skills/loop/SKILL.md` - update documentation
- `.claude/skills/loop/run.sh` - rewrite to use bus commands
- `src/cli/bus.ts` - `/loop` now calls `add-cron` internally

**Vision/Research Facts**:
- Current `/loop` uses CronCreate (session-local, lost on restart)
- New `/loop` calls `cortextos bus add-cron` (persistent external)
- Same user experience: `/loop 6h read heartbeat.md and...`
- Behind scenes: writes to crons.json instead of session state

**Contracts**:
- 2.1 bootstrap trusts `/loop` creates external crons
- Agents use `/loop` to create all scheduled work
- Skills depend on `/loop` behavior

**Success Metrics**:
- [ ] `/loop {interval} {prompt}` creates external cron (not session cron)
- [ ] Cron survives agent restart
- [ ] Same syntax as before (zero behavior change for users)
- [ ] Works with all interval formats (6h, 24h, 30m, etc.)
- [ ] Works with cron expressions if parsed correctly

**Validation/Testing**:
- Run `/loop 6h heartbeat` in agent
- Verify cron in crons.json (not just CronList)
- Restart agent, verify cron still there + fires
- Test error cases (bad interval format, etc.)

**Test Files**:
- Update `.claude/skills/loop/tests/` (if exists) or create

---

### Subtask 2.4: cron-management Skill Full CRUD

**Dependencies**: Phase 1 (1.4), 2.3 (`/loop` uses bus commands)

**Relevant Files**:
- `.claude/skills/cron-management/SKILL.md` - NEW OR REWRITE
- Bus commands from 1.4: add, remove, list, update, test-fire, get-log

**Vision/Research Facts**:
- Agents need full cron control: add, update, delete, list, test, monitor
- Skill provides this via bus commands
- Single skill for all cron operations (centralized knowledge)
- Used by agents when they need to manage their own crons

**Contracts**:
- Uses bus commands from 1.4 (all operations)
- Skills that create/manage crons depend on this

**Success Metrics**:
- [ ] Agents can create crons via `/cron-management add {name} {interval} {prompt}`
- [ ] Agents can update crons via `/cron-management update {name} --interval {new}`
- [ ] Agents can list crons via `/cron-management list`
- [ ] Agents can delete crons via `/cron-management remove {name}`
- [ ] Agents can test-fire crons via `/cron-management test {name}`
- [ ] Agents can view cron history via `/cron-management log {name}`
- [ ] All operations validate input + provide clear errors

**Validation/Testing**:
- Use skill to create 5 crons, verify all persistent
- Update cron interval, verify scheduler respects new value
- Delete cron, verify gone (not just disabled)
- Test-fire, verify prompt injected immediately
- View logs, verify historical accuracy

**Test Files**:
- `.claude/skills/cron-management/tests/`

---

### Subtask 2.5: Multi-Agent Testing

**Dependencies**: 2.1, 2.2, 2.3, 2.4 (all integration complete)

**Relevant Files**:
- `orgs/lifeos/agents/boris/config.json`
- `orgs/lifeos/agents/paul/config.json`
- `orgs/lifeos/agents/sentinel/config.json`
- `orgs/lifeos/agents/donna/config.json`
- `orgs/lifeos/agents/nick/config.json`

**Vision/Research Facts**:
- Real-world agents with real cron patterns
- Boris: 4 crons (heartbeat, pr-monitor, experiments)
- Paul: 6+ crons (heartbeat, orchestration tasks)
- Sentinel: various crons for system monitoring
- Test actual migration + operation

**Test Scenarios**:
1. Migrate all agents (config.json → crons.json)
2. Boot all agents, verify crons load
3. Run 72h simulation with all agents + their crons
4. Verify cross-agent coordination works (message passing between agents still works)
5. Verify dashboard visibility into all agent crons

**Success Metrics**:
- [ ] All 5 agents migrate cleanly
- [ ] All crons fire on schedule
- [ ] No cron loss or duplication
- [ ] Agent-to-agent communication still works
- [ ] Logs complete + accurate

**Validation Output**:
- Test report: all agents operational, all crons firing, no regressions

---

### Subtask 2.6: Phase 2 Full Backtesting

**Dependencies**: 2.1 through 2.5 (all integration complete)

**Relevant Files**:
- All agent configs from real orgs
- `tests/integration/phase2-backtesting.test.ts`

**Vision/Research Facts**:
- End-to-end test with real agents + crons
- Validates no regressions in existing agent behavior
- Tests migration + operation together

**Test Scenarios**:
1. Fresh deployment: Set up 5 real agents, migrate crons, boot all, run 72h
2. Mixed deployment: Some agents pre-migrated, some need migration, boot all
3. Agent addition: Boot new agent mid-simulation, verify crons work
4. Agent removal: Stop agent mid-simulation, verify other agents unaffected
5. Failure resilience: Kill daemon, kill agents, restart — all crons still work

**Success Metrics**:
- [ ] 72h simulation all 5 agents + 25+ crons firing correctly
- [ ] Migration 100% successful (no data loss)
- [ ] New agent addition works mid-operation
- [ ] Daemon/agent failures don't lose crons
- [ ] Execution logs 100% accurate across all agents

**Validation Output**:
- Comprehensive report: Phase 2 complete, all agents operational, no regressions
- Sign-off: Ready for Phase 3 (documentation)

---

## PHASE 3: Documentation & Migration Guide (Days 7-10)

### Overview
Update all documentation to reflect external persistent crons, create migration guide for users, update bootstrap/onboarding files.

---

### Subtask 3.1: AGENTS.md Comprehensive Rewrite

**Dependencies**: Phase 2 complete (2.6)

**Relevant Files**:
- `templates/agent/AGENTS.md` - main file
- `templates/orchestrator/AGENTS.md` - update
- `templates/analyst/AGENTS.md` - update
- All 15+ instances across different agent templates

**Vision/Research Facts**:
- AGENTS.md is "source of truth" for agent bootstrap
- Step 6 completely changed (cron restoration → auto-load)
- New section: "External Persistent Crons" explaining system
- Examples: how to create/manage crons via `/loop` and `cron-management`

**Contracts**:
- 3.2 (onboarding) builds on this documentation
- 3.3 (skill docs) references this for context

**Success Metrics**:
- [ ] Step 6 rewritten (auto-load crons)
- [ ] New section explaining external crons (1-2 pages)
- [ ] Examples for common patterns (heartbeat, daily tasks, etc.)
- [ ] Explains `/loop` for creating crons
- [ ] Explains migration (automatic, nothing to do)
- [ ] Clear explanation of how crons survive restarts

**Validation/Testing**:
- New users can follow AGENTS.md to create crons
- Existing users understand what changed + no action needed
- Examples are copy-paste ready

---

### Subtask 3.2: Onboarding & Bootstrap Updates

**Dependencies**: 3.1 (AGENTS.md finalized)

**Relevant Files**:
- `.claude/skills/onboarding/SKILL.md` - update for new users
- All bootstrap files in `templates/*/` directories
- First-time agent creation docs

**Vision/Research Facts**:
- Onboarding is first-time agent experience
- Must explain persistent crons (vs legacy session crons)
- Should show how to use `/loop` to create crons
- Should reassure crons survive restarts

**Contracts**:
- New agents follow onboarding, immediately understand cron persistence

**Success Metrics**:
- [ ] Onboarding explains external crons clearly
- [ ] First cron example included (copy-paste ready)
- [ ] No references to legacy CronCreate system
- [ ] Clear that migration is automatic

**Validation/Testing**:
- Walk through onboarding as new user
- Create cron via `/loop` during onboarding
- Verify cron persistent post-bootstrap

---

### Subtask 3.3: Skill Documentation Updates

**Dependencies**: Phase 1, 2 complete + 3.1

**Relevant Files**:
- `.claude/skills/loop/SKILL.md` - update with new behavior
- `.claude/skills/cron-management/SKILL.md` - document full CRUD
- Any other skills that create/manage crons

**Vision/Research Facts**:
- Skills are self-documenting (SKILL.md is the manual)
- Must explain external cron behavior (not session-local)
- Examples essential (operators copy-paste)

**Contracts**:
- Agents use these skills, documentation is their reference

**Success Metrics**:
- [ ] `/loop` skill docs updated (new behavior explained)
- [ ] `cron-management` skill fully documented (all 6 commands)
- [ ] Examples for each command (copy-paste ready)
- [ ] Error handling documented (what to do if it fails)

**Validation/Testing**:
- Follow skill docs to use each command
- All examples work correctly

---

### Subtask 3.4: Migration Guide for Existing Users

**Dependencies**: Phase 2 (migration complete), 3.1-3.3 (docs updated)

**Relevant Files**:
- New file: `CRONS_MIGRATION_GUIDE.md` (or append to README)
- Location: Root of cortextOS repo

**Vision/Research Facts**:
- Existing users have session-local + config.json crons
- Upgrade path: npm update → automatic migration → no action needed
- Must reassure: zero downtime, no data loss, transparent

**Contents**:
- What changed (session → persistent)
- Why it matters (reliability, works across restarts)
- What users need to do (nothing — automatic)
- Verification steps (see crons in crons.json)
- Troubleshooting (if migration fails, how to recover)

**Contracts**:
- Users read this on upgrade
- Support docs reference this

**Success Metrics**:
- [ ] Clear explanation of changes
- [ ] Reassurance on safety + zero downtime
- [ ] Verification steps (how to confirm migration worked)
- [ ] Troubleshooting for common issues
- [ ] Backward compatibility explained

**Validation/Testing**:
- Existing users follow guide on upgrade
- Verify migration succeeded
- Verify no data loss

---

### Subtask 3.5: Phase 3 Full Backtesting

**Dependencies**: 3.1-3.4 (all documentation complete)

**Relevant Files**:
- All documentation files
- Real users following guides

**Vision/Research Facts**:
- Backtesting = validate documentation clarity + usability
- Real users (not just devs) follow guides

**Test Scenarios**:
1. New user follows onboarding, creates cron via `/loop`, verifies persistence
2. Existing user upgrades cortextOS, sees automatic migration message, verifies crons work
3. Operator uses `/loop` to create new cron, references skill docs
4. Support person troubleshoots missing cron using guide

**Success Metrics**:
- [ ] Documentation is clear (no ambiguity)
- [ ] Examples are accurate + copy-paste ready
- [ ] Troubleshooting covers 80% of real issues
- [ ] Migration message is clear + non-scary

**Validation Output**:
- Documentation review + user testing report
- Sign-off: Phase 3 complete, documentation ready for users

---

## PHASE 4: Dashboard Integration (Days 10-13)

### Overview
Add full CRUD workflows page, execution history viewing, and cron health monitoring to dashboard.

---

### Subtask 4.1: Dashboard Workflows Page Design

**Dependencies**: Phase 1 (1.4 bus commands available), Phase 2 (agents stable)

**Relevant Files**:
- `dashboard/` - Next.js 14 app
- `dashboard/app/workflows/page.tsx` - NEW FILE
- `src/daemon/ipc-server.ts` - IPC endpoints for cron operations

**Vision/Research Facts**:
- Dashboard is operator-facing control plane
- Workflows page shows all agent crons in one place
- Must support CRUD (create, read, update, delete)
- Must show execution history
- Must show cron health (last fire, next fire, failures)

**Contracts**:
- Calls bus commands via IPC (from 1.4)
- Reads cron definitions + execution logs (from Phase 1)
- Operator interacts with real-time cron state

**Success Metrics**:
- [ ] List all agents + their crons
- [ ] Show schedule info (interval, cron expr, next fire time)
- [ ] Show last fire time + execution status
- [ ] Filter by agent
- [ ] Search by cron name
- [ ] Show 50 recent executions per cron

**UI Components**:
- [ ] Cron list (sortable, filterable)
- [ ] Cron detail (schedule, history, status)
- [ ] Create cron form
- [ ] Edit cron form
- [ ] Delete confirmation

**Validation/Testing**:
- Load page with 50 crons, verify responsive
- Filter by agent, verify correctness
- Search by name, verify matching

---

### Subtask 4.2: Create/Edit Cron Workflows

**Dependencies**: 4.1 (page structure)

**Relevant Files**:
- `dashboard/components/cron-form.tsx` - NEW
- `dashboard/app/workflows/[id]/page.tsx` - detail page

**Vision/Research Facts**:
- Form for creating new crons
- Form for editing existing crons
- Must validate interval format (6h, 24h, etc.)
- Must validate cron expressions (optional, for power users)
- Must show examples/help

**Contracts**:
- Calls `cortextos bus add-cron` (4.1 calls bus command)
- Calls `cortextos bus update-cron`

**Success Metrics**:
- [ ] Create form works (valid inputs create crons)
- [ ] Edit form works (updates existing crons)
- [ ] Validation on interval format (reject invalid)
- [ ] Validation on agent name (must exist)
- [ ] Validation on cron name (must be unique)
- [ ] Error messages clear + actionable

**Validation/Testing**:
- Create 5 crons via form, verify in crons.json
- Edit cron interval, verify scheduler respects change
- Error cases: invalid interval, duplicate name, missing agent

---

### Subtask 4.3: Cron History & Monitoring

**Dependencies**: Phase 1 (1.5 execution logging), 4.1

**Relevant Files**:
- `dashboard/components/cron-history.tsx` - NEW
- Execution log from Phase 1

**Vision/Research Facts**:
- Show last 100 executions for each cron
- Show success/failure status
- Show execution duration
- Show any error messages
- Help operators debug why crons didn't fire

**Contracts**:
- Reads execution log (from 1.5)
- Calls `cortextos bus get-cron-log {agent} {name}`

**Success Metrics**:
- [ ] History view shows 50 recent executions
- [ ] Shows timestamp, status, duration, any errors
- [ ] Pagination for older entries
- [ ] Filter by status (success/failure)
- [ ] Export execution log (CSV or JSON)

**Validation/Testing**:
- Fire 100 crons, verify history shows all
- Filter by status, verify correctness
- Export log, verify format

---

### Subtask 4.4: Cron Health Dashboard

**Dependencies**: Phase 1, 4.1-4.3

**Relevant Files**:
- `dashboard/app/workflows/health.tsx` - NEW (or append to main page)

**Vision/Research Facts**:
- Overview of all crons health across all agents
- Show: total crons, firing rate, failures, gaps
- Alert if cron hasn't fired in >2x interval
- Show which agents/crons are at risk

**Contracts**:
- Reads cron-state.json (fire records)
- Reads crons.json (definitions)
- Calculates gap = now - last_fire vs expected interval

**Success Metrics**:
- [ ] Show total crons count
- [ ] Show crons firing successfully (last 24h)
- [ ] Show crons with gaps >interval (warning state)
- [ ] Show crons never fired (error state)
- [ ] Color coding (green/yellow/red)
- [ ] Per-agent breakdown

**Validation/Testing**:
- View health page with 50 crons
- Verify gap detection (cron not firing shows as warning)
- Verify color coding matches state

---

### Subtask 4.5: Test Fire Functionality

**Dependencies**: Phase 1 (1.4 test-cron-fire), 4.1

**Relevant Files**:
- Dashboard button/action: "Test Fire"
- Calls `cortextos bus test-cron-fire {agent} {name}`

**Vision/Research Facts**:
- Operator wants to test if cron works
- Button: "Test Fire Now"
- Immediately injects prompt into agent PTY
- Shows result (success/failure)

**Contracts**:
- Calls bus command from 1.4

**Success Metrics**:
- [ ] Button appears on cron detail page
- [ ] Clicking fires cron immediately
- [ ] Shows result (prompt injected)
- [ ] Can disable for certain crons (safety)

**Validation/Testing**:
- Test-fire a cron, verify prompt injected in agent PTY
- Test-fire immediately again, verify works (no rate limiting issues)

---

### Subtask 4.6: Phase 4 Full Backtesting

**Dependencies**: 4.1-4.5 (dashboard complete)

**Relevant Files**:
- `tests/integration/dashboard-workflows.test.ts` - E2E tests
- Playwright or similar for UI automation

**Vision/Research Facts**:
- Backtesting = end-to-end UI testing
- Real operator workflows (create, edit, view, test-fire)

**Test Scenarios**:
1. Create cron via dashboard form, verify in crons.json + fires
2. Edit cron interval via dashboard, verify new schedule
3. View cron history, verify executions shown correctly
4. View health dashboard, verify gap detection
5. Test-fire cron via button, verify prompt injected
6. Delete cron via dashboard, verify removed from crons.json

**Success Metrics**:
- [ ] All CRUD operations work end-to-end
- [ ] Dashboard shows real-time cron state
- [ ] History/health views accurate
- [ ] No UI errors or missing data
- [ ] Performance acceptable (load time <2s for 100 crons)

**Validation Output**:
- E2E test report: all workflows pass
- Performance metrics: page load times
- Sign-off: Phase 4 complete, dashboard production-ready

---

## PHASE 5: Full System Backtesting (Days 13-14)

### Overview
Comprehensive validation of entire system: all 5 phases, all agents, all components working together reliably through failures.

---

### Subtask 5.1: End-to-End Integration Testing

**Dependencies**: All Phases 1-4 complete (4.6)

**Relevant Files**:
- `tests/integration/full-system-backtest.test.ts` - NEW

**Vision/Research Facts**:
- Simulate production environment with all components
- 7 real agents, 50+ crons, 168 hours (1 week) simulation
- Inject realistic failures + verify recovery

**Test Scenarios**:
1. **Normal operation (Day 1)**: All crons fire on schedule, logs accurate
2. **Daemon crash (Day 2)**: Kill daemon mid-operation, restart, verify crons still fire
3. **Agent crash (Day 3)**: Kill agent, restart, verify crons load + fire
4. **Corrupted state (Day 4)**: Corrupt crons.json mid-operation, verify recovery
5. **Network degradation (Day 5)**: Slow PTY injection, verify retries work
6. **Concurrent stress (Day 6)**: 10 crons fire simultaneously, verify no race conditions
7. **Dashboard monitoring (Day 7)**: Operator views workflows page throughout, verify accuracy

**Success Metrics**:
- [ ] All 50+ crons fire at expected times (1% tolerance)
- [ ] Daemon crash: crons still fire within 1 min
- [ ] Agent crash: recovery <2 min, no lost crons
- [ ] State corruption: automatic recovery, zero data loss
- [ ] Retries: failed injections recover on retry
- [ ] Concurrent fires: no state corruption, all logged correctly
- [ ] Dashboard: real-time accuracy (within 1 poll cycle)

**Validation Output**:
- 168h simulation results + metrics
- Pass/fail per scenario
- Recovery times + data integrity verification

---

### Subtask 5.2: User Journey Testing

**Dependencies**: All phases + documentation

**Relevant Files**:
- `tests/integration/user-journeys.test.ts`
- All documentation from Phase 3

**Vision/Research Facts**:
- Backtesting real user workflows (not just component tests)
- New user: onboarding → create first cron
- Existing user: upgrade → migration → verify crons work
- Operator: dashboard → create/edit/monitor crons

**Test Journeys**:
1. **New user setup**:
   - Create new agent (bootstrap)
   - Follow onboarding
   - Create 3 crons via `/loop`
   - Verify all fire on schedule
   - Monitor via dashboard

2. **Existing user upgrade**:
   - Start with pre-migration setup (config.json + session crons)
   - Upgrade cortextOS
   - Daemon detects + migrates
   - All crons still work
   - Zero downtime

3. **Operator workflow**:
   - View dashboard workflows page
   - Create new cron via form
   - Edit existing cron
   - View execution history
   - Test-fire cron
   - Delete old cron

**Success Metrics**:
- [ ] New user creates + verifies crons in <10 minutes
- [ ] Existing user upgrade <2 minutes total + zero downtime
- [ ] Operator dashboard interactions all succeed
- [ ] Documentation is clear enough for self-service

---

### Subtask 5.3: Failure Mode & Recovery Testing

**Dependencies**: All phases

**Relevant Files**:
- `tests/integration/failure-modes.test.ts`

**Vision/Research Facts**:
- "Reliability through deaths or crashes" (James's requirement)
- Test all failure scenarios
- Verify recovery is automatic + transparent to operator

**Failure Modes**:
1. **Daemon death**: Unexpected crash, OS process kill, OOM, etc.
2. **Agent death**: Unexpected crash, PTY close, etc.
3. **Disk full**: Cannot write crons.json
4. **File corruption**: crons.json corrupted by external process
5. **Clock skew**: Daemon clock jumps backward
6. **PTY blocked**: Agent PTY not accepting input
7. **Cascading failures**: Daemon dies → agent dies → recovery

**Recovery Expectations**:
- Daemon crash: crons still fire within 1 min (via PTY injection mechanism)
- Agent crash: crons load on restart, fire on schedule
- Disk full: queued until space available (no data loss)
- Corruption: automatic recovery to last known-good state
- Clock skew: graceful (fires may be delayed but not lost)
- PTY blocked: retries until PTY accepting
- Cascading: each component recovers independently

**Success Metrics**:
- [ ] Zero data loss in any failure scenario
- [ ] Recovery time <5 minutes for any single failure
- [ ] Cascading failures: full recovery <15 minutes
- [ ] Operator doesn't need to intervene (automatic recovery)
- [ ] Execution logs show what happened + recovery

---

### Subtask 5.4: Performance & Scaling Testing

**Dependencies**: All phases

**Relevant Files**:
- `tests/integration/performance.test.ts`

**Vision/Research Facts**:
- System should scale to 100+ agents, 1000+ crons
- Polling interval 10 min (reasonable for reliability)
- No external dependencies (daemon only, pure Node.js)

**Performance Tests**:
1. **Startup time**: Daemon reads 1000 cron definitions, ready in <5s
2. **Fire latency**: Cron scheduled, fires within 1 min (polling interval)
3. **Polling overhead**: Scanning 100 agents + 1000 crons in <10s
4. **File I/O**: Read/write crons.json with 100 crons in <100ms
5. **Concurrent fires**: 100 crons fire simultaneously, all succeed in <30s
6. **Disk usage**: 1000 crons.json + execution logs <100MB

**Success Metrics**:
- [ ] Startup <5s (1000 crons)
- [ ] Fire latency <1 min (at 10 min polling interval)
- [ ] Polling cycle <10s (100 agents, 1000 crons)
- [ ] File I/O <100ms per operation
- [ ] Concurrent fires succeed within 30s
- [ ] Disk usage <100MB (1000 crons, 30 days logs)

**Validation Output**:
- Performance metrics + graphs
- Scaling limits identified (where does it break?)
- Recommendations for optimization (if needed)

---

### Subtask 5.5: Compliance & Audit Testing

**Dependencies**: All phases, 5.1-5.4

**Relevant Files**:
- Execution logs, cron definitions, state files

**Vision/Research Facts**:
- Full audit trail for compliance/debugging
- Every fire recorded, every error logged
- Operators can trace "why didn't cron X fire?"

**Audit Tests**:
1. **Cron lifecycle audit**: Create → Fire → Update → Delete (all logged)
2. **Execution audit**: Every fire has timestamp + status + duration
3. **Failure audit**: Every failure has error message + retry count
4. **Recovery audit**: Every recovery logged with actions taken
5. **User actions audit**: Who created/edited/deleted crons + when

**Success Metrics**:
- [ ] 100% of cron fires logged
- [ ] 100% of failures + retries logged
- [ ] All state changes auditable (who, what, when)
- [ ] Logs immutable (append-only)
- [ ] Retention: 30 days default

**Validation Output**:
- Audit trail comprehensiveness report
- Sign-off: Compliance ready

---

### Subtask 5.6: Documentation Validation

**Dependencies**: Phase 3 documentation, user testing from 5.2

**Relevant Files**:
- All documentation files from Phase 3
- User testing feedback

**Vision/Research Facts**:
- Backtesting that documentation is accurate + complete
- Real users follow guides without dev help

**Tests**:
1. **Clarity**: Documentation is understandable to non-dev operators
2. **Completeness**: All features documented
3. **Examples**: Examples are accurate + copy-paste ready
4. **Troubleshooting**: Common issues covered
5. **Migration**: Users understand what changed + why

**Success Metrics**:
- [ ] New users can self-onboard (follow docs, no dev help needed)
- [ ] Existing users understand upgrade path (zero confusion)
- [ ] Troubleshooting covers 90% of real issues
- [ ] No contradictions in documentation
- [ ] Examples tested + known-working

---

### Subtask 5.7: Final Integration & Sign-Off

**Dependencies**: 5.1-5.6 (all backtesting complete)

**Relevant Files**:
- All source code from Phases 1-4
- All documentation from Phase 3
- All test results from 5.1-5.6

**Vision/Research Facts**:
- Final validation before production deployment
- Comprehensive report to stakeholders
- Go/no-go decision

**Validation Checklist**:
- [ ] Code review: All changes meet cortextOS standards
- [ ] Test coverage: >80% coverage on all new code
- [ ] Performance: Meets targets from 5.4
- [ ] Security: No new vulnerabilities (dependencies scanned)
- [ ] Documentation: Complete + accurate
- [ ] User testing: Real users successful with system
- [ ] Backwards compatibility: Existing agents still work
- [ ] Rollout plan: Clear migration path for existing users

**Sign-Off**:
- [ ] Engineering sign-off (code quality + testing)
- [ ] Product sign-off (meets requirements)
- [ ] User sign-off (documentation + UX)

**Validation Output**:
- Comprehensive final report (20+ pages)
  - Executive summary
  - Technical architecture
  - Test results + metrics
  - Documentation review
  - User feedback summary
  - Known limitations + future work
  - Rollout recommendations
- Go/no-go decision document
- Post-launch monitoring plan

---

## DELIVERABLES SUMMARY

| Phase | Component | Deliverable | Format |
|-------|-----------|-------------|--------|
| 1 | Core system | Code (src/bus/crons.ts, src/daemon/cron-scheduler.ts, etc.) | TypeScript |
| 1 | Bus commands | 5 new CLI commands | TypeScript CLI |
| 1 | Tests | 6 test suites (schema, I/O, scheduler, commands, logging, integration) | Jest |
| 2 | Agent integration | Bootstrap updates, migration script, skill updates | TypeScript + Markdown |
| 2 | Real-world testing | 5 real agents tested + validated | Integration tests |
| 3 | Documentation | AGENTS.md updates, onboarding, skill docs, migration guide | Markdown |
| 4 | Dashboard | Workflows page + CRUD + history + health | React/TypeScript |
| 5 | Validation | 7 comprehensive backtesting suites | Integration tests + Reports |

---

## RISK ASSESSMENT

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|-----------|
| Daemon polling interval too slow | Low | Medium | Optimize polling if needed post-launch |
| File I/O contention on busy systems | Low | Low | Use atomic writes + caching if needed |
| User confusion on upgrade | Medium | Medium | Clear migration guide + automated migration |
| Dashboard complexity | Medium | Low | Phased dashboard rollout (minimal MVP first) |
| Cron expression parsing bugs | Low | High | Comprehensive unit tests + property-based testing |
| Backwards compatibility break | Low | Critical | Thorough testing of existing agents |

---

## SUCCESS CRITERIA (PROJECT-LEVEL)

✅ External persistent cron system operational with 0 data loss in any failure scenario
✅ Existing agents migrate automatically with zero downtime
✅ New agents work out-of-the-box with external crons
✅ Dashboard provides full visibility + control
✅ Operators understand system through clear documentation
✅ System reliable enough for production 24/7 operation
