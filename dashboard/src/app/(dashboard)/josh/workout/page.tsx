'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  IconCheck,
  IconCircle,
  IconCircleCheck,
  IconBarbell,
  IconFlame,
  IconStretching,
  IconRefresh,
  IconScale,
} from '@tabler/icons-react';

interface WorkoutSet {
  label: string;
  weight: string;
  logged: string;
  lineIndex: number;
}

interface WorkoutExercise {
  name: string;
  done: boolean;
  notes: string;
  sets: WorkoutSet[];
  lineIndex: number;
}

interface WorkoutChecklist {
  text: string;
  done: boolean;
  lineIndex: number;
}

interface WorkoutSection {
  type: 'warmup' | 'exercise' | 'cooldown' | 'bike' | 'other';
  title: string;
  items: WorkoutChecklist[];
  exercises?: WorkoutExercise[];
}

interface WorkoutData {
  title: string;
  split: string;
  coachNote: string;
  sections: WorkoutSection[];
  bodyweight: string;
}

export default function WorkoutPage() {
  const [workout, setWorkout] = useState<WorkoutData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const searchParams = useSearchParams();
  const token = searchParams.get('token');

  // Build API URL with token if present
  const apiUrl = useMemo(() => {
    const base = '/api/workout';
    return token ? `${base}?token=${encodeURIComponent(token)}` : base;
  }, [token]);

  const fetchWorkout = useCallback(async () => {
    try {
      const res = await fetch(apiUrl);
      if (!res.ok) {
        setError('No workout loaded today');
        return;
      }
      const data = await res.json();
      setWorkout(data);
      setError(null);
    } catch {
      setError('Failed to load workout');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchWorkout(); }, [fetchWorkout]);

  async function toggle(lineIndex: number) {
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'toggle', lineIndex }),
    });
    fetchWorkout();
  }

  async function saveSet(lineIndex: number, value: string) {
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'logSet', lineIndex, value }),
    });
  }

  async function saveBodyweight(value: string) {
    await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'bodyweight', value }),
    });
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="animate-spin"><IconBarbell size={32} className="text-muted-foreground" /></div>
      </div>
    );
  }

  if (error || !workout) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <IconBarbell size={48} className="text-muted-foreground" />
        <p className="text-muted-foreground">{error || 'No workout found'}</p>
        <Button variant="outline" onClick={fetchWorkout}>
          <IconRefresh size={16} className="mr-2" /> Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="max-w-lg mx-auto space-y-4 pb-8">
      {/* Header */}
      <div>
        <h1 className="text-xl font-semibold">{workout.split || workout.title}</h1>
        <p className="text-xs text-muted-foreground">{workout.title}</p>
      </div>

      {/* Coach note */}
      {workout.coachNote && (
        <div className="rounded-lg border-l-4 border-blue-500 bg-blue-500/5 px-4 py-3">
          <p className="text-xs font-medium text-blue-600 dark:text-blue-400 mb-1">Coach</p>
          <p className="text-sm text-muted-foreground leading-relaxed">{workout.coachNote}</p>
        </div>
      )}

      {/* Sections */}
      {workout.sections.map((section, si) => {
        if (section.type === 'warmup' || section.type === 'cooldown' || section.type === 'bike') {
          return (
            <ChecklistSection
              key={si}
              title={section.title}
              icon={section.type === 'warmup' ? <IconFlame size={16} /> : <IconStretching size={16} />}
              items={section.items}
              onToggle={toggle}
            />
          );
        }

        if (section.type === 'exercise' && section.exercises) {
          return (
            <div key={si} className="space-y-3">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider px-1">
                {section.title}
              </p>
              {section.exercises.map((ex, ei) => (
                <ExerciseCard key={ei} exercise={ex} onSaveSet={saveSet} onToggle={toggle} />
              ))}
            </div>
          );
        }

        return null;
      })}

      {/* Bodyweight */}
      <BodyweightInput initial={workout.bodyweight} onSave={saveBodyweight} />

      {/* Refresh */}
      <div className="text-center pt-2">
        <Button variant="ghost" size="sm" onClick={fetchWorkout} className="text-muted-foreground">
          <IconRefresh size={14} className="mr-1" /> Refresh
        </Button>
      </div>
    </div>
  );
}

