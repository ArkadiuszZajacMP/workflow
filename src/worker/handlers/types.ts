import type { ClaudeClient, LinearClient, SlackClient } from '@/core/clients/types';
import type { Config } from '@/core/config/schema';
import type { Db } from '@/core/db/client';
import type { Job } from '@/core/db/schema';

export type HandlerContext = {
  db: Db;
  config: Config;
  slack: SlackClient;
  linear: LinearClient;
  claude: ClaudeClient;
  now: () => number;
};

export type Handler = (ctx: HandlerContext, job: Job) => Promise<void>;
