import { z } from 'zod';

export const RULE_CATEGORIES = ['triage', 'in_progress', 'verification', 'done'] as const;
export type RuleCategory = (typeof RULE_CATEGORIES)[number];

const slackWhen = z.strictObject({ source: z.literal('slack'), reaction: z.string().min(1) });
const linearStatusWhen = z.strictObject({ source: z.literal('linear'), status: z.string().min(1) });
const linearLabelWhen = z.strictObject({ source: z.literal('linear'), label: z.string().min(1) });

export const RULE_ACTIONS = ['triage-draft', 'start-investigation'] as const;
export type RuleAction = (typeof RULE_ACTIONS)[number];

export const ruleSchema = z
  .strictObject({
    when: z.union([slackWhen, linearStatusWhen, linearLabelWhen]),
    category: z.enum(RULE_CATEGORIES),
    action: z.enum(RULE_ACTIONS).optional(),
  })
  .refine((rule) => rule.action !== 'triage-draft' || rule.when.source === 'slack', {
    message: 'action "triage-draft" is only allowed on slack rules',
  })
  .refine((rule) => rule.action !== 'start-investigation' || rule.when.source === 'linear', {
    message: 'action "start-investigation" is only allowed on linear rules',
  });

const agentSchema = z.strictObject({
  containerEngine: z.string().min(1).default('podman'),
  image: z.string().min(1).default('workflow-agent:latest'),
  maxConcurrent: z.number().int().min(1).max(4).default(1),
  timeoutMinutes: z
    .strictObject({
      investigate: z.number().int().min(1).default(20),
      implement: z.number().int().min(1).default(60),
    })
    .prefault({}),
  maxTurns: z
    .strictObject({
      investigate: z.number().int().min(1).default(60),
      implement: z.number().int().min(1).default(200),
    })
    .prefault({}),
  prPollSeconds: z.number().int().min(30).default(120),
  workspaceRetentionDays: z.number().int().min(0).default(7),
  meetingpackageSkillDir: z.string().min(1).default('~/.claude/skills/meetingpackage'),
  dockerSkillDir: z.string().min(1).default('~/.claude/skills/docker'),
  githubSkillDir: z.string().min(1).default('~/.claude/skills/github'),
  syncEnv: z.boolean().default(true),
  envName: z.enum(['development', 'staging']).default('development'),
  defaultRepos: z.array(z.string().min(1)).default([]),
  linearStatusOnImplement: z.string().min(1).nullable().default(null),
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
  agent: agentSchema.prefault({}),
  rules: z.array(ruleSchema).default([]),
});

export type Config = z.infer<typeof configSchema>;
export type AgentConfig = Config['agent'];
export type Rule = z.infer<typeof ruleSchema>;
