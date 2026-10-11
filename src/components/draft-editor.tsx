'use client';

import { useState } from 'react';
import { approveAction, editDraftAction, reviseAction } from '@/app/actions';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { Draft } from '@/core/db/schema';
import { useActionRunner } from './use-action-runner';

export function DraftEditor({ itemId, drafts, editable }: { itemId: number; drafts: Draft[]; editable: boolean }) {
  const latest = drafts.at(-1);
  const [selected, setSelected] = useState<number | null>(null);
  if (!latest) return null;
  const shown = drafts.find((d) => d.version === selected) ?? latest;
  const isLatest = shown.version === latest.version;
  const versionItems = drafts.map((d) => ({ value: String(d.version), label: `v${d.version} by ${d.author}` }));

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Draft issue</h3>
        <Select
          value={String(shown.version)}
          items={versionItems}
          onValueChange={(v) => {
            if (v !== null) setSelected(Number(v));
          }}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {versionItems.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {isLatest && editable ? <DraftForm key={latest.id} itemId={itemId} draft={latest} /> : <DraftView draft={shown} />}
    </section>
  );
}

function DraftView({ draft }: { draft: Draft }) {
  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">{draft.title}</p>
      <p className="whitespace-pre-wrap">{draft.problem}</p>
      <ul className="list-disc pl-5">
        {draft.acceptanceCriteria.map((c, i) => (
          <li key={i}>{c}</li>
        ))}
      </ul>
      {draft.feedback && <p className="text-muted-foreground">Feedback: {draft.feedback}</p>}
    </div>
  );
}

function DraftForm({ itemId, draft }: { itemId: number; draft: Draft }) {
  const [title, setTitle] = useState(draft.title);
  const [problem, setProblem] = useState(draft.problem);
  const [criteria, setCriteria] = useState<string[]>(draft.acceptanceCriteria);
  const [feedback, setFeedback] = useState('');
  const { pending, error, run } = useActionRunner();

  const content = { title, problem, acceptanceCriteria: criteria };
  const dirty =
    title !== draft.title || problem !== draft.problem || JSON.stringify(criteria) !== JSON.stringify(draft.acceptanceCriteria);
  const setCriterion = (index: number, value: string) => setCriteria((cs) => cs.map((c, i) => (i === index ? value : c)));

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Label htmlFor="draft-title">Title</Label>
        <Input id="draft-title" value={title} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="space-y-1">
        <Label htmlFor="draft-problem">Problem</Label>
        <Textarea id="draft-problem" rows={8} value={problem} onChange={(e) => setProblem(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label>Acceptance criteria</Label>
        {criteria.map((c, i) => (
          <div key={i} className="flex gap-2">
            <Input aria-label={`Criterion ${i + 1}`} value={c} onChange={(e) => setCriterion(i, e.target.value)} />
            <Button variant="ghost" size="sm" onClick={() => setCriteria((cs) => cs.filter((_, j) => j !== i))}>
              Remove
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setCriteria((cs) => [...cs, ''])}>
          Add criterion
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={pending}
          onClick={() =>
            run(async () => {
              if (dirty) {
                const saved = await editDraftAction(itemId, content);
                if (saved.error) return saved;
              }
              return approveAction(itemId);
            })
          }
        >
          Approve → create in Linear
        </Button>
        <Button variant="outline" disabled={pending || !dirty} onClick={() => run(() => editDraftAction(itemId, content))}>
          Save edits
        </Button>
      </div>
      <div className="space-y-2">
        <Label htmlFor="draft-feedback">Revise with feedback</Label>
        <Textarea
          id="draft-feedback"
          rows={2}
          placeholder="e.g. focus on the mobile case"
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
        />
        <Button variant="secondary" size="sm" disabled={pending || !feedback.trim()} onClick={() => run(() => reviseAction(itemId, feedback))}>
          Ask Claude to revise
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
