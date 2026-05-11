import { getProjects, getActionItems, getAreas } from '@/lib/vault';
import { AreaTabs } from '@/components/josh/area-tabs';
import { ActionItemsPanel } from '@/components/josh/action-items-panel';
import { ProjectList } from '@/components/josh/project-list';

export const dynamic = 'force-dynamic';

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function JoshCommandCenter() {
  const [projects, actionItems, areas] = await Promise.all([
    Promise.resolve(getProjects()),
    Promise.resolve(getActionItems()),
    Promise.resolve(getAreas()),
  ]);

  const activeProjects = projects.filter(p => p.priority === 'active');
  const totalPending = actionItems.timeSensitive.filter(i => !i.done).length
    + actionItems.tomorrow.filter(i => !i.done).length
    + actionItems.general.filter(i => !i.done).length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{getGreeting()}, Josh</h1>
        <p className="text-sm text-muted-foreground">
          {activeProjects.length} active project{activeProjects.length !== 1 ? 's' : ''} &middot; {totalPending} action item{totalPending !== 1 ? 's' : ''} pending
        </p>
      </div>

      {/* Area Tabs + Projects */}
      <AreaTabs areas={areas} />

      {/* Two-column layout: Projects + Action Items */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          <ProjectList projects={projects} />
        </div>
        <div>
          <ActionItemsPanel actionItems={actionItems} />
        </div>
      </div>
    </div>
  );
}
