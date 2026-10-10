import { MessageSquare, SquareKanban } from 'lucide-react';
import Link from 'next/link';
import type { Item } from '@/core/db/schema';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { displayTitle, formatAge, TRIAGE_STATE_LABELS } from '@/lib/format';

export function ItemCard({ item, href, now }: { item: Item; href: string; now: number }) {
  return (
    <Link href={href} scroll={false} className="block">
      <Card className="transition-colors hover:bg-muted/50">
        <CardContent className="space-y-2 p-3">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            {item.slackThreadTs ? (
              <span>
                <MessageSquare className="size-3.5" aria-hidden />
                <span className="sr-only">Slack</span>
              </span>
            ) : (
              <span>
                <SquareKanban className="size-3.5" aria-hidden />
                <span className="sr-only">Linear</span>
              </span>
            )}
            {item.linearIdentifier && <span className="font-mono">{item.linearIdentifier}</span>}
            <span className="ml-auto">{formatAge(item.createdAt, now)}</span>
          </div>
          <p className="line-clamp-2 text-sm font-medium">{displayTitle(item)}</p>
          {item.triageState && (
            <Badge variant={item.triageState === 'failed' ? 'destructive' : 'secondary'}>
              {TRIAGE_STATE_LABELS[item.triageState]}
            </Badge>
          )}
        </CardContent>
      </Card>
    </Link>
  );
}
