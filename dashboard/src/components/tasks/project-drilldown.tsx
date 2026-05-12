'use client';

import { useMemo } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StatusBadge } from '@/components/shared/status-badge';
import { PriorityBadge } from '@/components/shared/priority-badge';
import type { Task } from '@/lib/types';

interface ProjectDrilldownProps {
  tasks: Task[];
  onTaskClick: (task: Task) => void;
}

interface ProjectGroup {
  name: string;
  tasks: Task[];
  completed: number;
  total: number;
  inProgress: number;
  blocked: number;
  pending: number;
  highestUrgency: number;
}

export function ProjectDrilldown({ tasks, onTaskClick }: ProjectDrilldownProps) {
  const projects = useMemo(() => {
    const groups = new Map<string, Task[]>();

    for (const task of tasks) {
      const project = task.project || '(No project)';
      if (!groups.has(project)) groups.set(project, []);
      groups.get(project)!.push(task);
    }

    const result: ProjectGroup[] = [];
    for (const [name, projectTasks] of groups) {
      const completed = projectTasks.filter((t) => t.status === 'completed').length;
      const inProgress = projectTasks.filter((t) => t.status === 'in_progress').length;
      const blocked = projectTasks.filter((t) => t.status === 'blocked').length;
      const pending = projectTasks.filter((t) => t.status === 'pending').length;
      const highestUrgency = Math.max(0, ...projectTasks.map((t) => t.urgency_score ?? 0));

      result.push({
        name,
        tasks: projectTasks,
        completed,
        total: projectTasks.length,
        inProgress,
        blocked,
        pending,
        highestUrgency,
      });
    }

    // Sort: projects with highest urgency first, then by most incomplete tasks
    result.sort((a, b) => {
      const aIncomplete = a.total - a.completed;
      const bIncomplete = b.total - b.completed;
      if (aIncomplete === 0 && bIncomplete > 0) return 1;
      if (bIncomplete === 0 && aIncomplete > 0) return -1;
      return b.highestUrgency - a.highestUrgency;
    });

    return result;
  }, [tasks]);

  if (projects.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        No tasks with projects assigned.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
      {projects.map((project) => (
        <ProjectCard
          key={project.name}
          project={project}
          onTaskClick={onTaskClick}
        />
      ))}
    </div>
  );
}

function ProjectCard({
  project,
  onTaskClick,
}: {
  project: ProjectGroup;
  onTaskClick: (task: Task) => void;
}) {
  const progressPercent = project.total > 0
    ? Math.round((project.completed / project.total) * 100)
    : 0;

  const isComplete = project.completed === project.total;

  return (
    <Card className={isComplete ? 'opacity-60' : undefined}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-semibold truncate">
            {project.name}
          </CardTitle>
          <span className="shrink-0 text-xs text-muted-foreground">
            {project.completed}/{project.total}
          </span>
        </div>
        <Progress value={progressPercent} className="h-2" />
        <div className="flex gap-3 text-xs text-muted-foreground pt-1">
          {project.inProgress > 0 && (
            <span className="text-blue-600 dark:text-blue-400">
              {project.inProgress} in progress
            </span>
          )}
          {project.blocked > 0 && (
            <span className="text-red-600 dark:text-red-400">
              {project.blocked} blocked
            </span>
          )}
          {project.pending > 0 && (
            <span>{project.pending} pending</span>
          )}
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        <div className="space-y-1.5 max-h-[200px] overflow-y-auto">
          {project.tasks
            .filter((t) => t.status !== 'completed')
            .sort((a, b) => (b.urgency_score ?? 0) - (a.urgency_score ?? 0))
            .slice(0, 5)
            .map((task) => (
              <div
                key={task.id}
                className="flex items-center gap-2 rounded px-2 py-1 text-xs cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => onTaskClick(task)}
              >
                <StatusBadge status={task.status} />
                <span className="truncate flex-1">{task.title}</span>
                <PriorityBadge priority={task.priority} />
              </div>
            ))}
          {project.tasks.filter((t) => t.status !== 'completed').length > 5 && (
            <p className="text-xs text-muted-foreground text-center pt-1">
              +{project.tasks.filter((t) => t.status !== 'completed').length - 5} more
            </p>
          )}
          {project.tasks.filter((t) => t.status !== 'completed').length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-2">
              All tasks complete
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
