import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc, Id } from "./_generated/dataModel";
import {
  appendAttempt,
  boundError,
  boundProgress,
  canTransition,
  DEFAULT_MAX_ATTEMPTS,
  isClaimable,
  isJobType,
  refusalFor,
  type JobStatus,
} from "./lib/jobs";

/**
 * Durable job state.
 *
 * Every operation here is a mutation even when it reads like a write of
 * one field, because every one of them is a read-then-write that must be
 * atomic. `claimJob` is the clearest case: it reads a status, decides,
 * and writes — and if two invocations interleave between the read and
 * the write, the same work runs twice. Convex mutations are serializable
 * transactions, so doing the whole read-decide-write inside one mutation
 * is what makes the claim safe. Splitting it into a query followed by a
 * mutation would silently reintroduce the race.
 *
 * Nothing here schedules anything. The scheduler is the execution
 * mechanism; these functions only record what state execution is in.
 */

/** Every mutation returns the row it acted on, so callers never re-read. */
type JobRow = Doc<"jobs">;

/**
 * Create a job, or return the one that already owns this logical work.
 *
 * `created` is the signal a caller acts on: schedule execution when it
 * is true, and do nothing when it is false because someone already has.
 * That is the whole of duplicate-suppression, and it is why this returns
 * the existing row rather than throwing — a duplicate is a normal event,
 * not an error.
 *
 * A terminal existing job is returned as-is rather than revived.
 * "A completed job cannot accidentally become pending again" is an
 * invariant, so re-running finished work has to be an explicit new job
 * with a new key, never a side effect of asking for the old one.
 */
export const createJob = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    type: v.string(),
    idempotencyKey: v.string(),
    maxAttempts: v.optional(v.number()),
    scheduledAt: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<{ job: JobRow; created: boolean }> => {
    if (!isJobType(args.type)) {
      throw new Error(`Unknown job type: ${args.type}`);
    }
    // Belt and braces on the tenant: a job for a tenant that does not
    // exist is unreachable work that nothing will ever clean up.
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) throw new Error("Unknown tenant");

    // Read-then-insert inside one mutation. Two concurrent creates with
    // the same key both read this index; Convex's serializable isolation
    // means the second commit is retried against the first's write and
    // finds the row. Uniqueness rests on that, not on a unique
    // constraint — Convex has none.
    const existing = await ctx.db
      .query("jobs")
      .withIndex("by_tenant_and_idempotency", (q) =>
        q.eq("tenantId", args.tenantId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();

    if (existing) return { job: existing, created: false };

    const now = Date.now();
    const jobId = await ctx.db.insert("jobs", {
      tenantId: args.tenantId,
      type: args.type,
      status: "queued",
      idempotencyKey: args.idempotencyKey,
      attempt: 0,
      maxAttempts: args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      scheduledAt: args.scheduledAt,
      createdAt: now,
      updatedAt: now,
    });

    const job = await ctx.db.get(jobId);
    if (!job) throw new Error("Job vanished immediately after insert");
    return { job, created: true };
  },
});

/**
 * Take ownership of a job for execution.
 *
 * THE CONCURRENCY PRIMITIVE. Only `queued` and `retrying` are claimable;
 * `running` is refused, which is the double-execution guard, and the
 * terminal states are refused because they are over.
 *
 * The read of `status` and the write of `running` happen in one
 * transaction. Two invocations racing for the same job therefore
 * serialize: one commits the transition, the other is re-run against
 * that commit, reads `running`, and refuses. Exactly one caller gets
 * `claimed: true`.
 *
 * A refusal is a normal outcome and is not an error. The second of two
 * concurrent invocations refusing is the system working.
 */
