import Link from 'next/link';
import { getOrgs } from '@/lib/config';
import { getTasks, getTasksCompletedToday } from '@/lib/data/tasks';
import { getHealthSummary } from '@/lib/data/heartbeats';
import { IconUser, IconCpu } from '@tabler/icons-react';

export const dynamic = 'force-dynamic';

export default async function LandingPage() {
  const orgs = getOrgs();
  const org = orgs[0] || '';

  const [healthSummary, allTasks, completedToday] = await Promise.all([
    getHealthSummary(org || undefined),
    Promise.resolve(getTasks({ org: org || undefined })),
    Promise.resolve(getTasksCompletedToday(org || undefined)),
  ]);

  const agentsOnline = healthSummary.healthy;
  const agentsTotal = healthSummary.healthy + healthSummary.stale + healthSummary.down;
  const inProgressTasks = allTasks.filter(t => t.status === 'in_progress').length;
  const pendingTasks = allTasks.filter(t => t.status === 'pending').length;

  return (
    <div className="flex flex-1 items-center justify-center min-h-[70vh]">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 max-w-3xl w-full px-4">
        {/* Josh Command Center */}
        <Link
          href="/josh"
          className="group relative flex flex-col rounded-xl border bg-card p-6 shadow-sm hover:shadow-md hover:border-primary/50 transition-all"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-blue-500/10 text-blue-600 dark:text-blue-400">
              <IconUser size={22} />
            </div>
            <h2 className="text-lg font-semibold">Josh Command Center</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Your projects, areas, and action items from SecondBrain.
          </p>
          <div className="mt-auto text-xs text-muted-foreground">
            Projects &middot; Areas &middot; Action Items
          </div>
        </Link>

        {/* cortex System View */}
        <Link
          href="/system"
          className="group relative flex flex-col rounded-xl border bg-card p-6 shadow-sm hover:shadow-md hover:border-primary/50 transition-all"
        >
          <div className="flex items-center gap-3 mb-4">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <IconCpu size={22} />
            </div>
            <h2 className="text-lg font-semibold">cortex System View</h2>
          </div>
          <p className="text-sm text-muted-foreground mb-4">
            Agents, tasks, fleet health, and system operations.
          </p>
          <div className="mt-auto flex items-center gap-3 text-xs text-muted-foreground">
            <span>{agentsOnline}/{agentsTotal} agents online</span>
            <span>&middot;</span>
            <span>{inProgressTasks} in progress</span>
            <span>&middot;</span>
            <span>{completedToday.length} done today</span>
          </div>
        </Link>
      </div>
    </div>
  );
}
