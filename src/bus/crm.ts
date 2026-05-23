/**
 * CRM Feed Pipeline
 *
 * Phase 1: Data Model + Ingest — reads iMessage, creates contacts + interactions.
 * Phase 2: Vault Resolution + Sync — matches contacts to Obsidian 05-People/,
 *          syncs last-contact back to vault frontmatter.
 *
 * Spec: orgs/life-os/agents/chief/specs/crm-feed-spec.md
 */

import { existsSync, readFileSync, appendFileSync, readdirSync, writeFileSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { checkIMessage, type IMessage } from './imessage.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Contact {
  id: string;
  name: string | null;
  phone: string[];
  email: string[];
  vault_path: string | null;
  relationship: string | null;
  tags: string[];
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly' | null;
  last_interaction: string | null;
  last_inbound: string | null;
  last_outbound: string | null;
  inbound_count_30d: number;
  outbound_count_30d: number;
  created_at: string;
  updated_at: string;
}

export interface Interaction {
  id: string;
  contact_id: string;
  timestamp: string;
  direction: 'inbound' | 'outbound';
  channel: 'imessage' | 'email' | 'call' | 'manual';
  preview: string;
  is_group: boolean;
  source_id: string | null;
}

export interface IdentityMap {
  [identifier: string]: string;
}

export interface IngestCursor {
  last_ingest: string;       // ISO datetime of last ingest run
  last_message_date: string; // ISO datetime of newest ingested message
  seen_ids: number[];        // recent iMessage ROWIDs for dedup (last 500)
}

// ---------------------------------------------------------------------------
// Contact ID
// ---------------------------------------------------------------------------

/** Deterministic contact ID from a phone number or email. */
export function contactId(identifier: string): string {
  const normalized = identifier.trim().toLowerCase();
  return createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

function contactsDir(crmDir: string): string {
  return join(crmDir, 'contacts');
}

function contactPath(crmDir: string, id: string): string {
  return join(contactsDir(crmDir), `${id}.json`);
}

function interactionsPath(crmDir: string): string {
  return join(crmDir, 'interactions.jsonl');
}

function identityMapPath(crmDir: string): string {
  return join(crmDir, 'identity-map.json');
}

function cursorPath(crmDir: string): string {
  return join(crmDir, 'crm-ingest-cursor.json');
}

export function readContact(crmDir: string, id: string): Contact | null {
  const path = contactPath(crmDir, id);
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Contact;
  } catch {
    return null;
  }
}

export function writeContact(crmDir: string, contact: Contact): void {
  ensureDir(contactsDir(crmDir));
  atomicWriteSync(contactPath(crmDir, contact.id), JSON.stringify(contact, null, 2));
}

export function readIdentityMap(crmDir: string): IdentityMap {
  try {
    return JSON.parse(readFileSync(identityMapPath(crmDir), 'utf-8')) as IdentityMap;
  } catch {
    return {};
  }
}

export function writeIdentityMap(crmDir: string, map: IdentityMap): void {
  ensureDir(crmDir);
  atomicWriteSync(identityMapPath(crmDir), JSON.stringify(map, null, 2));
}

export function readCursor(crmDir: string): IngestCursor | null {
  try {
    return JSON.parse(readFileSync(cursorPath(crmDir), 'utf-8')) as IngestCursor;
  } catch {
    return null;
  }
}

export function writeCursor(crmDir: string, cursor: IngestCursor): void {
  ensureDir(crmDir);
  atomicWriteSync(cursorPath(crmDir), JSON.stringify(cursor, null, 2));
}

function appendInteraction(crmDir: string, interaction: Interaction): void {
  ensureDir(crmDir);
  appendFileSync(interactionsPath(crmDir), JSON.stringify(interaction) + '\n', 'utf-8');
}

// ---------------------------------------------------------------------------
// Contact resolution
// ---------------------------------------------------------------------------

/** Check if an identifier looks like an email. */
function isEmail(id: string): boolean {
  return id.includes('@') && id.includes('.');
}

