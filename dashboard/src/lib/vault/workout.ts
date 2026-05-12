import fs from 'fs';
import path from 'path';

const VAULT_PATH = process.env.VAULT_PATH || path.join(process.env.HOME || '~', 'Documents', 'SecondBrain');
const WORKOUT_FILE = path.join(VAULT_PATH, '03-Areas/Health-Fitness/workout-today.md');

export interface WorkoutSet {
  label: string;       // "Set 1" or "RIR" or "Round 1 — Skulls:    Laterals:"
  weight: string;      // "70 lb" or ""
  logged: string;      // whatever the user typed after the colon
  lineIndex: number;
}

export interface WorkoutExercise {
  name: string;        // "Incline DB Press — 4x6-10"
  done: boolean;       // checklist state (for ### format exercises)
  notes: string;       // italic instruction/target line
  sets: WorkoutSet[];
  lineIndex: number;
}

export interface WorkoutChecklist {
  text: string;
  done: boolean;
  lineIndex: number;
}

export interface WorkoutSection {
  type: 'warmup' | 'exercise' | 'cooldown' | 'bike' | 'other';
  title: string;
  items: WorkoutChecklist[];
  exercises?: WorkoutExercise[];
}

export interface WorkoutData {
  title: string;
  split: string;
  coachNote: string;
  sections: WorkoutSection[];
  bodyweight: string;
  raw: string;
}

export function parseWorkout(): WorkoutData | null {
  let raw: string;
  try {
    raw = fs.readFileSync(WORKOUT_FILE, 'utf-8');
  } catch {
    return null;
  }

  const lines = raw.split('\n');

  // Extract frontmatter
  let split = '';
  let inFrontmatter = false;
  let frontmatterEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    if (i === 0 && lines[i].trim() === '---') { inFrontmatter = true; continue; }
    if (inFrontmatter && lines[i].trim() === '---') { frontmatterEnd = i; break; }
    if (inFrontmatter) {
      const m = lines[i].match(/^split:\s*(.+)/);
      if (m) split = m[1].trim();
    }
  }

  // Title
  let title = '';
  const titleLine = lines.find(l => l.startsWith('# '));
  if (titleLine) title = titleLine.replace(/^# /, '');

  // Coach/Trainer note — blockquote starting with > **
  let coachNote = '';
  const noteLines: string[] = [];
  for (let i = frontmatterEnd + 1; i < lines.length; i++) {
    if (lines[i].startsWith('> ')) {
      noteLines.push(lines[i].replace(/^> /, ''));
    } else if (noteLines.length > 0) {
      break;
    }
  }
  if (noteLines.length > 0) {
    coachNote = noteLines.join(' ')
      .replace(/^\*\*(?:Coach note|Trainer note)[^*]*\*\*:?\s*/i, '')
      .trim();
  }

  // Parse sections — supports both formats:
  // Format A (bold): **Warm-Up**, **1. Exercise**, **Cool-Down**, **Bike:**
  // Format B (###):  ### Warm-Up, ### Main Work, ### Bike
  const sections: WorkoutSection[] = [];
  let currentSection: WorkoutSection | null = null;
  let currentExercise: WorkoutExercise | null = null;
  let bodyweight = '';

  for (let i = frontmatterEnd + 1; i < lines.length; i++) {
    const line = lines[i];

    // === Section headers ===

    // Format B: ### headers
    const h3Match = line.match(/^### (.+)/);
    if (h3Match) {
      const sectionTitle = h3Match[1].trim();
      currentSection = {
        type: classifySection(sectionTitle),
        title: sectionTitle,
        items: [],
        exercises: [],
      };
      sections.push(currentSection);
      currentExercise = null;
      continue;
    }

    // Format A: **Warm-Up ...:**
    if (/^\*\*Warm-Up/i.test(line)) {
      currentSection = { type: 'warmup', title: 'Warm-Up', items: [], exercises: [] };
      sections.push(currentSection);
      currentExercise = null;
      continue;
    }
    if (/^\*\*Cool-Down/i.test(line)) {
      currentSection = { type: 'cooldown', title: 'Cool-Down', items: [], exercises: [] };
      sections.push(currentSection);
      currentExercise = null;
      continue;
    }
    if (/^\*\*Bike:?\*\*/i.test(line)) {
      // Bike as a single line, not a section with items
      if (!currentSection || currentSection.type !== 'bike') {
        currentSection = { type: 'bike', title: 'Bike', items: [], exercises: [] };
        sections.push(currentSection);
      }
      // Extract inline text after **Bike:**
      const bikeText = line.replace(/^\*\*Bike:?\*\*:?\s*/i, '').trim();
      if (bikeText) {
        currentSection.items.push({ text: bikeText, done: false, lineIndex: i });
      }
      currentExercise = null;
      continue;
    }

    // Bodyweight line
    if (/^\*\*Bodyweight/i.test(line)) {
      const bwMatch = line.match(/^\*\*Bodyweight[^*]*\*\*:?\s*(.*)/);
      bodyweight = bwMatch ? bwMatch[1].replace(/_+/g, '').replace(/\s*lbs?\s*$/i, '').trim() : '';
      continue;
    }

    // Format A: **N. Exercise Name — sets**
    const exBoldMatch = line.match(/^\*\*(\d+)\.\s+(.+?)\*\*$/);
    if (exBoldMatch) {
      if (!currentSection || currentSection.type !== 'exercise') {
        currentSection = { type: 'exercise', title: 'Exercises', items: [], exercises: [] };
        sections.push(currentSection);
      }
      currentExercise = {
        name: exBoldMatch[2],
        done: false,
        notes: '',
        sets: [],
        lineIndex: i,
      };
      currentSection.exercises!.push(currentExercise);
      continue;
    }

    // Format B: top-level checklist exercise "- [ ] Exercise — sets"
    const checkMatch = line.match(/^- \[([ x])\] (.+)/);
    if (checkMatch && currentSection) {
      const text = checkMatch[2];
      const done = checkMatch[1] === 'x';

      if (currentSection.type === 'exercise') {
        // Exercise as checklist item
        currentExercise = {
          name: text.replace(/\*([^*]+)\*/g, '$1'),
          done,
          notes: '',
          sets: [],
          lineIndex: i,
        };
        currentSection.exercises!.push(currentExercise);
      } else {
        // Warmup, cooldown, bike checklist
        currentSection.items.push({
          text: text.replace(/\*([^*]+)\*/g, '$1'),
          done,
          lineIndex: i,
        });
        currentExercise = null;
      }
      continue;
    }

    // Set lines — both formats
    // "- Set 1 (70 lb):" or "  - Set 1:" or "- Set 1:"
    const setMatch = line.match(/^\s*- (Set \d+)(?: \(([^)]+)\))?:\s*(.*)/);
    if (setMatch && currentExercise) {
      currentExercise.sets.push({
        label: setMatch[1],
        weight: setMatch[2] || '',
        logged: setMatch[3].trim(),
        lineIndex: i,
      });
      continue;
    }

    // RIR line: "  - RIR:"
    const rirMatch = line.match(/^\s*- (RIR):\s*(.*)/);
    if (rirMatch && currentExercise) {
      currentExercise.sets.push({
        label: 'RIR',
        weight: '',
        logged: rirMatch[2].trim(),
        lineIndex: i,
      });
      continue;
    }

    // Round lines: "- Round 1 — Skulls:    Laterals:"
    const roundMatch = line.match(/^\s*- (Round \d+)\s*[—–-]\s*(.*)/);
    if (roundMatch && currentExercise) {
      currentExercise.sets.push({
        label: roundMatch[1],
        weight: '',
        logged: roundMatch[2].trim(),
        lineIndex: i,
      });
      continue;
    }

    // Italic instruction/target under exercise
    // Format A: "*instruction text*"
    // Format B: "  - *Target: ...*"
    if (currentExercise && currentExercise.sets.length === 0) {
      const italicInline = line.match(/^\*([^*].+)\*$/);
      const italicIndented = line.match(/^\s+- \*(.+)\*$/);
      if (italicInline) {
        currentExercise.notes = italicInline[1].trim();
        continue;
      }
      if (italicIndented) {
        currentExercise.notes = italicIndented[1].trim();
        continue;
      }
    }

    // Italic bullet description under superset (not a set, just description)
    // "- *Skull Crushers (EZ bar, 60 lb): ...*"
    if (currentExercise && line.match(/^- \*[^*]+\*$/)) {
      // Skip superset exercise descriptions — they're informational
      continue;
    }
  }

  return { title, split, coachNote, sections, bodyweight, raw };
}

