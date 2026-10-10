import type { Activity } from '@/core/db/schema';

export function ActivityList({ activity }: { activity: Activity[] }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">Activity</h3>
      <ol className="space-y-1 text-sm">
        {activity.map((a) => (
          <li key={a.id} className="flex gap-3">
            <time className="shrink-0 text-muted-foreground">{new Date(a.createdAt).toLocaleString()}</time>
            <span>{a.message}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