/** Resolve or create a contact for a given iMessage identifier. */
function resolveOrCreateContact(
  crmDir: string,
  identifier: string,
  identityMap: IdentityMap,
  now: string,
): { contact: Contact; isNew: boolean } {
  const id = identityMap[identifier];
  if (id) {
    const existing = readContact(crmDir, id);
    if (existing) return { contact: existing, isNew: false };
  }

  // Create new contact
  const newId = contactId(identifier);

  // Check if contact already exists (created by a different identifier)
  const existing = readContact(crmDir, newId);
  if (existing) {
    // Add this identifier to the existing contact
    if (isEmail(identifier)) {
      if (!existing.email.includes(identifier.toLowerCase())) {
        existing.email.push(identifier.toLowerCase());
      }
    } else {
      if (!existing.phone.includes(identifier)) {
        existing.phone.push(identifier);
      }
    }
    identityMap[identifier] = newId;
    return { contact: existing, isNew: false };
  }

  const contact: Contact = {
    id: newId,
    name: null,
    phone: isEmail(identifier) ? [] : [identifier],
    email: isEmail(identifier) ? [identifier.toLowerCase()] : [],
    vault_path: null,
    relationship: null,
    tags: [],
    cadence: null,
    last_interaction: null,
    last_inbound: null,
    last_outbound: null,
    inbound_count_30d: 0,
    outbound_count_30d: 0,
    created_at: now,
    updated_at: now,
  };

  identityMap[identifier] = newId;
  return { contact, isNew: true };
}

// ---------------------------------------------------------------------------
// Rolling 30-day count
// ---------------------------------------------------------------------------

