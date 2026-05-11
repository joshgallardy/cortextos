'use client';

import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { IconCircleCheck, IconCircle, IconAlertTriangle, IconClock } from '@tabler/icons-react';
import type { ChecklistItem } from '@/lib/vault';

interface ActionItemsPanelProps {
  actionItems: {
    timeSensitive: ChecklistItem[];
    tomorrow: ChecklistItem[];
    general: ChecklistItem[];
  };
}

function ItemRow({ item }: { item: ChecklistItem }) {
  return (
    <div className={cn('flex items-start gap-2 py-1', item.done && 'opacity-50')}>
      {item.done ? (
        <IconCircleCheck size={16} className="shrink-0 mt-0.5 text-green-500" />
      ) : (
        <IconCircle size={16} className="shrink-0 mt-0.5 text-muted-foreground" />
      )}
      <span className={cn('text-sm', item.done && 'line-through text-muted-foreground')}>
        {item.text}
      </span>
    </div>
  );
}

export function ActionItemsPanel({ actionItems }: ActionItemsPanelProps) {
  const { timeSensitive, tomorrow, general } = actionItems;
  const totalPending = [...timeSensitive, ...tomorrow, ...general].filter(i => !i.done).length;

  if (totalPending === 0 && timeSensitive.length === 0 && tomorrow.length === 0 && general.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No action items found in 00-Dashboard.md
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground">
          Action Items
          {totalPending > 0 && (
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary normal-case">
              {totalPending}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Time-sensitive */}
        {timeSensitive.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <IconAlertTriangle size={14} className="text-red-500" />
              <span className="text-xs font-medium text-red-600 dark:text-red-400 uppercase">Time-Sensitive</span>
            </div>
            <div className="space-y-0.5">
              {timeSensitive.map((item, i) => <ItemRow key={i} item={item} />)}
            </div>
          </div>
        )}

        {/* Tomorrow */}
        {tomorrow.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <IconClock size={14} className="text-yellow-500" />
              <span className="text-xs font-medium text-yellow-600 dark:text-yellow-400 uppercase">Tomorrow</span>
            </div>
            <div className="space-y-0.5">
              {tomorrow.map((item, i) => <ItemRow key={i} item={item} />)}
            </div>
          </div>
        )}

        {/* General */}
        {general.length > 0 && (
          <div>
            <div className="flex items-center gap-1.5 mb-1.5">
              <span className="text-xs font-medium text-muted-foreground uppercase">General</span>
            </div>
            <div className="space-y-0.5">
              {general.filter(i => !i.done).slice(0, 10).map((item, i) => <ItemRow key={i} item={item} />)}
              {general.filter(i => !i.done).length > 10 && (
                <p className="text-xs text-muted-foreground pt-1">
                  +{general.filter(i => !i.done).length - 10} more
                </p>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
