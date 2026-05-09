/**
 * Plugin dispatch — bridge to bob-runtime's plugin execution layer.
 * POSTs to http://127.0.0.1:{port}/v1/plugins/{name}/dispatch
 */

export interface DispatchResult {
  task_id: string;
  status: string;
  summary?: string;
  error?: string;
  artifacts?: Array<{ kind: string; ref: string; summary: string }>;
}

export interface DispatchOptions {
  task: string;
  taskId?: string;
  complexity?: 'simple' | 'standard' | 'complex';
  metadata?: Record<string, unknown>;
  tenant?: string;
}

/**
 * Dispatch a task to a bob-runtime plugin via HTTP.
 * Returns the execution result (plugins run inline, not queued).
 */
export async function dispatchPlugin(
  pluginName: string,
  options: DispatchOptions,
  port: number = 3001,
  secret?: string,
): Promise<DispatchResult> {
  const url = `http://127.0.0.1:${port}/v1/plugins/${pluginName}/dispatch`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (secret) {
    headers['X-Dispatch-Secret'] = secret;
  }

  const body = JSON.stringify({
    task: options.task,
    task_id: options.taskId,
    complexity: options.complexity,
    metadata: options.metadata ?? {},
    tenant: options.tenant ?? 'personal',
  });

  const resp = await fetch(url, { method: 'POST', headers, body });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`dispatch failed (${resp.status}): ${text}`);
  }

  return (await resp.json()) as DispatchResult;
}

/**
 * List available plugins from bob-runtime.
 */
export async function listRuntimePlugins(
  port: number = 3001,
): Promise<Record<string, { name: string; version: string }>> {
  const resp = await fetch(`http://127.0.0.1:${port}/v1/plugins/`);
  if (!resp.ok) {
    throw new Error(`list plugins failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as Record<string, { name: string; version: string }>;
}

export interface TriageRecord {
  thread_id: string;
  message_id?: string;
  subject: string;
  sender: string;
  label: string;
  reasoning: string;
  action_taken: string;
}

/**
 * Write pre-classified triage records to bob-runtime's TriageStore.
 * Used when chief agent classifies via MCP Gmail + own reasoning.
 */
export async function recordTriage(
  records: TriageRecord[],
  port: number = 3001,
  secret?: string,
): Promise<{ saved: number; total: number }> {
  const url = `http://127.0.0.1:${port}/v1/plugins/inbox_os/record`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Dispatch-Secret'] = secret;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(records),
  });
  if (!resp.ok) {
    throw new Error(`record triage failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as { saved: number; total: number };
}

// ── Gmail action types ──────────────────────────────────────────

export interface GmailLabelResult {
  ok: boolean;
  thread_id: string;
}

export interface GmailBatchResult {
  modified?: number;
  archived?: number;
  trashed?: number;
  errors: Array<{ thread_id: string; error: string }>;
  total: number;
}

/**
 * Add/remove labels on a single Gmail thread via bob-runtime.
 */
export async function gmailLabelThread(
  threadId: string,
  addLabels: string[] = [],
  removeLabels: string[] = [],
  port: number = 3001,
  secret?: string,
): Promise<GmailLabelResult> {
  const url = `http://127.0.0.1:${port}/v1/plugins/inbox_os/label`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Dispatch-Secret'] = secret;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_id: threadId, add_labels: addLabels, remove_labels: removeLabels }),
  });
  if (!resp.ok) {
    throw new Error(`gmail-label-thread failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as GmailLabelResult;
}

/**
 * Archive Gmail threads (remove INBOX label) via bob-runtime.
 */
export async function gmailArchive(
  threadIds: string[],
  port: number = 3001,
  secret?: string,
): Promise<GmailBatchResult> {
  const url = `http://127.0.0.1:${port}/v1/plugins/inbox_os/archive`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Dispatch-Secret'] = secret;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_ids: threadIds }),
  });
  if (!resp.ok) {
    throw new Error(`gmail-archive failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as GmailBatchResult;
}

/**
 * Trash Gmail threads via bob-runtime.
 */
export async function gmailTrash(
  threadIds: string[],
  port: number = 3001,
  secret?: string,
): Promise<GmailBatchResult> {
  const url = `http://127.0.0.1:${port}/v1/plugins/inbox_os/trash`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Dispatch-Secret'] = secret;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_ids: threadIds }),
  });
  if (!resp.ok) {
    throw new Error(`gmail-trash failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as GmailBatchResult;
}

/**
 * Batch modify labels on multiple Gmail threads via bob-runtime.
 */
export async function gmailBatchModify(
  threadIds: string[],
  addLabels: string[] = [],
  removeLabels: string[] = [],
  port: number = 3001,
  secret?: string,
): Promise<GmailBatchResult> {
  const url = `http://127.0.0.1:${port}/v1/plugins/inbox_os/batch-modify`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (secret) headers['X-Dispatch-Secret'] = secret;
  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ thread_ids: threadIds, add_labels: addLabels, remove_labels: removeLabels }),
  });
  if (!resp.ok) {
    throw new Error(`gmail-batch-modify failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as GmailBatchResult;
}

export interface PollResult {
  messages_found: number;
  triaged: number;
  skipped: number;
  errors: number;
  details: Array<Record<string, unknown>>;
}

/**
 * Poll Gmail inbox via bob-runtime's inbox_os plugin.
 * Pulls new messages and triages each one inline.
 */
export async function pollInbox(
  port: number = 3001,
  maxResults: number = 20,
  secret?: string,
): Promise<PollResult> {
  const url = `http://127.0.0.1:${port}/v1/plugins/inbox_os/poll?max_results=${maxResults}`;
  const headers: Record<string, string> = {};
  if (secret) {
    headers['X-Dispatch-Secret'] = secret;
  }
  const resp = await fetch(url, { method: 'POST', headers });
  if (!resp.ok) {
    throw new Error(`poll failed (${resp.status}): ${await resp.text()}`);
  }
  return (await resp.json()) as PollResult;
}
