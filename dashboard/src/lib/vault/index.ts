import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';

const VAULT_PATH = process.env.VAULT_PATH || path.join(process.env.HOME || '~', 'SecondBrain');

export interface VaultNote {
  frontmatter: Record<string, unknown>;
  content: string;
  path: string;
}

export interface ChecklistItem {
  done: boolean;
  text: string;
}

export interface ProjectInfo {
  name: string;
  slug: string;
  priority: string;
  status: string | null;
  nextAction: string | null;
  lastTouched: string | null;
  daysSinceTouch: number | null;
  staleness: string;
  needsAttention: boolean;
}

export interface AreaInfo {
  id: string;
  name: string;
  icon: string;
  summary: string | null;
  lastTouched: string | null;
  daysSinceTouch: number | null;
  staleness: string;
  data: Record<string, unknown>;
}

export function getVaultPath(): string {
  return VAULT_PATH;
}

export function readNote(filePath: string): VaultNote | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const { data: frontmatter, content } = matter(raw);
    return { frontmatter, content, path: filePath };
  } catch {
    return null;
  }
}

export function parseChecklistItems(content: string): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  for (const line of content.split('\n')) {
    const match = line.match(/^- \[([ x])\] (.+)/);
    if (match) {
      items.push({
        done: match[1] === 'x',
        text: match[2].replace(/\*\*/g, '').replace(/~~(.+?)~~/g, '$1'),
      });
    }
  }
  return items;
}

export function daysAgo(isoDate: string | null | undefined): number | null {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86400000);
}

export function staleness(days: number | null): string {
  if (days === null) return 'unknown';
  if (days <= 3) return 'fresh';
  if (days <= 7) return 'recent';
  if (days <= 14) return 'aging';
  if (days <= 30) return 'stale';
  return 'neglected';
}

export function fileAge(filePath: string): { modified: string | null; daysAgo: number | null } {
  try {
    const stat = fs.statSync(filePath);
    const modified = stat.mtime.toISOString();
    return { modified, daysAgo: daysAgo(modified) };
  } catch {
    return { modified: null, daysAgo: null };
  }
}

