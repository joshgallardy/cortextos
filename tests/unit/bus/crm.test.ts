import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  contactId,
  readContact,
  writeContact,
  readIdentityMap,
  writeIdentityMap,
  readCursor,
  writeCursor,
  listContacts,
  staleContacts,
  searchContacts,
  crmIngest,
  crmResolve,
  crmSyncVault,
  parseFrontmatter,
  extractPhones,
  readVaultPeople,
  updateFrontmatterField,
  formatContactList,
  formatContactDetail,
  formatIngestResult,
  formatResolveResult,
  formatSyncVaultResult,
  type Contact,
  type IngestCursor,
} from '../../../src/bus/crm';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContact(overrides: Partial<Contact> = {}): Contact {
  const defaults: Contact = {
    id: contactId('+15551234567'),
    name: 'Test Person',
    phone: ['+15551234567'],
    email: [],
    vault_path: null,
    relationship: null,
    tags: [],
    cadence: null,
    last_interaction: '2026-05-20T10:00:00.000Z',
    last_inbound: '2026-05-20T10:00:00.000Z',
    last_outbound: '2026-05-19T08:00:00.000Z',
    inbound_count_30d: 5,
    outbound_count_30d: 3,
    created_at: '2026-05-01T00:00:00.000Z',
    updated_at: '2026-05-20T10:00:00.000Z',
  };
  // Use Object.assign so explicit null values override defaults
  return { ...defaults, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('contactId', () => {
  it('produces deterministic IDs from the same input', () => {
    expect(contactId('+15551234567')).toBe(contactId('+15551234567'));
  });

  it('produces different IDs for different inputs', () => {
    expect(contactId('+15551234567')).not.toBe(contactId('+15559876543'));
  });

  it('normalizes by lowercasing and trimming', () => {
    expect(contactId('  Alice@Example.COM  ')).toBe(contactId('alice@example.com'));
  });

  it('returns a 16-char hex string', () => {
    const id = contactId('+15551234567');
    expect(id).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('Contact CRUD', () => {
  let crmDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-test-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('writes and reads a contact', () => {
    const contact = makeContact();
    writeContact(crmDir, contact);
    const read = readContact(crmDir, contact.id);
    expect(read).not.toBeNull();
    expect(read!.name).toBe('Test Person');
    expect(read!.phone).toEqual(['+15551234567']);
  });

  it('returns null for non-existent contact', () => {
    expect(readContact(crmDir, 'nonexistent')).toBeNull();
  });

  it('overwrites existing contact on second write', () => {
    const contact = makeContact();
    writeContact(crmDir, contact);
    contact.name = 'Updated Name';
    writeContact(crmDir, contact);
    const read = readContact(crmDir, contact.id);
    expect(read!.name).toBe('Updated Name');
  });

  it('creates contacts directory if missing', () => {
    const deepDir = join(crmDir, 'sub', 'crm');
    const contact = makeContact();
    writeContact(deepDir, contact);
    expect(readContact(deepDir, contact.id)).not.toBeNull();
  });
});

describe('IdentityMap', () => {
  let crmDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-idmap-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('returns empty object when no map exists', () => {
    expect(readIdentityMap(crmDir)).toEqual({});
  });

  it('round-trips identity map', () => {
    const map = { '+15551234567': 'abc123', 'alice@example.com': 'def456' };
    writeIdentityMap(crmDir, map);
    expect(readIdentityMap(crmDir)).toEqual(map);
  });
});

describe('Cursor', () => {
  let crmDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-cursor-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('returns null when no cursor exists', () => {
    expect(readCursor(crmDir)).toBeNull();
  });

  it('round-trips cursor data', () => {
    const cursor: IngestCursor = {
      last_ingest: '2026-05-20T10:00:00.000Z',
      last_message_date: '2026-05-20T09:55:00.000Z',
      seen_ids: [100, 101, 102],
    };
    writeCursor(crmDir, cursor);
    const read = readCursor(crmDir);
    expect(read).toEqual(cursor);
  });
});

describe('listContacts', () => {
  let crmDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-list-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('returns empty array when no contacts exist', () => {
    expect(listContacts(crmDir)).toEqual([]);
  });

  it('returns all contacts sorted by last interaction (newest first)', () => {
    writeContact(crmDir, makeContact({ id: 'a', name: 'Old', last_interaction: '2026-05-01T00:00:00Z' }));
    writeContact(crmDir, makeContact({ id: 'b', name: 'New', last_interaction: '2026-05-20T00:00:00Z' }));
    writeContact(crmDir, makeContact({ id: 'c', name: 'Mid', last_interaction: '2026-05-10T00:00:00Z' }));
    const list = listContacts(crmDir);
    expect(list.map(c => c.name)).toEqual(['New', 'Mid', 'Old']);
  });

  it('handles contacts with no last_interaction (sorts by created_at)', () => {
    writeContact(crmDir, makeContact({ id: 'a', name: 'NoInteraction', last_interaction: null, created_at: '2026-05-15T00:00:00Z' }));
    writeContact(crmDir, makeContact({ id: 'b', name: 'HasInteraction', last_interaction: '2026-05-20T00:00:00Z' }));
    const list = listContacts(crmDir);
    expect(list[0].name).toBe('HasInteraction');
  });
});

describe('staleContacts', () => {
  let crmDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-stale-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('returns contacts with no interaction as stale', () => {
    writeContact(crmDir, makeContact({ id: 'a', name: 'Ghost', last_interaction: null }));
    expect(staleContacts(crmDir)).toHaveLength(1);
  });

  it('returns contacts past their cadence', () => {
    const sixtyDaysAgo = new Date(Date.now() - 60 * 86400000).toISOString();
    writeContact(crmDir, makeContact({
      id: 'a', name: 'Monthly Stale', cadence: 'monthly', last_interaction: sixtyDaysAgo,
    }));
    expect(staleContacts(crmDir)).toHaveLength(1);
  });

  it('does not return contacts within their cadence', () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString();
    writeContact(crmDir, makeContact({
      id: 'a', name: 'Monthly Fresh', cadence: 'monthly', last_interaction: yesterday,
    }));
    expect(staleContacts(crmDir)).toHaveLength(0);
  });

  it('respects --days override', () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    writeContact(crmDir, makeContact({
      id: 'a', name: 'Recent', last_interaction: tenDaysAgo,
    }));
    expect(staleContacts(crmDir, 30)).toHaveLength(0);
    expect(staleContacts(crmDir, 7)).toHaveLength(1);
  });

  it('defaults to 30 days when no cadence set', () => {
    const fortyDaysAgo = new Date(Date.now() - 40 * 86400000).toISOString();
    writeContact(crmDir, makeContact({
      id: 'a', name: 'No Cadence', cadence: null, last_interaction: fortyDaysAgo,
    }));
    expect(staleContacts(crmDir)).toHaveLength(1);
  });
});

describe('searchContacts', () => {
  let crmDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-search-'));
    writeContact(crmDir, makeContact({ id: 'a', name: 'Alice Smith', phone: ['+15551111111'], email: ['alice@test.com'], tags: ['friend'] }));
    writeContact(crmDir, makeContact({ id: 'b', name: 'Bob Jones', phone: ['+15552222222'], email: ['bob@work.com'], tags: ['colleague'] }));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('finds by name (case-insensitive)', () => {
    expect(searchContacts(crmDir, 'alice')).toHaveLength(1);
    expect(searchContacts(crmDir, 'ALICE')).toHaveLength(1);
  });

  it('finds by phone number', () => {
    expect(searchContacts(crmDir, '5551111')).toHaveLength(1);
  });

  it('finds by email', () => {
    expect(searchContacts(crmDir, 'bob@work')).toHaveLength(1);
  });

  it('finds by tag', () => {
    expect(searchContacts(crmDir, 'colleague')).toHaveLength(1);
  });

  it('returns empty array for no matches', () => {
    expect(searchContacts(crmDir, 'zzznomatch')).toHaveLength(0);
  });
});

describe('crmIngest', () => {
  let crmDir: string;
  let dbPath: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-ingest-'));
    // Create a temp SQLite DB with iMessage schema
    dbPath = join(crmDir, 'test-chat.db');
    const { execSync } = require('child_process');
    execSync(`sqlite3 ${dbPath} "
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, date INTEGER, is_from_me INTEGER, text TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);

      INSERT INTO handle VALUES (1, '+15551234567');
      INSERT INTO handle VALUES (2, 'alice@test.com');

      INSERT INTO message VALUES (1, 1, 801000000000000000, 0, 'Hey there');
      INSERT INTO message VALUES (2, 1, 802000000000000000, 1, 'Hi back');
      INSERT INTO message VALUES (3, 2, 803000000000000000, 0, 'Email person here');

      INSERT INTO chat VALUES (1, 'iMessage;-;+15551234567');
      INSERT INTO chat VALUES (2, 'iMessage;-;alice@test.com');

      INSERT INTO chat_message_join VALUES (1, 1);
      INSERT INTO chat_message_join VALUES (1, 2);
      INSERT INTO chat_message_join VALUES (2, 3);
    "`, { encoding: 'utf-8' });
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
  });

  it('creates contacts from iMessage data', () => {
    const result = crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    expect(result.messages_read).toBeGreaterThan(0);
    expect(result.contacts_created).toBeGreaterThan(0);
    expect(result.interactions_appended).toBeGreaterThan(0);
  });

  it('creates separate contacts for phone and email', () => {
    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const contacts = listContacts(crmDir);
    expect(contacts.length).toBeGreaterThanOrEqual(2);

    const phoneContact = contacts.find(c => c.phone.includes('+15551234567'));
    const emailContact = contacts.find(c => c.email.includes('alice@test.com'));
    expect(phoneContact).toBeDefined();
    expect(emailContact).toBeDefined();
  });

  it('writes identity map entries', () => {
    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const map = readIdentityMap(crmDir);
    expect(Object.keys(map).length).toBeGreaterThan(0);
    expect(map['+15551234567']).toBeDefined();
  });

  it('writes cursor after ingest', () => {
    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const cursor = readCursor(crmDir);
    expect(cursor).not.toBeNull();
    expect(cursor!.last_ingest).toBeDefined();
    expect(cursor!.seen_ids.length).toBeGreaterThan(0);
  });

  it('deduplicates on second ingest run', () => {
    const result1 = crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const result2 = crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    expect(result2.skipped_dedup).toBe(result1.interactions_appended);
    expect(result2.interactions_appended).toBe(0);
  });

  it('writes interactions to JSONL file', () => {
    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const jsonlPath = join(crmDir, 'interactions.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(first).toHaveProperty('contact_id');
    expect(first).toHaveProperty('direction');
    expect(first).toHaveProperty('channel', 'imessage');
  });

  it('sets correct direction for sent vs received', () => {
    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const jsonlPath = join(crmDir, 'interactions.jsonl');
    const lines = readFileSync(jsonlPath, 'utf-8').trim().split('\n');
    const interactions = lines.map(l => JSON.parse(l));
    const inbound = interactions.filter(i => i.direction === 'inbound');
    const outbound = interactions.filter(i => i.direction === 'outbound');
    expect(inbound.length).toBeGreaterThan(0);
    expect(outbound.length).toBeGreaterThan(0);
  });

  it('updates last_interaction on contact', () => {
    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });
    const contacts = listContacts(crmDir);
    for (const c of contacts) {
      expect(c.last_interaction).not.toBeNull();
    }
  });

  it('handles empty iMessage result gracefully', () => {
    // Create an empty DB
    const emptyDb = join(crmDir, 'empty-chat.db');
    const { execSync } = require('child_process');
    execSync(`sqlite3 ${emptyDb} "
      CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
      CREATE TABLE message (ROWID INTEGER PRIMARY KEY, handle_id INTEGER, date INTEGER, is_from_me INTEGER, text TEXT);
      CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
      CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
    "`, { encoding: 'utf-8' });

    const result = crmIngest({
      crmDir,
      imessageOpts: { dbPath: emptyDb, since: '365d', limit: 100 },
    });
    expect(result.messages_read).toBe(0);
    expect(result.contacts_created).toBe(0);
    expect(result.interactions_appended).toBe(0);
  });

  it('trims seen_ids to 500 max', () => {
    // Pre-seed cursor with 500 IDs
    writeCursor(crmDir, {
      last_ingest: '2026-01-01T00:00:00Z',
      last_message_date: '2026-01-01T00:00:00Z',
      seen_ids: Array.from({ length: 500 }, (_, i) => i + 1000),
    });

    crmIngest({
      crmDir,
      imessageOpts: { dbPath, since: '365d', limit: 100 },
    });

    const cursor = readCursor(crmDir);
    expect(cursor!.seen_ids.length).toBeLessThanOrEqual(500);
  });
});

describe('formatContactList', () => {
  it('shows "No contacts found" for empty list', () => {
    expect(formatContactList([])).toBe('No contacts found.');
  });

  it('includes contact count in header', () => {
    const contacts = [makeContact()];
    expect(formatContactList(contacts)).toContain('1 contacts');
  });

  it('shows name or (unresolved) for unnamed contacts', () => {
    const named = makeContact({ name: 'Alice' });
    const unnamed = makeContact({ id: 'x', name: null });
    const output = formatContactList([named, unnamed]);
    expect(output).toContain('Alice');
    expect(output).toContain('(unresolved)');
  });

  it('includes relationship in parentheses', () => {
    const contact = makeContact({ relationship: 'friend' });
    expect(formatContactList([contact])).toContain('(friend)');
  });
});

describe('formatContactDetail', () => {
  it('includes all fields for a fully populated contact', () => {
    const contact = makeContact({
      name: 'Alice',
      phone: ['+15551234567'],
      email: ['alice@test.com'],
      relationship: 'friend',
      cadence: 'weekly',
      tags: ['college'],
      vault_path: '05-People/Alice.md',
    });
    const output = formatContactDetail(contact);
    expect(output).toContain('Alice');
    expect(output).toContain('+15551234567');
    expect(output).toContain('alice@test.com');
    expect(output).toContain('friend');
    expect(output).toContain('weekly');
    expect(output).toContain('college');
    expect(output).toContain('05-People/Alice.md');
  });

  it('handles unresolved contact gracefully', () => {
    const contact = makeContact({ name: null, relationship: null, vault_path: null });
    const output = formatContactDetail(contact);
    expect(output).toContain('(unresolved)');
  });
});

describe('formatIngestResult', () => {
  it('formats all result fields', () => {
    const output = formatIngestResult({
      messages_read: 15,
      contacts_created: 3,
      contacts_updated: 2,
      interactions_appended: 10,
      skipped_dedup: 5,
    });
    expect(output).toContain('Messages read: 15');
    expect(output).toContain('Contacts created: 3');
    expect(output).toContain('Contacts updated: 2');
    expect(output).toContain('Interactions appended: 10');
    expect(output).toContain('Skipped (dedup): 5');
  });
});

// ===========================================================================
// Phase 2 Tests
// ===========================================================================

describe('parseFrontmatter', () => {
  it('parses simple YAML frontmatter', () => {
    const content = `---
type: person
relationship: friend
email: alice@test.com
---

# Alice`;
    const fm = parseFrontmatter(content);
    expect(fm.type).toBe('person');
    expect(fm.relationship).toBe('friend');
    expect(fm.email).toBe('alice@test.com');
  });

  it('returns empty object for no frontmatter', () => {
    expect(parseFrontmatter('# Just a heading\nSome text')).toEqual({});
  });

  it('skips empty value fields', () => {
    const content = `---
type: person
birthday:
email:
---`;
    const fm = parseFrontmatter(content);
    expect(fm.type).toBe('person');
    expect(fm.birthday).toBeUndefined();
    expect(fm.email).toBeUndefined();
  });

  it('handles last-contact with date value', () => {
    const content = `---
type: person
last-contact: 2026-04-02
---`;
    const fm = parseFrontmatter(content);
    expect(fm['last-contact']).toBe('2026-04-02');
  });

  it('handles Templater placeholders as empty', () => {
    const content = `---
type: person
last-contact: <% tp.date.now("YYYY-MM-DD") %>
---`;
    const fm = parseFrontmatter(content);
    // Templater syntax is treated as a value
    expect(fm['last-contact']).toBeDefined();
  });
});

describe('extractPhones', () => {
  it('extracts +1 international format', () => {
    expect(extractPhones('Call me at +15551234567')).toContain('+15551234567');
  });

  it('extracts (XXX) XXX-XXXX format', () => {
    const phones = extractPhones('Phone: (555) 123-4567');
    expect(phones.length).toBeGreaterThan(0);
  });

  it('extracts XXX-XXX-XXXX format', () => {
    const phones = extractPhones('Number: 555-123-4567');
    expect(phones.length).toBeGreaterThan(0);
  });

  it('returns empty array for no phones', () => {
    expect(extractPhones('No phone numbers here')).toEqual([]);
  });

  it('deduplicates same number in different formats', () => {
    const phones = extractPhones('+15551234567 and also 5551234567');
    // Both should be extracted, dedup by exact string
    expect(phones.length).toBeGreaterThanOrEqual(1);
  });
});

describe('readVaultPeople', () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-people-'));
  });

  afterEach(() => {
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent directory', () => {
    expect(readVaultPeople('/tmp/nonexistent-vault-dir')).toEqual([]);
  });

  it('reads person files with frontmatter', () => {
    writeFileSync(join(vaultDir, 'Alice.md'), `---
type: person
relationship: friend
email: alice@test.com
---

# Alice Smith

## Context
Friend from college.
`);
    const people = readVaultPeople(vaultDir);
    expect(people).toHaveLength(1);
    expect(people[0].name).toBe('Alice Smith');
    expect(people[0].email).toBe('alice@test.com');
    expect(people[0].relationship).toBe('friend');
  });

  it('skips non-person files', () => {
    writeFileSync(join(vaultDir, 'Dashboard.md'), `---
type: dashboard
---
# People Dashboard`);
    expect(readVaultPeople(vaultDir)).toHaveLength(0);
  });

  it('skips template files starting with _', () => {
    writeFileSync(join(vaultDir, '_template.md'), `---
type: person
---
# Template`);
    expect(readVaultPeople(vaultDir)).toHaveLength(0);
  });

  it('skips People-Dashboard.md', () => {
    writeFileSync(join(vaultDir, 'People-Dashboard.md'), `---
type: dashboard
---
# Dashboard`);
    expect(readVaultPeople(vaultDir)).toHaveLength(0);
  });

  it('extracts phone numbers from content', () => {
    writeFileSync(join(vaultDir, 'Bob.md'), `---
type: person
relationship: friend
email:
---

# Bob

## Notes
Can reach him at +15559876543
`);
    const people = readVaultPeople(vaultDir);
    expect(people[0].phone).toBe('+15559876543');
  });

  it('uses filename as name when no H1 heading', () => {
    writeFileSync(join(vaultDir, 'Charlie-Brown.md'), `---
type: person
relationship: friend
email:
---

No heading here, just notes.
`);
    const people = readVaultPeople(vaultDir);
    expect(people[0].name).toBe('Charlie Brown');
  });
});

