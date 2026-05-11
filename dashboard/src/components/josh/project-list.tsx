'use client';

import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ProjectInfo } from '@/lib/vault';

const PRIORITY_COLORS: Record<string, string> = {
  active: 'bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20',
  'long-term': 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20',
  idea: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/20',
};

const STALENESS_COLORS: Record<string, string> = {
  fresh: 'text-green-600 dark:text-green-400',
  recent: 'text-blue-600 dark:text-blue-400',
  aging: 'text-yellow-600 dark:text-yellow-400',
  stale: 'text-orange-600 dark:text-orange-400',
  neglected: 'text-red-600 dark:text-red-400',
  unknown: 'text-muted-foreground',
};

interface ProjectListProps {
  projects: ProjectInfo[];
}

export function ProjectList({ projects }: ProjectListProps) {
  if (projects.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No projects found in vault.
        </CardContent>
      </Card>
    );
  }

  const grouped = {
    active: projects.filter(p => p.priority === 'active'),
    'long-term': projects.filter(p => p.priority === 'long-term'),
    idea: projects.filter(p => p.priority === 'idea'),
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Projects ({projects.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {Object.entries(grouped).map(([priority, items]) => {
          if (items.length === 0) return null;
          return (
            <div key={priority}>
              <div className="flex items-center gap-2 mb-2">
                <Badge variant="outline" className={cn('text-xs capitalize', PRIORITY_COLORS[priority])}>
                  {priority}
                </Badge>
                <span className="text-xs text-muted-foreground">{items.length}</span>
              </div>
              <div className="space-y-1">
                {items.map((project) => (
                  <div
                    key={project.slug}
                    className={cn(
                      'flex items-center justify-between rounded-md px-3 py-2 text-sm',
                      project.needsAttention ? 'bg-orange-500/5 border border-orange-500/20' : 'hover:bg-muted/50'
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium truncate">{project.name}</p>
                      {project.nextAction && (
                        <p className="text-xs text-muted-foreground truncate">
                          Next: {project.nextAction}
                        </p>
                      )}
                    </div>
                    <div className="flex items-center gap-2 ml-3 shrink-0">
                      {project.status && (
                        <span className="text-xs text-muted-foreground">{project.status}</span>
                      )}
                      <span className={cn('text-xs font-medium', STALENESS_COLORS[project.staleness])}>
                        {project.daysSinceTouch !== null ? `${project.daysSinceTouch}d` : '-'}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