export function getProjects(): ProjectInfo[] {
  const projectsDir = path.join(VAULT_PATH, '02-Projects');
  const projects: ProjectInfo[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(projectsDir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const fullPath = path.join(projectsDir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      continue;
    }

    let note: VaultNote | null = null;
    let notePath: string | null = null;

    if (stat.isDirectory()) {
      const files = fs.readdirSync(fullPath);
      const hub = files.find(f => f.startsWith('_') && f.endsWith('-hub.md'))
        || files.find(f => f.endsWith('-hub.md'))
        || files.find(f => f.endsWith('.md'));
      if (hub) {
        notePath = path.join(fullPath, hub);
        note = readNote(notePath);
      }
    } else if (entry.endsWith('.md') && !entry.startsWith('_')) {
      notePath = fullPath;
      note = readNote(fullPath);
    }

    if (note && note.frontmatter.priority) {
      const file = fileAge(notePath!);
      const fmUpdated = note.frontmatter.updated as string | undefined;
      const lastTouched = fmUpdated || file.modified;
      const daysSinceTouch = daysAgo(lastTouched);

      let newestDays = file.daysAgo;
      if (stat.isDirectory()) {
        try {
          for (const f of fs.readdirSync(fullPath)) {
            const fAge = fileAge(path.join(fullPath, f));
            if (fAge.daysAgo !== null && (newestDays === null || fAge.daysAgo < newestDays)) {
              newestDays = fAge.daysAgo;
            }
          }
        } catch { /* skip */ }
      }

      const effectiveDays = Math.min(daysSinceTouch ?? 999, newestDays ?? 999);

      projects.push({
        name: note.content.match(/^# (.+)/m)?.[1] || entry.replace('.md', ''),
        slug: entry.replace('.md', ''),
        priority: note.frontmatter.priority as string,
        status: (note.frontmatter.status as string) || null,
        nextAction: (note.frontmatter['next-action'] as string) || null,
        lastTouched,
        daysSinceTouch: effectiveDays,
        staleness: staleness(effectiveDays),
        needsAttention: note.frontmatter.priority === 'active' && (effectiveDays ?? 0) > 7,
      });
    }
  }

  const order: Record<string, number> = { active: 0, 'long-term': 1, idea: 2 };
  projects.sort((a, b) => {
    const pa = order[a.priority] ?? 3;
    const pb = order[b.priority] ?? 3;
    if (pa !== pb) return pa - pb;
    return (b.daysSinceTouch ?? 0) - (a.daysSinceTouch ?? 0);
  });

  return projects;
}

export function getActionItems(): { timeSensitive: ChecklistItem[]; tomorrow: ChecklistItem[]; general: ChecklistItem[] } {
  const dashPath = path.join(VAULT_PATH, '00-Dashboard.md');
  const note = readNote(dashPath);
  if (!note) return { timeSensitive: [], tomorrow: [], general: [] };

  const timeSensitive: ChecklistItem[] = [];
  const tomorrow: ChecklistItem[] = [];
  const general: ChecklistItem[] = [];

  let currentSection = 'general';
  for (const line of note.content.split('\n')) {
    if (/time.?sensitive|urgent|today/i.test(line) && (line.startsWith('#') || line.startsWith('**'))) {
      currentSection = 'timeSensitive';
      continue;
    }
    if (/tomorrow/i.test(line) && (line.startsWith('#') || line.startsWith('**'))) {
      currentSection = 'tomorrow';
      continue;
    }
    if ((line.startsWith('#') || line.startsWith('**')) && !/time.?sensitive|urgent|today|tomorrow/i.test(line)) {
      currentSection = 'general';
    }

    const match = line.match(/^- \[([ x])\] (.+)/);
    if (match) {
      const item: ChecklistItem = {
        done: match[1] === 'x',
        text: match[2].replace(/\*\*/g, '').replace(/~~(.+?)~~/g, '$1'),
      };
      if (currentSection === 'timeSensitive') timeSensitive.push(item);
      else if (currentSection === 'tomorrow') tomorrow.push(item);
      else general.push(item);
    }
  }

  return { timeSensitive, tomorrow, general };
}

interface AreaConfig {
  id: string;
  name: string;
  icon: string;
  file: string | null;
}

const AREA_CONFIGS: AreaConfig[] = [
  { id: 'health', name: 'Health & Fitness', icon: 'heart-pulse', file: 'Health-Fitness/health-fitness-hub.md' },
  { id: 'finances', name: 'Finances', icon: 'wallet', file: 'Finances/financial-goals.md' },
  { id: 'career', name: 'Career & AI', icon: 'trending-up', file: 'Career-Development/ai-and-career.md' },
  { id: 'camping', name: 'Camping & Car', icon: 'tent', file: 'Camping-Car.md' },
  { id: 'security', name: 'Security', icon: 'shield-lock', file: null },
  { id: 'second-brain', name: 'Second Brain', icon: 'brain', file: null },
];

export function getAreas(): AreaInfo[] {
  const areasDir = path.join(VAULT_PATH, '03-Areas');
  const areas: AreaInfo[] = [];

  for (const cfg of AREA_CONFIGS) {
    let filePath: string | null = null;
    let note: VaultNote | null = null;

    if (cfg.file) {
      filePath = path.join(areasDir, cfg.file);
      note = readNote(filePath);
    }

    const file = filePath ? fileAge(filePath) : { modified: null, daysAgo: null };
    const fmUpdated = note?.frontmatter?.updated as string | undefined;
    const lastTouched = fmUpdated || file.modified;
    const daysSince = daysAgo(lastTouched);

    // Build summary from content
    let summary: string | null = null;
    if (note) {
      const items = parseChecklistItems(note.content);
      const pending = items.filter(i => !i.done).length;
      const done = items.filter(i => i.done).length;
      if (items.length > 0) {
        summary = `${done}/${items.length} done, ${pending} pending`;
      }
    }

    areas.push({
      id: cfg.id,
      name: cfg.name,
      icon: cfg.icon,
      summary,
      lastTouched,
      daysSinceTouch: daysSince,
      staleness: staleness(daysSince),
      data: {},
    });
  }

  return areas;
}
