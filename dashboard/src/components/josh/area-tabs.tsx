'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  IconHeartbeat,
  IconWallet,
  IconTrendingUp,
  IconTent,
  IconShieldLock,
  IconBrain,
} from '@tabler/icons-react';
import type { AreaInfo } from '@/lib/vault';

const AREA_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
  'heart-pulse': IconHeartbeat,
  wallet: IconWallet,
  'trending-up': IconTrendingUp,
  tent: IconTent,
  'shield-lock': IconShieldLock,
  brain: IconBrain,
};

const STALENESS_COLORS: Record<string, string> = {
  fresh: 'bg-green-500/10 text-green-600 dark:text-green-400',
  recent: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  aging: 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  stale: 'bg-orange-500/10 text-orange-600 dark:text-orange-400',
  neglected: 'bg-red-500/10 text-red-600 dark:text-red-400',
  unknown: 'bg-muted text-muted-foreground',
};

interface AreaTabsProps {
  areas: AreaInfo[];
}

export function AreaTabs({ areas }: AreaTabsProps) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      {/* Tab bar */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {areas.map((area) => {
          const Icon = AREA_ICONS[area.icon] ?? IconBrain;
          const active = selected === area.id;
          return (
            <button
              key={area.id}
              onClick={() => setSelected(active ? null : area.id)}
              className={cn(
                'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap transition-all',
                active
                  ? 'border-primary bg-primary/5 text-primary'
                  : 'border-border bg-card hover:bg-muted/50 text-muted-foreground hover:text-foreground'
              )}
            >
              <Icon size={16} />
              <span>{area.name}</span>
              {area.staleness !== 'fresh' && area.staleness !== 'unknown' && (
                <Badge variant="secondary" className={cn('text-[10px] px-1.5', STALENESS_COLORS[area.staleness])}>
                  {area.daysSinceTouch}d
                </Badge>
              )}
            </button>
          );
        })}
      </div>

      {/* Selected area detail */}
      {selected && (() => {
        const area = areas.find(a => a.id === selected);
        if (!area) return null;
        return (
          <div className="rounded-lg border bg-card p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-medium">{area.name}</h3>
              <span className={cn('rounded-md px-2 py-0.5 text-xs font-medium', STALENESS_COLORS[area.staleness])}>
                {area.staleness === 'unknown' ? 'No data' : `${area.staleness} (${area.daysSinceTouch}d)`}
              </span>
            </div>
            {area.summary && (
              <p className="text-sm text-muted-foreground">{area.summary}</p>
            )}
            {!area.summary && (
              <p className="text-sm text-muted-foreground italic">No summary available</p>
            )}
          </div>
        );
      })()}
    </div>
  );
}