function classifySection(title: string): WorkoutSection['type'] {
  if (/warm.?up/i.test(title)) return 'warmup';
  if (/cool.?down/i.test(title)) return 'cooldown';
  if (/bike|cardio/i.test(title)) return 'bike';
  if (/main|work|exercise|superset/i.test(title)) return 'exercise';
  return 'other';
}

export function toggleChecklist(lineIndex: number): boolean {
  try {
    const raw = fs.readFileSync(WORKOUT_FILE, 'utf-8');
    const lines = raw.split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return false;
    const line = lines[lineIndex];
    if (line.includes('- [ ] ')) {
      lines[lineIndex] = line.replace('- [ ] ', '- [x] ');
    } else if (line.includes('- [x] ')) {
      lines[lineIndex] = line.replace('- [x] ', '- [ ] ');
    } else {
      return false;
    }
    fs.writeFileSync(WORKOUT_FILE, lines.join('\n'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function logSet(lineIndex: number, value: string): boolean {
  try {
    const raw = fs.readFileSync(WORKOUT_FILE, 'utf-8');
    const lines = raw.split('\n');
    if (lineIndex < 0 || lineIndex >= lines.length) return false;
    const line = lines[lineIndex];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return false;
    lines[lineIndex] = line.substring(0, colonIdx + 1) + ' ' + value;
    fs.writeFileSync(WORKOUT_FILE, lines.join('\n'), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function logBodyweight(value: string): boolean {
  try {
    const raw = fs.readFileSync(WORKOUT_FILE, 'utf-8');
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\*\*Bodyweight/i.test(lines[i])) {
        lines[i] = `**Bodyweight Log:** ${value} lbs`;
        fs.writeFileSync(WORKOUT_FILE, lines.join('\n'), 'utf-8');
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
