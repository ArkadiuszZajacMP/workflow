import type { AgentJobType } from '@/core/db/schema';
import { AGENT_JOB_TYPES } from '@/core/db/schema';
import { errorMessage, PermanentError } from '@/core/errors';
import { claimNextJob, requestStop } from '@/core/jobs/queue';
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
  private readonly inFlight = new Map<Promise<void>, number>();
  private closed = false;

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
    if (!deps || this.closed) return 0;
    let started = 0;
    while (this.inFlight.size < deps.config.agent.maxConcurrent) {
      try {
        const job = claimNextJob(deps.db, deps.now(), AGENT_JOB_TYPES);
        if (!job) break;
        const handler = this.handlers[job.type as AgentJobType];
        const task: Promise<void> = executeJob(
          deps.db,
          job,
          () => (handler ? handler(deps, job) : Promise.reject(new PermanentError(`No agent handler for ${job.type}`))),
          deps.now,
        )
          .catch((err) => {
            // executeJob swallows bookkeeping errors; if something still escapes, recovery requeues the job on restart.
            console.error(`[worker] agent job #${job.id} escaped its handler: ${errorMessage(err)}`);
          })
          .finally(() => {
            this.inFlight.delete(task);
          });
        this.inFlight.set(task, job.id);
        started++;
      } catch (err) {
        console.error(`[worker] could not claim an agent job: ${errorMessage(err)}`);
        break;
      }
    }
    return started;
  }

  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.keys()]);
  }

  /** Asks every in-flight run to stop through the normal stop mechanism (the run aborts and kills claude in the container). */
  stopAll(): void {
    const deps = this.deps();
    if (!deps) return;
    for (const jobId of this.inFlight.values()) {
      try {
        requestStop(deps.db, jobId);
      } catch (err) {
        console.error(`[worker] could not request stop for job #${jobId}: ${errorMessage(err)}`);
      }
    }
  }

  /** Stops claiming, asks in-flight runs to stop and waits up to `timeoutMs` for them to finish. */
  async shutdown(timeoutMs: number): Promise<{ timedOut: boolean }> {
    this.closed = true;
    this.stopAll();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    const result = await Promise.race([this.drain().then(() => 'drained' as const), timeout]);
    clearTimeout(timer);
    return { timedOut: result === 'timeout' };
  }
}