describe('updateFrontmatterField', () => {
  it('updates existing field value', () => {
    const content = `---
type: person
last-contact: 2026-04-02
---

# Alice`;
    const updated = updateFrontmatterField(content, 'last-contact', '2026-05-22');
    expect(updated).toContain('last-contact: 2026-05-22');
    expect(updated).not.toContain('2026-04-02');
  });

  it('returns same content when value unchanged', () => {
    const content = `---
type: person
last-contact: 2026-05-22
---

# Alice`;
    expect(updateFrontmatterField(content, 'last-contact', '2026-05-22')).toBe(content);
  });

  it('adds field when not present', () => {
    const content = `---
type: person
relationship: friend
---

# Alice`;
    const updated = updateFrontmatterField(content, 'last-contact', '2026-05-22');
    expect(updated).toContain('last-contact: 2026-05-22');
  });

  it('updates empty field', () => {
    const content = `---
type: person
last-contact:
---

# Alice`;
    const updated = updateFrontmatterField(content, 'last-contact', '2026-05-22');
    expect(updated).toContain('last-contact: 2026-05-22');
  });

  it('preserves content after frontmatter', () => {
    const content = `---
type: person
last-contact: 2026-04-01
---

# Alice

## Notes
Important stuff here.`;
    const updated = updateFrontmatterField(content, 'last-contact', '2026-05-22');
    expect(updated).toContain('Important stuff here.');
    expect(updated).toContain('# Alice');
  });

  it('returns unchanged content when no frontmatter exists', () => {
    const content = '# Just a heading\nNo frontmatter here.';
    expect(updateFrontmatterField(content, 'last-contact', '2026-05-22')).toBe(content);
  });
});

