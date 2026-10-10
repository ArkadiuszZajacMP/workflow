import { z } from 'zod';

export const RULE_CATEGORIES = ['triage', 'in_progress', 'verification', 'done'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

const slackWhen = z.strictObject({ source: z.literal('slack'), reaction: z.string().min(1) });
const linearStatusWhen = z.strictObject({ source: z.literal('linear'), status: z.string().min(1) });
const linearLabelWhen = z.strictObject({ source: z.literal('linear'), label: z.string().min(1) });

export const ruleSchema = z
  .strictObject({
    when: z.union([slackWhen, linearStatusWhen, linearLabelWhen]),
    category: z.enum(RULE_CATEGORIES),
    action: z.literal('triage-draft').optional(),
  })
  .refine((rule) => rule.action === undefined || rule.when.source === 'slack', {
    message: 'action "triage-draft" is only allowed on slack rules',
  });

export const configSchema = z.strictObject({
  linear: z.strictObject({ defaultTeam: z.string().min(1) }),
  slack: z
    .strictObject({
      pollIntervalSeconds: z.number().int().min(10).default(60),
      backfillOnFirstRun: z.boolean().default(false),
    })
    .prefault({}),
  claude: z.strictObject({ model: z.string().min(1).nullable().default(null) }).prefault({}),
  triage: z
    .strictObject({
      duplicateThreshold: z.number().min(0).max(1).default(0.7),
      searchClosedWithinDays: z.number().int().min(0).default(90),
      maxCandidates: z.number().int().min(1).max(50).default(15),
    })
    .prefault({}),
  rules: z.array(ruleSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;
export type Rule = z.infer<typeof ruleSchema>;