export const claimJob = internalMutation({
  args: { tenantId: v.id("tenants"), jobId: v.id("jobs") },
  handler: async (
    ctx,
    args,
  ): Promise<
    { claimed: true; job: JobRow } | { claimed: false; reason: string; job: JobRow | null }
  > => {
    const job = await ctx.db.get(args.jobId);
    // Cross-tenant access is reported as not-found rather than denied:
    // a caller holding another tenant's id should learn nothing about
    // whether it exists.
    if (!job || job.tenantId !== args.tenantId) {
      return { claimed: false, reason: "not_found", job: null };
    }

    if (!isClaimable(job.status as JobStatus)) {
      return { claimed: false, reason: refusalFor(job.status as JobStatus), job };
    }

    const now = Date.now();
    await ctx.db.patch(args.jobId, {
      status: "running",
      // Incremented on claim, not on failure. A job that died without
      // reporting anything still consumed an attempt, and counting on
      // failure would let a crash loop retry forever.
      attempt: job.attempt + 1,
      startedAt: now,
      updatedAt: now,
    });

    const claimed = await ctx.db.get(args.jobId);
    if (!claimed) throw new Error("Job vanished during claim");
    return { claimed: true, job: claimed };
  },
});

/** Record forward movement. Safe to call repeatedly; never changes status. */
export const updateProgress = internalMutation({
  args: { tenantId: v.id("tenants"), jobId: v.id("jobs"), progress: v.any() },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.tenantId !== args.tenantId) return false;
    // Progress on a finished job is meaningless and would be the only
    // way to write to a terminal row.
    if (job.status !== "running") return false;

    await ctx.db.patch(args.jobId, {
      progress: boundProgress(args.progress),
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * One transition helper behind every terminal operation.
 *
 * Written once rather than four times because the validation is the
 * point: a transition that is not in the matrix must be refused, and
 * four copies is four chances for one of them to skip the check.
 */
async function transition(
  ctx: { db: { get: (id: Id<"jobs">) => Promise<JobRow | null>; patch: (id: Id<"jobs">, p: Partial<JobRow>) => Promise<void> } },
  tenantId: Id<"tenants">,
  jobId: Id<"jobs">,
  to: JobStatus,
  extra: Partial<JobRow> = {},
): Promise<{ ok: true; job: JobRow } | { ok: false; reason: string }> {
  const job = await ctx.db.get(jobId);
  if (!job || job.tenantId !== tenantId) return { ok: false, reason: "not_found" };

  if (!canTransition(job.status as JobStatus, to)) {
    return {
      ok: false,
      reason: `illegal_transition:${job.status}->${to}`,
    };
  }

  await ctx.db.patch(jobId, { ...extra, status: to, updatedAt: Date.now() });
  const updated = await ctx.db.get(jobId);
  if (!updated) return { ok: false, reason: "not_found" };
  return { ok: true, job: updated };
}

export const succeedJob = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    jobId: v.id("jobs"),
    progress: v.optional(v.any()),
  },
  handler: async (ctx, args) =>
    transition(ctx, args.tenantId, args.jobId, "succeeded", {
      completedAt: Date.now(),
      ...(args.progress !== undefined
        ? { progress: boundProgress(args.progress) }
        : {}),
    }),
});

/**
 * Terminal failure.
 *
 * Distinct from `retryJob`: this is "give up", and it is where
 * `lastError` earns its place. A failed job with no recorded reason is
 * indistinguishable from one that was never run, which is precisely the
 * ambiguity the audit found.
 */
export const failJob = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    jobId: v.id("jobs"),
    error: v.string(),
    /** Classification from lib/retry.ts. Omitted only by direct callers. */
    errorClass: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.jobId);
    const now = Date.now();
    return transition(ctx, args.tenantId, args.jobId, "failed", {
      completedAt: now,
      failedAt: now,
      lastError: boundError(args.error),
      ...(args.errorClass ? { errorClass: args.errorClass } : {}),
      retryable: false,
      attempts: appendAttempt(existing?.attempts, {
        attempt: existing?.attempt ?? 0,
        at: now,
        errorClass: args.errorClass ?? "unknown",
        message: boundError(args.error),
        retryable: false,
      }),
    });
  },
});

