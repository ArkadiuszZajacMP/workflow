import type { AgentJobType } from '@/core/db/schema';
import { AGENT_JOB_TYPES } from '@/core/db/schema';
import { PermanentError } from '@/core/errors';
import { claimNextJob } from '@/core/jobs/queue';
import { executeJob } from '../execute';
import type { AgentDeps, AgentHandler } from './deps';
import { fixPrHandler } from './handlers/fix-pr';
import { implementPrHandler } from './handlers/implement-pr';
import { investigateHandler } from './handlers/investigate';
import { removeWorkspaceHandler } from './workspace';

export const AGENT_HANDLERS: Record<AgentJobType, AgentHandler> = {
  investigate: investigateHandler,
  'implement-pr': implementPrHandler,
  'fix-pr': fixPrHandler,
  'remove-workspace': removeWorkspaceHandler,
};

/** Runs long agent jobs concurrently with the core lane, up to `agent.maxConcurrent` at a time. */
export class AgentLane {
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly deps: () => AgentDeps | null,
    private readonly handlers: Record<AgentJobType, AgentHandler> = AGENT_HANDLERS,
  ) {}

  get size(): number {
    return this.inFlight.size;
  }

  /** Claims and starts agent jobs until the lane is full. Returns how many were started. */
  fill(): number {
    const deps = this.deps();
    if (!deps) return 0;
    let started = 0;
    while (this.inFlight.size < deps.config.agent.maxConcurrent) {
      const job = claimNextJob(deps.db, deps.now(), AGENT_JOB_TYPES);
      if (!job) break;
      const handler = this.handlers[job.type as AgentJobType];
      const task: Promise<void> = executeJob(
        deps.db,
        job,
        () => (handler ? handler(deps, job) : Promise.reject(new PermanentError(`No agent handler for ${job.type}`))),
        deps.now,
      ).finally(() => {
        this.inFlight.delete(task);
      });
      this.inFlight.add(task);
      started++;
    }
    return started;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight]);
  }
}
