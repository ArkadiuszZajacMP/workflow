'use client';

import { useState } from 'react';
import { approvePlanAction, editPlanAction, revisePlanAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import type { BreakdownEntry, Plan } from '@/core/db/schema';
import { useActionRunner } from './use-action-runner';

export function PlanEditor({
  itemId,
  plans,
  editable,
  knownRepos,
  posted,
}: {
  itemId: number;
  plans: Plan[];
  editable: boolean;
  knownRepos: string[];
  posted: boolean;
}) {
  const latest = plans.at(-1);
  const [selected, setSelected] = useState<number | null>(null);
  if (!latest) return null;
  const shown = plans.find((p) => p.version === selected) ?? latest;
  const isLatest = shown.version === latest.version;
  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Implementation plan{posted && ' (posted to Linear)'}</h3>
        <select
          aria-label="Plan version"
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={shown.version}
          onChange={(e) => setSelected(Number(e.target.value))}
        >
          {plans.map((p) => (
            <option key={p.id} value={p.version}>
              v{p.version} by {p.author}
            </option>
          ))}
        </select>
      </div>
      {isLatest && editable ? <PlanForm key={latest.id} itemId={itemId} plan={latest} knownRepos={knownRepos} /> : <PlanView plan={shown} />}
    </section>
  );
}

function PlanView({ plan }: { plan: Plan }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="whitespace-pre-wrap">{plan.body}</p>
      <ol className="list-decimal pl-5">
        {plan.breakdown.map((e, i) => (
          <li key={i}>
            <span className="font-mono">{e.repo}</span> — {e.scope}
          </li>
        ))}
      </ol>
      {plan.feedback && <p className="text-muted-foreground">Feedback: {plan.feedback}</p>}
    </div>
  );
}

function PlanForm({ itemId, plan, knownRepos }: { itemId: number; plan: Plan; knownRepos: string[] }) {
  const [body, setBody] = useState(plan.body);
  const [rows, setRows] = useState<BreakdownEntry[]>(plan.breakdown);
  const [feedback, setFeedback] = useState('');
  const { pending, error, run } = useActionRunner();
  const content = { body, breakdown: rows };
  const dirty = body !== plan.body || JSON.stringify(rows) !== JSON.stringify(plan.breakdown);
  const repoOptions = [...new Set([...knownRepos, ...rows.map((r) => r.repo)])].filter(Boolean);
  const setRow = (index: number, patch: Partial<BreakdownEntry>) =>
    setRows((current) => current.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  const moveRow = (index: number, delta: number) =>
    setRows((current) => {
      const next = [...current];
      const target = index + delta;
      if (target < 0 || target >= next.length) return current;
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="plan-body">Plan</Label>
        <Textarea id="plan-body" rows={12} value={body} onChange={(e) => setBody(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>PR breakdown</Label>
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="w-5 text-sm text-muted-foreground">{i + 1}.</span>
            <select
              aria-label={`Repository for PR ${i + 1}`}
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={row.repo}
              onChange={(e) => setRow(i, { repo: e.target.value })}
            >
              <option value="">Choose repo</option>
              {repoOptions.map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </select>
            <Input aria-label={`Scope for PR ${i + 1}`} value={row.scope} onChange={(e) => setRow(i, { scope: e.target.value })} />
            <Button variant="ghost" size="sm" aria-label={`Move PR ${i + 1} up`} onClick={() => moveRow(i, -1)}>
              ↑
            </Button>
            <Button variant="ghost" size="sm" aria-label={`Move PR ${i + 1} down`} onClick={() => moveRow(i, 1)}>
              ↓
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setRows((current) => current.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setRows((current) => [...current, { repo: '', scope: '' }])}>
          Add PR
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            run(async () => {
              if (dirty) {
                const saved = await editPlanAction(itemId, content);
                if (saved.error) return saved;
              }
              return approvePlanAction(itemId);
            })
          }
        >
          Approve plan → post & implement
        </Button>
        <Button variant="outline" disabled={pending || !dirty} onClick={() => run(() => editPlanAction(itemId, content))}>
          Save edits
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="plan-feedback">Revise with feedback</Label>
        <Textarea id="plan-feedback" rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} />
        <Button variant="secondary" size="sm" disabled={pending || !feedback.trim()} onClick={() => run(() => revisePlanAction(itemId, feedback))}>
          Ask Claude to revise
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