/** Count interactions for a contact in the last 30 days from the JSONL log. */
function count30d(
  crmDir: string,
  contactIdVal: string,
  direction: 'inbound' | 'outbound',
  now: Date,
): number {
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400000);
  const logPath = interactionsPath(crmDir);
  if (!existsSync(logPath)) return 0;

  let count = 0;
  try {
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n');
    for (const line of lines) {
      if (!line) continue;
      try {
        const interaction = JSON.parse(line) as Interaction;
        if (
          interaction.contact_id === contactIdVal &&
          interaction.direction === direction &&
          new Date(interaction.timestamp) >= thirtyDaysAgo
        ) {
          count++;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // File read error — return 0
  }
  return count;
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export interface IngestOptions {
  crmDir: string;
  /** Override iMessage options (e.g. dbPath for testing). */
  imessageOpts?: {
    since?: string;
    limit?: number;
    dbPath?: string;
  };
}

export interface IngestResult {
  messages_read: number;
  contacts_created: number;
  contacts_updated: number;
  interactions_appended: number;
  skipped_dedup: number;
}

/**
 * Run the CRM ingest pipeline.
 * Reads iMessage since last cursor, creates/updates contacts, appends interactions.
 */
export function crmIngest(options: IngestOptions): IngestResult {
  const { crmDir } = options;
  ensureDir(crmDir);
  ensureDir(contactsDir(crmDir));

  const cursor = readCursor(crmDir);
  const identityMap = readIdentityMap(crmDir);
  const now = new Date();
  const nowISO = now.toISOString();

  // Determine --since from cursor or default to 24h
  const since = cursor?.last_message_date
    ? cursor.last_message_date
    : undefined;

  // Read iMessages
  const imessageResult = checkIMessage({
    since: since || '24h',
    limit: 500,
    format: 'json',
    ...options.imessageOpts,
  });

  const seenIds = new Set(cursor?.seen_ids ?? []);
  const result: IngestResult = {
    messages_read: imessageResult.messages.length,
    contacts_created: 0,
    contacts_updated: 0,
    interactions_appended: 0,
    skipped_dedup: 0,
  };

  // Track which contacts were modified this run
  const modifiedContacts = new Map<string, Contact>();
  let newestMessageDate = cursor?.last_message_date ?? '';

  for (const msg of imessageResult.messages) {
    // Dedup by iMessage ROWID
    if (seenIds.has(msg.id)) {
      result.skipped_dedup++;
      continue;
    }

    // Skip messages with no identifiable contact
    if (!msg.contact || msg.contact === 'unknown') continue;

    const { contact, isNew } = resolveOrCreateContact(
      crmDir,
      msg.contact,
      identityMap,
      nowISO,
    );

    if (isNew) result.contacts_created++;

    // Update contact timestamps
    const direction: 'inbound' | 'outbound' = msg.direction === 'received' ? 'inbound' : 'outbound';

    if (!contact.last_interaction || msg.date > contact.last_interaction) {
      contact.last_interaction = msg.date;
    }
    if (direction === 'inbound' && (!contact.last_inbound || msg.date > contact.last_inbound)) {
      contact.last_inbound = msg.date;
    }
    if (direction === 'outbound' && (!contact.last_outbound || msg.date > contact.last_outbound)) {
      contact.last_outbound = msg.date;
    }

    contact.updated_at = nowISO;

    // Append interaction
    const interaction: Interaction = {
      id: `imsg-${msg.id}`,
      contact_id: contact.id,
      timestamp: msg.date,
      direction,
      channel: 'imessage',
      preview: (msg.text || '').slice(0, 100),
      is_group: msg.is_group,
      source_id: String(msg.id),
    };
    appendInteraction(crmDir, interaction);
    result.interactions_appended++;

    seenIds.add(msg.id);
    modifiedContacts.set(contact.id, contact);

    if (msg.date > newestMessageDate) {
      newestMessageDate = msg.date;
    }
  }

  // Recalculate 30-day rolling counts and write modified contacts
  for (const contact of modifiedContacts.values()) {
    contact.inbound_count_30d = count30d(crmDir, contact.id, 'inbound', now);
    contact.outbound_count_30d = count30d(crmDir, contact.id, 'outbound', now);
    writeContact(crmDir, contact);
    if (!result.contacts_created || !modifiedContacts.has(contact.id)) {
      // Count updates (contacts that already existed)
    }
  }

  // Count updates vs creates properly
  result.contacts_updated = modifiedContacts.size - result.contacts_created;

  // Write identity map
  writeIdentityMap(crmDir, identityMap);

  // Update cursor — keep last 500 seen IDs to bound memory
  const seenArray = Array.from(seenIds);
  const trimmedSeen = seenArray.slice(Math.max(0, seenArray.length - 500));
  writeCursor(crmDir, {
    last_ingest: nowISO,
    last_message_date: newestMessageDate || nowISO,
    seen_ids: trimmedSeen,
  });

  return result;
}

// ---------------------------------------------------------------------------
// Query helpers
// ---------------------------------------------------------------------------

/** List all contacts. */
export function listContacts(crmDir: string): Contact[] {
  const dir = contactsDir(crmDir);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter((f: string) => f.endsWith('.json'));
  const contacts: Contact[] = [];
  for (const file of files) {
    try {
      contacts.push(JSON.parse(readFileSync(join(dir, file), 'utf-8')));
    } catch {
      // Skip corrupt files
    }
  }
  return contacts.sort((a, b) => {
    const aDate = a.last_interaction || a.created_at;
    const bDate = b.last_interaction || b.created_at;
    return bDate.localeCompare(aDate); // newest first
  });
}

/** Find contacts that are overdue based on cadence. */
export function staleContacts(crmDir: string, maxDays?: number): Contact[] {
  const contacts = listContacts(crmDir);
  const now = Date.now();

  const cadenceMs: Record<string, number> = {
    weekly: 7 * 86400000,
    monthly: 30 * 86400000,
    quarterly: 90 * 86400000,
    yearly: 365 * 86400000,
  };

  return contacts.filter(c => {
    if (!c.last_interaction) return true; // never contacted = stale

    const lastMs = new Date(c.last_interaction).getTime();
    const daysSince = (now - lastMs) / 86400000;

    if (maxDays !== undefined) {
      return daysSince >= maxDays;
    }

    if (c.cadence && cadenceMs[c.cadence]) {
      return (now - lastMs) >= cadenceMs[c.cadence];
    }

    // No cadence set — default to 30 days
    return daysSince >= 30;
  });
}

/** Search contacts by name, phone, email, or tag. */
export function searchContacts(crmDir: string, query: string): Contact[] {
  const contacts = listContacts(crmDir);
  const q = query.toLowerCase();
  return contacts.filter(c =>
    (c.name && c.name.toLowerCase().includes(q)) ||
    c.phone.some(p => p.includes(q)) ||
    c.email.some(e => e.toLowerCase().includes(q)) ||
    c.tags.some(t => t.toLowerCase().includes(q)),
  );
}

// ---------------------------------------------------------------------------
// Phase 2: Vault Resolution
// ---------------------------------------------------------------------------

export interface VaultPerson {
  filename: string;          // e.g. "Madeleine-Monroe.md"
  name: string;              // from H1 heading or filename
  relationship: string | null;
  email: string | null;
  phone: string | null;      // extracted from notes via regex
  lastContact: string | null;
  tags: string[];
}

/**
 * Parse YAML-style frontmatter from a vault markdown file.
 * Returns key-value pairs from the --- delimited block.
 */
export function parseFrontmatter(content: string): Record<string, string> {
  const fm: Record<string, string> = {};
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return fm;

  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      fm[key] = value;
    }
  }
  return fm;
}

/**
 * Extract phone numbers from free text using common patterns.
 * Matches: +1XXXXXXXXXX, (XXX) XXX-XXXX, XXX-XXX-XXXX
 */
export function extractPhones(text: string): string[] {
  const patterns = [
    /\+\d{10,15}/g,                          // +15551234567
    /\(\d{3}\)\s*\d{3}[-.]?\d{4}/g,          // (555) 123-4567
    /\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g,        // 555-123-4567
  ];
  const phones = new Set<string>();
  for (const pattern of patterns) {
    const matches = text.match(pattern);
    if (matches) {
      for (const m of matches) {
        phones.add(m.replace(/[\s().-]/g, ''));
      }
    }
  }
  return Array.from(phones);
}

/**
 * Read all person files from the vault's 05-People/ directory.
 */
export function readVaultPeople(vaultPeoplePath: string): VaultPerson[] {
  if (!existsSync(vaultPeoplePath)) return [];

  const files = readdirSync(vaultPeoplePath).filter(
    f => f.endsWith('.md') && f !== 'People-Dashboard.md' && !f.startsWith('_'),
  );

  const people: VaultPerson[] = [];
  for (const file of files) {
    try {
      const content = readFileSync(join(vaultPeoplePath, file), 'utf-8');
      const fm = parseFrontmatter(content);
      if (fm.type !== 'person') continue;

      // Extract name from H1 heading or filename
      const h1Match = content.match(/^# (.+)$/m);
      const name = h1Match ? h1Match[1].trim() : file.replace('.md', '').replace(/-/g, ' ');

      // Extract tags from the content
      const tagMatches = content.match(/#(\w+)/g);
      const tags = tagMatches
        ? tagMatches.map(t => t.slice(1)).filter(t => t !== 'person')
        : [];

      // Try to extract phone from notes
      const phones = extractPhones(content);

      people.push({
        filename: file,
        name,
        relationship: fm.relationship || null,
        email: fm.email || null,
        phone: phones[0] || null,
        lastContact: fm['last-contact'] || null,
        tags,
      });
    } catch {
      // Skip unreadable files
    }
  }
  return people;
}

export interface ResolveOptions {
  crmDir: string;
  vaultPeoplePath: string;
}

export interface ResolveResult {
  resolved: number;
  already_resolved: number;
  unresolved: number;
}

/**
 * Match unresolved CRM contacts to Obsidian vault people.
 * Read-only on vault — only writes to CRM contact files and identity map.
 */
export function crmResolve(options: ResolveOptions): ResolveResult {
  const { crmDir, vaultPeoplePath } = options;
  const contacts = listContacts(crmDir);
  const vaultPeople = readVaultPeople(vaultPeoplePath);
  const identityMap = readIdentityMap(crmDir);

  const result: ResolveResult = { resolved: 0, already_resolved: 0, unresolved: 0 };

  for (const contact of contacts) {
    if (contact.name !== null) {
      result.already_resolved++;
      continue;
    }

    let matched: VaultPerson | null = null;

    // Match strategy 1: email exact match
    if (!matched && contact.email.length > 0) {
      for (const email of contact.email) {
        matched = vaultPeople.find(
          vp => vp.email && vp.email.toLowerCase() === email.toLowerCase(),
        ) || null;
        if (matched) break;
      }
    }

    // Match strategy 2: phone match (vault phone extracted from notes)
    if (!matched && contact.phone.length > 0) {
      for (const phone of contact.phone) {
        // Normalize both sides: strip non-digits for comparison
        const phoneDigits = phone.replace(/\D/g, '');
        matched = vaultPeople.find(vp => {
          if (!vp.phone) return false;
          const vpDigits = vp.phone.replace(/\D/g, '');
          // Match on last 10 digits (handles +1 prefix differences)
          return phoneDigits.slice(-10) === vpDigits.slice(-10) && phoneDigits.length >= 10;
        }) || null;
        if (matched) break;
      }
    }

    // Match strategy 3: fuzzy name match (vault person name appears in iMessage contact)
    if (!matched) {
      for (const identifier of [...contact.phone, ...contact.email]) {
        matched = vaultPeople.find(vp => {
          const nameLower = vp.name.toLowerCase();
          const idLower = identifier.toLowerCase();
          // iMessage sometimes shows "John Smith" as the contact identifier
          return idLower.includes(nameLower) || nameLower.includes(idLower);
        }) || null;
        if (matched) break;
      }
    }

    if (matched) {
      // Apply vault data to CRM contact
      contact.name = matched.name;
      contact.vault_path = `05-People/${matched.filename}`;
      contact.relationship = matched.relationship;
      contact.tags = [...new Set([...contact.tags, ...matched.tags])];
      contact.updated_at = new Date().toISOString();

      // Add vault email/phone to identity map if not already there
      if (matched.email && !identityMap[matched.email.toLowerCase()]) {
        identityMap[matched.email.toLowerCase()] = contact.id;
        if (!contact.email.includes(matched.email.toLowerCase())) {
          contact.email.push(matched.email.toLowerCase());
        }
      }
      if (matched.phone && !identityMap[matched.phone]) {
        identityMap[matched.phone] = contact.id;
        if (!contact.phone.includes(matched.phone)) {
          contact.phone.push(matched.phone);
        }
      }

      writeContact(crmDir, contact);
      result.resolved++;
    } else {
      result.unresolved++;
    }
  }

  writeIdentityMap(crmDir, identityMap);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 2: Vault Sync
// ---------------------------------------------------------------------------

export interface SyncVaultOptions {
  crmDir: string;
  vaultPeoplePath: string;
}

export interface SyncVaultResult {
  updated: number;
  skipped_no_vault: number;
  skipped_no_change: number;
}

/**
 * Update Obsidian vault frontmatter `last-contact` from CRM data.
 * Only touches the `last-contact` field — all other content preserved exactly.
 * Auto-approved per Josh (2026-05-22).
 */
export function crmSyncVault(options: SyncVaultOptions): SyncVaultResult {
  const { crmDir, vaultPeoplePath } = options;
  const contacts = listContacts(crmDir);

  const result: SyncVaultResult = { updated: 0, skipped_no_vault: 0, skipped_no_change: 0 };

  for (const contact of contacts) {
    if (!contact.vault_path || !contact.last_interaction) {
      result.skipped_no_vault++;
      continue;
    }

    // Resolve vault_path to filesystem path
    // vault_path is like "05-People/Madeleine-Monroe.md"
    const vaultFile = join(
      vaultPeoplePath,
      basename(contact.vault_path),
    );

    if (!existsSync(vaultFile)) {
      result.skipped_no_vault++;
      continue;
    }

    const lastContactDate = contact.last_interaction.split('T')[0]; // YYYY-MM-DD

    try {
      const content = readFileSync(vaultFile, 'utf-8');
      const newContent = updateFrontmatterField(content, 'last-contact', lastContactDate);

      if (newContent === content) {
        result.skipped_no_change++;
        continue;
      }

      writeFileSync(vaultFile, newContent, 'utf-8');
      result.updated++;
    } catch {
      result.skipped_no_vault++;
    }
  }

  return result;
}

/**
 * Update a single field in YAML frontmatter, preserving all other content.
 * If the field exists, updates its value. If it doesn't exist, adds it
 * at the end of the frontmatter block.
 */
export function updateFrontmatterField(
  content: string,
  field: string,
  value: string,
): string {
  const fmMatch = content.match(/^(---\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) return content;

  const before = fmMatch[1];
  const fmBody = fmMatch[2];
  const after = fmMatch[3];
  const rest = content.slice(fmMatch[0].length);

  const lines = fmBody.split('\n');
  let found = false;

  for (let i = 0; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    if (key === field) {
      const currentValue = lines[i].slice(colonIdx + 1).trim();
      if (currentValue === value) return content; // No change
      lines[i] = `${field}: ${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.push(`${field}: ${value}`);
  }

  return before + lines.join('\n') + after + rest;
}

export function formatResolveResult(result: ResolveResult): string {
  return [
    `CRM resolve complete:`,
    `  Resolved: ${result.resolved}`,
    `  Already resolved: ${result.already_resolved}`,
    `  Unresolved: ${result.unresolved}`,
  ].join('\n');
}

export function formatSyncVaultResult(result: SyncVaultResult): string {
  return [
    `CRM vault sync complete:`,
    `  Updated: ${result.updated}`,
    `  Skipped (no vault link): ${result.skipped_no_vault}`,
    `  Skipped (no change): ${result.skipped_no_change}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export function formatContactList(contacts: Contact[]): string {
  if (contacts.length === 0) return 'No contacts found.';

  const lines: string[] = [`=== CRM: ${contacts.length} contacts ===`, ''];
  for (const c of contacts) {
    const name = c.name || '(unresolved)';
    const id = c.phone[0] || c.email[0] || c.id.slice(0, 8);
    const lastContact = c.last_interaction
      ? new Date(c.last_interaction).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
      : 'never';
    const msgs = c.inbound_count_30d + c.outbound_count_30d;
    const rel = c.relationship ? ` (${c.relationship})` : '';
    lines.push(`${name}${rel} — ${id} — last: ${lastContact} — 30d msgs: ${msgs}`);
  }
  return lines.join('\n');
}

export function formatContactDetail(contact: Contact): string {
  const lines: string[] = [
    `=== ${contact.name || '(unresolved)'} ===`,
    '',
    `ID: ${contact.id}`,
  ];
  if (contact.phone.length) lines.push(`Phone: ${contact.phone.join(', ')}`);
  if (contact.email.length) lines.push(`Email: ${contact.email.join(', ')}`);
  if (contact.relationship) lines.push(`Relationship: ${contact.relationship}`);
  if (contact.cadence) lines.push(`Cadence: ${contact.cadence}`);
  if (contact.tags.length) lines.push(`Tags: ${contact.tags.join(', ')}`);
  if (contact.vault_path) lines.push(`Vault: ${contact.vault_path}`);
  lines.push('');
  lines.push(`Last interaction: ${contact.last_interaction || 'never'}`);
  lines.push(`Last inbound: ${contact.last_inbound || 'never'}`);
  lines.push(`Last outbound: ${contact.last_outbound || 'never'}`);
  lines.push(`30-day inbound: ${contact.inbound_count_30d}`);
  lines.push(`30-day outbound: ${contact.outbound_count_30d}`);
  lines.push('');
  lines.push(`Created: ${contact.created_at}`);
  lines.push(`Updated: ${contact.updated_at}`);
  return lines.join('\n');
}

export function formatIngestResult(result: IngestResult): string {
  return [
    `CRM ingest complete:`,
    `  Messages read: ${result.messages_read}`,
    `  Contacts created: ${result.contacts_created}`,
    `  Contacts updated: ${result.contacts_updated}`,
    `  Interactions appended: ${result.interactions_appended}`,
    `  Skipped (dedup): ${result.skipped_dedup}`,
  ].join('\n');
}