function ChecklistSection({
  title,
  icon,
  items,
  onToggle,
}: {
  title: string;
  icon: React.ReactNode;
  items: WorkoutChecklist[];
  onToggle: (lineIndex: number) => void;
}) {
  const doneCount = items.filter(i => i.done).length;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {icon}
          {title}
          <span className="ml-auto text-xs text-muted-foreground font-normal">
            {doneCount}/{items.length}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {items.map((item) => (
          <button
            key={item.lineIndex}
            onClick={() => onToggle(item.lineIndex)}
            className={cn(
              'flex items-start gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
              'active:bg-muted/80',
              item.done ? 'opacity-50' : 'hover:bg-muted/50'
            )}
          >
            {item.done ? (
              <IconCircleCheck size={18} className="shrink-0 mt-0.5 text-green-500" />
            ) : (
              <IconCircle size={18} className="shrink-0 mt-0.5 text-muted-foreground" />
            )}
            <span className={cn(item.done && 'line-through')}>{item.text}</span>
          </button>
        ))}
      </CardContent>
    </Card>
  );
}

function ExerciseCard({
  exercise,
  onSaveSet,
  onToggle,
}: {
  exercise: WorkoutExercise;
  onSaveSet: (lineIndex: number, value: string) => void;
  onToggle: (lineIndex: number) => void;
}) {
  const allLogged = exercise.sets.length > 0 && exercise.sets.filter(s => s.label.startsWith('Set')).every(s => !!s.logged);

  return (
    <Card className={cn(exercise.done && 'opacity-60')}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          {exercise.lineIndex >= 0 ? (
            <button onClick={() => onToggle(exercise.lineIndex)} className="shrink-0">
              {exercise.done ? (
                <IconCircleCheck size={18} className="text-green-500" />
              ) : allLogged ? (
                <IconCircle size={18} className="text-green-500/50" />
              ) : (
                <IconBarbell size={16} className="text-primary" />
              )}
            </button>
          ) : (
            <IconBarbell size={16} className="text-primary" />
          )}
          <span className={cn(exercise.done && 'line-through')}>{exercise.name}</span>
        </CardTitle>
        {exercise.notes && (
          <p className="text-xs text-muted-foreground italic pl-6">{exercise.notes}</p>
        )}
      </CardHeader>
      <CardContent className="space-y-2">
        {exercise.sets.map((set) => (
          <SetRow key={set.lineIndex} set={set} onSave={onSaveSet} />
        ))}
      </CardContent>
    </Card>
  );
}

function SetRow({
  set,
  onSave,
}: {
  set: WorkoutSet;
  onSave: (lineIndex: number, value: string) => void;
}) {
  const [value, setValue] = useState(set.logged);
  const [saved, setSaved] = useState(!!set.logged);

  function handleSave() {
    if (!value.trim()) return;
    onSave(set.lineIndex, value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium whitespace-nowrap">{set.label}</span>
          {set.weight && (
            <span className="text-xs text-muted-foreground">({set.weight})</span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-1.5">
        <Input
          value={value}
          onChange={(e) => { setValue(e.target.value); setSaved(false); }}
          onBlur={handleSave}
          onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
          placeholder="reps"
          className="w-28 h-8 text-sm text-center"
          inputMode="text"
        />
        {saved && <IconCheck size={16} className="text-green-500 shrink-0" />}
      </div>
    </div>
  );
}

function BodyweightInput({
  initial,
  onSave,
}: {
  initial: string;
  onSave: (value: string) => void;
}) {
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    if (!value.trim()) return;
    onSave(value.trim());
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-3">
        <IconScale size={18} className="text-muted-foreground shrink-0" />
        <span className="text-sm font-medium">Bodyweight</span>
        <div className="flex items-center gap-1.5 ml-auto">
          <Input
            value={value}
            onChange={(e) => { setValue(e.target.value); setSaved(false); }}
            onBlur={handleSave}
            onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            placeholder="lbs"
            className="w-20 h-8 text-sm text-center"
            inputMode="decimal"
          />
          {saved && <IconCheck size={16} className="text-green-500 shrink-0" />}
        </div>
      </CardContent>
    </Card>
  );
}
