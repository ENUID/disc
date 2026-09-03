import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { classifyFailure } from "./lib/retry";

/**
 * The job executor (P1.3).
 *
 * One wrapper, used by every worker that runs as a durable job:
 *
 *   claim  ->  run  ->  succeeded
 *                  \->  classify -> reportJobFailure -> retrying | failed
 *
 * WHY THIS IS A WRAPPER AND NOT A PATTERN WORKERS COPY. Retry policy is
 * centralised in the executor, and a policy that has to be re-implemented
 * at each worker is not centralised — it is duplicated with a comment
 * saying it isn't. Everything a worker has to get right to participate in
 * retry (claiming before running, classifying rather than swallowing,
 * reporting exactly once) is here, so a new worker gets it by calling
 * this rather than by remembering it.
 *
 * WHY THE CLAIM IS HERE RATHER THAN IN THE SCHEDULER. Convex's scheduler
 * guarantees a function is scheduled, not that it runs once — and the
 * stale-job sweeper can legitimately schedule a second attempt for work
 * whose first attempt is not provably dead. The claim is what makes that
 * safe: only `queued` and `retrying` are claimable, so a second execution
 * arriving while the first still holds the job is refused and returns
 * without doing anything.
 *
 * WHY CLASSIFICATION HAPPENS HERE AND THE DECISION DOES NOT. An error
 * loses its prototype when it crosses a Convex action boundary, so it has
 * to be classified in the action that caught it. The decision needs
 * `attempt` and `maxAttempts` off the row, so it belongs in a mutation.
 * `reportJobFailure` takes the class this produces and makes the call.
 */

/** The subset of an action ctx this needs. Keeps the workers' types honest. */
type RunnerCtx = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  runMutation: (fn: any, args: any) => Promise<any>;
};

export type JobOutcome<T> =
  | { ran: true; result: T }
  | { ran: false; reason: string };

/**
 * Run `work` as an attempt of a durable job.
 *
 * `jobId` is optional, and that is deliberate rather than a loose end: a
 * worker can still be invoked directly — by a test, by an operator, by a
 * future caller that has no job — and when it is, it behaves exactly as
 * it did before this phase. There is no second code path inside the
 * worker for the two cases, which is what keeps the untracked invocation
 * from quietly diverging from the tracked one.
 *
 * Errors are NOT rethrown after being reported. The job row is the record
 * of the failure, and rethrowing would additionally fail the scheduled
 * function, producing a second, unclassified account of the same event in
 * the platform's logs and — for a retryable class — inviting the platform
 * to re-run a job this executor has already scheduled a retry for.
 */
export async function runAsJob<T>(
  ctx: RunnerCtx,
  args: { tenantId: Id<"tenants">; jobId?: Id<"jobs"> },
  work: () => Promise<T>,
): Promise<JobOutcome<T>> {
  if (!args.jobId) {
    // Untracked invocation. No claim, no retry, no job row to report to —
    // the error propagates to the caller exactly as it always did.
    return { ran: true, result: await work() };
  }

  const claim = await ctx.runMutation(internal.jobs.claimJob, {
    tenantId: args.tenantId,
    jobId: args.jobId,
  });

  // A refusal is a normal outcome. Another execution holds this job, or
  // it is already over. Either way this invocation must do nothing —
  // that refusal IS the double-execution guard.
  if (!claim.claimed) return { ran: false, reason: claim.reason };

  try {
    const result = await work();
    await ctx.runMutation(internal.jobs.succeedJob, {
      tenantId: args.tenantId,
      jobId: args.jobId,
    });
    return { ran: true, result };
  } catch (error) {
    const classified = classifyFailure(error);
    await ctx.runMutation(internal.scheduling.reportJobFailure, {
      tenantId: args.tenantId,
      jobId: args.jobId,
      errorClass: classified.class,
      message: classified.message,
    });
    return { ran: false, reason: classified.class };
  }
}
