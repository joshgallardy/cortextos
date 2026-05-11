// cortextOS Dashboard - Task data fetcher
// Reads from SQLite (synced from JSON task files on disk).

import { db } from '@/lib/db';
import type { Task, TaskFilters } from '@/lib/types';

// ---------------------------------------------------------------------------
// Urgency scoring
// ---------------------------------------------------------------------------

const PRIORITY_WEIGHT: Record<string, number> = {
  critical: 40,
  urgent: 30,
  high: 20,
  normal: 10,
  low: 0,
};

/**
 * Compute a composite urgency score for a task (0-100).
 * Factors: priority weight, age (hours since created), staleness (hours
 * since last update), and deadline proximity (hours until due).
 * Completed tasks always score 0.
 */
export function computeUrgencyScore(task: Task): number {
  if (task.status === 'completed') return 0;

  const now = Date.now();
  let score = PRIORITY_WEIGHT[task.priority] ?? 10;

  // Age factor: +1 point per 6 hours of age, max 20
  const ageMs = now - new Date(task.created_at).getTime();
  const ageHours = ageMs / (1000 * 60 * 60);
  score += Math.min(20, Math.floor(ageHours / 6));

  // Staleness factor: +1 point per 4 hours since last update, max 20
  const lastTouch = task.updated_at || task.created_at;
  const staleMs = now - new Date(lastTouch).getTime();
  const staleHours = staleMs / (1000 * 60 * 60);
  score += Math.min(20, Math.floor(staleHours / 4));

  // Deadline proximity: up to +20 points as deadline approaches
  if (task.due_date) {
    const dueMs = new Date(task.due_date).getTime() - now;
    const dueHours = dueMs / (1000 * 60 * 60);
    if (dueHours <= 0) {
      // Overdue — max deadline urgency
      score += 20;
    } else if (dueHours <= 24) {
      score += 15;
    } else if (dueHours <= 72) {
      score += 10;
    } else if (dueHours <= 168) {
      score += 5;
    }
  }

  return Math.min(100, score);
}

/**
 * Get tasks with optional filters.
 * Returns newest first by default.
 */
export function getTasks(filters?: TaskFilters): Task[] {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (filters?.org) {
    conditions.push('org = ?');
    params.push(filters.org);
  }
  if (filters?.agent) {
    // 'human' is a virtual filter: returns tasks assigned to any non-agent human
    // (agents create human tasks with assigned_to 'user', 'human', etc.)
    if (filters.agent === 'human') {
      conditions.push("(assignee IN ('human', 'user') OR title LIKE '[HUMAN]%' OR project = 'human-tasks')");
    } else {
      conditions.push('assignee = ?');
      params.push(filters.agent);
    }
  }
  if (filters?.priority) {
    conditions.push('priority = ?');
    params.push(filters.priority);
  }
  if (filters?.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  if (filters?.project) {
    conditions.push('project = ?');
    params.push(filters.project);
  }
  if (filters?.search) {
    conditions.push('(title LIKE ? OR description LIKE ?)');
    const term = `%${filters.search}%`;
    params.push(term, term);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, due_date, waiting_on, notes, source_file
         FROM tasks ${where}
         ORDER BY created_at DESC`
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToTask);
  } catch (err) {
    console.error('[data/tasks] getTasks error:', err);
    return [];
  }
}

/**
 * Get a single task by ID.
 */
export function getTaskById(id: string): Task | null {
  try {
    const row = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, due_date, waiting_on, notes, source_file
         FROM tasks WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    return row ? rowToTask(row) : null;
  } catch (err) {
    console.error('[data/tasks] getTaskById error:', err);
    return null;
  }
}

/**
 * Get tasks filtered by status (useful for kanban columns).
 */
export function getTasksByStatus(status: string, org?: string): Task[] {
  return getTasks({ status, org });
}

/**
 * Get tasks assigned to a specific agent.
 */
export function getTasksByAgent(agentName: string, org?: string): Task[] {
  return getTasks({ agent: agentName, org });
}

/**
 * Get tasks completed today (UTC).
 */
export function getTasksCompletedToday(org?: string): Task[] {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayISO = todayStart.toISOString();

  const conditions: string[] = ['completed_at >= ?'];
  const params: (string | number)[] = [todayISO];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;

  try {
    const rows = db
      .prepare(
        `SELECT id, title, description, status, priority, assignee, org, project,
                needs_approval, created_at, updated_at, completed_at, due_date, waiting_on, notes, source_file
         FROM tasks ${where}
         ORDER BY completed_at DESC`
      )
      .all(...params) as Record<string, unknown>[];

    return rows.map(rowToTask);
  } catch (err) {
    console.error('[data/tasks] getTasksCompletedToday error:', err);
    return [];
  }
}

/**
 * Get count of in-progress tasks (for sidebar badge).
 */
export function getInProgressCount(org?: string): number {
  return getTaskCount(org, 'in_progress');
}

/**
 * Get count of tasks matching optional org/status.
 */
export function getTaskCount(org?: string, status?: string): number {
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (org) {
    conditions.push('org = ?');
    params.push(org);
  }
  if (status) {
    conditions.push('status = ?');
    params.push(status);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  try {
    const row = db
      .prepare(`SELECT COUNT(*) as count FROM tasks ${where}`)
      .get(...params) as { count: number } | undefined;

    return row?.count ?? 0;
  } catch (err) {
    console.error('[data/tasks] getTaskCount error:', err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToTask(row: Record<string, unknown>): Task {
  const task: Task = {
    id: row.id as string,
    title: row.title as string,
    description: (row.description as string) ?? undefined,
    status: row.status as Task['status'],
    priority: row.priority as Task['priority'],
    assignee: (row.assignee as string) ?? undefined,
    org: row.org as string,
    project: (row.project as string) ?? undefined,
    needs_approval: row.needs_approval === 1,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string) ?? undefined,
    completed_at: (row.completed_at as string) ?? undefined,
    due_date: (row.due_date as string) ?? undefined,
    waiting_on: (row.waiting_on as string) ?? undefined,
    notes: (row.notes as string) ?? undefined,
    source_file: (row.source_file as string) ?? undefined,
  };
  task.urgency_score = computeUrgencyScore(task);
  return task;
}