/**
 * Mark a job as awaiting another attempt.
 *
 * This records the *state*. It does not decide whether to try again or
 * how long to wait — `decideRetry` in `lib/retry.ts` owns that, and
 * `reportJobFailure` in `scheduling.ts` applies it. Keeping the decision
 * out of here is what lets the transition matrix stay a statement about
 * legality rather than about policy.
 *
 * A job in `retrying` keeps its identity, its idempotency key and its
 * attempt count. That is the whole reason `retrying` is claimable: a
 * retry is a second attempt of the same job, not a second job.
 */
export const retryJob = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    jobId: v.id("jobs"),
    error: v.string(),
    nextAttemptAt: v.optional(v.number()),
    errorClass: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db.get(args.jobId);
    const now = Date.now();
    return transition(ctx, args.tenantId, args.jobId, "retrying", {
      lastError: boundError(args.error),
      nextAttemptAt: args.nextAttemptAt,
      failedAt: now,
      ...(args.errorClass ? { errorClass: args.errorClass } : {}),
      retryable: true,
      attempts: appendAttempt(existing?.attempts, {
        attempt: existing?.attempt ?? 0,
        at: now,
        errorClass: args.errorClass ?? "unknown",
        message: boundError(args.error),
        retryable: true,
      }),
    });
  },
});

export const cancelJob = internalMutation({
  args: { tenantId: v.id("tenants"), jobId: v.id("jobs"), reason: v.optional(v.string()) },
  handler: async (ctx, args) =>
    transition(ctx, args.tenantId, args.jobId, "cancelled", {
      completedAt: Date.now(),
      ...(args.reason ? { lastError: boundError(args.reason) } : {}),
    }),
});

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

export const getJob = internalQuery({
  args: { tenantId: v.id("tenants"), jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<JobRow | null> => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.tenantId !== args.tenantId) return null;
    return job;
  },
});

/** Resolve a logical piece of work to its job, if one exists. */
export const getJobByKey = internalQuery({
  args: { tenantId: v.id("tenants"), idempotencyKey: v.string() },
  handler: async (ctx, args): Promise<JobRow | null> =>
    await ctx.db
      .query("jobs")
      .withIndex("by_tenant_and_idempotency", (q) =>
        q.eq("tenantId", args.tenantId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique(),
});

/**
 * Operator visibility: what is in flight, and what stopped.
 *
 * The question the audit could not answer — "is tenant X's enrichment
 * stuck?" — is this query.
 */
export const listJobs = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    status: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<JobRow[]> => {
    const limit = Math.min(args.limit ?? 100, 500);
    if (args.status) {
      return await ctx.db
        .query("jobs")
        .withIndex("by_tenant_and_status", (q) =>
          q.eq("tenantId", args.tenantId).eq("status", args.status as JobStatus),
        )
        .take(limit);
    }
    return await ctx.db
      .query("jobs")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .take(limit);
  },
});

/**
 * Jobs that claimed a slot and never reported back.
 *
 * A `running` row older than any plausible execution is the signature of
 * an action that died — the exact state that was previously invisible.
 *
 * This still only *reports*. The policy that acts on it is
 * `recoverStuckJobs` in `crons.ts`, which hands each stale job to
 * `reportJobFailure` rather than re-running it: a sweeper that executed
 * work directly would race the scheduler for the same job, which is the
 * design this table exists to avoid.
 */
export const stuckJobs = internalQuery({
  args: { runningSince: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, args): Promise<JobRow[]> => {
    const running = await ctx.db
      .query("jobs")
      .withIndex("by_status", (q) => q.eq("status", "running"))
      .take(Math.min(args.limit ?? 100, 500));
    return running.filter((job) => (job.startedAt ?? job.updatedAt) < args.runningSince);
  },
});
