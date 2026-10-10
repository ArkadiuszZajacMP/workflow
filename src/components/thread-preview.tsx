import type { Item } from '@/core/db/schema';

export function ThreadPreview({ item }: { item: Item }) {
  if (!item.slackThreadTs) return null;
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Slack thread</h3>
        {item.slackPermalink && (
          <a className="text-sm underline-offset-4 hover:underline" href={item.slackPermalink} target="_blank" rel="noreferrer">
            Open in Slack
          </a>
        )}
      </div>
      {item.slackThread?.length ? (
        <ul className="max-h-64 space-y-2 overflow-y-auto rounded-md border p-3 text-sm">
          {item.slackThread.map((m) => (
            <li key={m.ts}>
              <span className="font-medium">{m.userName}</span>{' '}
              <span className="whitespace-pre-wrap">{m.text}</span>
              {m.files.length > 0 && <span className="text-muted-foreground"> ({m.files.join(', ')})</span>}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">Thread not fetched yet.</p>
      )}
    </section>
  );
}
