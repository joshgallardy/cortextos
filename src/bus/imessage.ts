import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export interface IMessage {
  id: number;
  date: string;
  contact: string;
  direction: 'sent' | 'received';
  text: string;
  is_group: boolean;
  chat_id: string | null;
}

export interface CheckIMessageOptions {
  since?: string;
  contact?: string;
  limit?: number;
  format?: 'text' | 'json';
}

/**
 * Apple Core Data timestamp → ISO date string.
 * Apple epoch is 2001-01-01T00:00:00Z. Timestamps in chat.db are nanoseconds.
 */
function appleTimestampToDate(ns: number): Date {
  const APPLE_EPOCH_OFFSET = 978307200; // seconds between Unix epoch and Apple epoch
  const unixSeconds = ns / 1_000_000_000 + APPLE_EPOCH_OFFSET;
  return new Date(unixSeconds * 1000);
}

/**
 * Parse --since value into a Date.
 * Supports: "2h", "4h", "1d", "7d", ISO date "2026-05-16", ISO datetime.
 */
export function parseSince(value: string): Date {
  // Relative: Nh, Nd, Nm
  const relMatch = value.match(/^(\d+)([hdm])$/i);
  if (relMatch) {
    const amount = parseInt(relMatch[1], 10);
    const unit = relMatch[2].toLowerCase();
    const now = Date.now();
    const msMap: Record<string, number> = { h: 3600000, d: 86400000, m: 60000 };
    return new Date(now - amount * msMap[unit]);
  }

  // Absolute date/datetime
  const parsed = new Date(value);
  if (!isNaN(parsed.getTime())) return parsed;

  throw new Error(`Cannot parse --since value: "${value}". Use "2h", "1d", or ISO date.`);
}

/**
 * Read iMessages from ~/Library/Messages/chat.db.
 */
export function checkIMessage(options: CheckIMessageOptions = {}): { count: number; since: string; messages: IMessage[] } {
  const dbPath = join(homedir(), 'Library', 'Messages', 'chat.db');

  if (!existsSync(dbPath)) {
    throw new Error(`iMessage database not found at ${dbPath}. Ensure Full Disk Access is enabled.`);
  }

  const limit = options.limit ?? 20;
  const since = options.since ? parseSince(options.since) : new Date(Date.now() - 86400000); // default 24h

  // Convert since to Apple Core Data nanosecond timestamp
  const APPLE_EPOCH_OFFSET = 978307200;
  const sinceAppleNs = (since.getTime() / 1000 - APPLE_EPOCH_OFFSET) * 1_000_000_000;

  let whereClause = `WHERE m.date > ${sinceAppleNs}`;
  if (options.contact) {
    // Escape single quotes for SQL safety
    const escaped = options.contact.replace(/'/g, "''");
    whereClause += ` AND h.id LIKE '%${escaped}%'`;
  }

  const query = `
    SELECT
      m.ROWID as id,
      m.date as date_ns,
      COALESCE(h.id, '') as contact,
      m.is_from_me,
      m.text,
      CASE WHEN c.chat_identifier LIKE 'chat%' THEN 1 ELSE 0 END as is_group,
      c.chat_identifier as chat_id
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    ${whereClause}
    ORDER BY m.date DESC
    LIMIT ${limit};
  `;

  let output: string;
  try {
    output = execFileSync('sqlite3', ['-json', dbPath, query], {
      encoding: 'utf-8',
      timeout: 10000,
    });
  } catch (err: any) {
    if (err.message?.includes('authorization denied') || err.message?.includes('not authorized')) {
      throw new Error(`Permission denied reading ${dbPath}. Grant Full Disk Access to the terminal.`);
    }
    throw new Error(`Failed to query iMessage database: ${err.message}`);
  }

  if (!output.trim()) {
    return { count: 0, since: since.toISOString(), messages: [] };
  }

  let rows: any[];
  try {
    rows = JSON.parse(output);
  } catch {
    return { count: 0, since: since.toISOString(), messages: [] };
  }

  const messages: IMessage[] = rows.map(row => ({
    id: row.id,
    date: appleTimestampToDate(row.date_ns).toISOString(),
    contact: row.contact || 'unknown',
    direction: row.is_from_me === 1 ? 'sent' : 'received',
    text: row.text || '[attachment]',
    is_group: row.is_group === 1,
    chat_id: row.is_group === 1 ? row.chat_id : null,
  }));

  return { count: messages.length, since: since.toISOString(), messages };
}

/**
 * Format messages as human-readable text output.
 */
export function formatText(result: { count: number; since: string; messages: IMessage[] }): string {
  const sinceDate = new Date(result.since);
  const sinceStr = sinceDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const lines: string[] = [`=== iMessage: since ${sinceStr} (${result.count} messages) ===`, ''];

  for (const msg of result.messages) {
    const d = new Date(msg.date);
    const ts = d.toLocaleString('en-US', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).replace(',', '');
    const dir = msg.direction === 'sent' ? 'TO  ' : 'FROM';
    const contact = msg.is_group ? `[${msg.chat_id}] ${msg.contact}` : msg.contact;
    lines.push(`[${ts}] ${dir} ${contact}: ${msg.text}`);
  }

  return lines.join('\n');
}