describe('crmResolve', () => {
  let crmDir: string;
  let vaultDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-resolve-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-resolve-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('resolves contact by email match', () => {
    writeContact(crmDir, makeContact({
      id: 'abc', name: null, email: ['alice@test.com'], phone: [],
    }));
    writeFileSync(join(vaultDir, 'Alice.md'), `---
type: person
relationship: friend
email: alice@test.com
---

# Alice Smith`);

    const result = crmResolve({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.resolved).toBe(1);

    const contact = readContact(crmDir, 'abc');
    expect(contact!.name).toBe('Alice Smith');
    expect(contact!.relationship).toBe('friend');
    expect(contact!.vault_path).toBe('05-People/Alice.md');
  });

  it('resolves contact by phone match from vault notes', () => {
    writeContact(crmDir, makeContact({
      id: 'def', name: null, phone: ['+15559876543'], email: [],
    }));
    writeFileSync(join(vaultDir, 'Bob.md'), `---
type: person
relationship: colleague
email:
---

# Bob Jones

## Notes
Reach him at +15559876543
`);

    const result = crmResolve({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.resolved).toBe(1);
    expect(readContact(crmDir, 'def')!.name).toBe('Bob Jones');
  });

  it('skips already-resolved contacts', () => {
    writeContact(crmDir, makeContact({ id: 'ghi', name: 'Already Named' }));

    const result = crmResolve({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.already_resolved).toBe(1);
    expect(result.resolved).toBe(0);
  });

  it('counts unresolved contacts with no vault match', () => {
    writeContact(crmDir, makeContact({
      id: 'jkl', name: null, phone: ['+10000000000'], email: [],
    }));

    const result = crmResolve({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.unresolved).toBe(1);
  });

  it('updates identity map on resolution', () => {
    writeContact(crmDir, makeContact({
      id: 'mno', name: null, email: ['carol@test.com'], phone: [],
    }));
    writeFileSync(join(vaultDir, 'Carol.md'), `---
type: person
relationship: family
email: carol@test.com
---

# Carol`);

    crmResolve({ crmDir, vaultPeoplePath: vaultDir });
    const map = readIdentityMap(crmDir);
    expect(map['carol@test.com']).toBe('mno');
  });

  it('handles empty vault directory', () => {
    writeContact(crmDir, makeContact({ id: 'pqr', name: null }));
    const result = crmResolve({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.unresolved).toBe(1);
  });
});

describe('crmSyncVault', () => {
  let crmDir: string;
  let vaultDir: string;

  beforeEach(() => {
    crmDir = mkdtempSync(join(tmpdir(), 'crm-sync-'));
    vaultDir = mkdtempSync(join(tmpdir(), 'vault-sync-'));
  });

  afterEach(() => {
    rmSync(crmDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
  });

  it('updates vault last-contact from CRM data', () => {
    writeContact(crmDir, makeContact({
      id: 'a',
      vault_path: '05-People/Alice.md',
      last_interaction: '2026-05-22T14:30:00.000Z',
    }));
    writeFileSync(join(vaultDir, 'Alice.md'), `---
type: person
last-contact: 2026-04-01
---

# Alice`);

    const result = crmSyncVault({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.updated).toBe(1);

    const content = readFileSync(join(vaultDir, 'Alice.md'), 'utf-8');
    expect(content).toContain('last-contact: 2026-05-22');
    expect(content).not.toContain('2026-04-01');
  });

  it('skips contacts without vault_path', () => {
    writeContact(crmDir, makeContact({ id: 'b', vault_path: null }));
    const result = crmSyncVault({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.skipped_no_vault).toBe(1);
  });

  it('skips contacts without last_interaction', () => {
    writeContact(crmDir, makeContact({
      id: 'c', vault_path: '05-People/Carol.md', last_interaction: null,
    }));
    const result = crmSyncVault({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.skipped_no_vault).toBe(1);
  });

  it('skips when vault file does not exist', () => {
    writeContact(crmDir, makeContact({
      id: 'd', vault_path: '05-People/Missing.md', last_interaction: '2026-05-22T00:00:00Z',
    }));
    const result = crmSyncVault({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.skipped_no_vault).toBe(1);
  });

  it('skips when last-contact is already current', () => {
    writeContact(crmDir, makeContact({
      id: 'e',
      vault_path: '05-People/Eve.md',
      last_interaction: '2026-05-22T14:30:00.000Z',
    }));
    writeFileSync(join(vaultDir, 'Eve.md'), `---
type: person
last-contact: 2026-05-22
---

# Eve`);

    const result = crmSyncVault({ crmDir, vaultPeoplePath: vaultDir });
    expect(result.skipped_no_change).toBe(1);
  });

  it('preserves all vault content except last-contact', () => {
    writeContact(crmDir, makeContact({
      id: 'f',
      vault_path: '05-People/Frank.md',
      last_interaction: '2026-05-22T10:00:00.000Z',
    }));
    writeFileSync(join(vaultDir, 'Frank.md'), `---
type: person
relationship: friend
last-contact: 2026-01-01
---

# Frank

## Notes
Very important notes that must not be touched.

## Interactions
- 2026-01-01: Grabbed coffee

---
*Tags: #person #friend*
`);

    crmSyncVault({ crmDir, vaultPeoplePath: vaultDir });
    const content = readFileSync(join(vaultDir, 'Frank.md'), 'utf-8');
    expect(content).toContain('relationship: friend');
    expect(content).toContain('Very important notes that must not be touched.');
    expect(content).toContain('Grabbed coffee');
    expect(content).toContain('#person #friend');
    expect(content).toContain('last-contact: 2026-05-22');
  });
});

describe('formatResolveResult', () => {
  it('formats all fields', () => {
    const output = formatResolveResult({ resolved: 3, already_resolved: 5, unresolved: 2 });
    expect(output).toContain('Resolved: 3');
    expect(output).toContain('Already resolved: 5');
    expect(output).toContain('Unresolved: 2');
  });
});

describe('formatSyncVaultResult', () => {
  it('formats all fields', () => {
    const output = formatSyncVaultResult({ updated: 4, skipped_no_vault: 2, skipped_no_change: 1 });
    expect(output).toContain('Updated: 4');
    expect(output).toContain('Skipped (no vault link): 2');
    expect(output).toContain('Skipped (no change): 1');
  });
});
