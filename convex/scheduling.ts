import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  appendAttempt,
  boundError,
  DEFAULT_MAX_ATTEMPTS,
  idempotencyKey,
  isJobType,
  manualRetryKey,
  type JobType,
} from "./lib/jobs";
import {
  decideRetry,
  isFailureClass,
  isRetryableClass,
  type FailureClass,
} from "./lib/retry";

/**
 * Idempotent scheduling (P1.2).
 *
 * The seam between "this logical work should happen" and "an execution
 * of it is scheduled". Everything durable goes through `enqueue`, and
 * `enqueue` is the only place in the codebase that schedules durable
 * business work.
 *
 * THE ONE STRUCTURAL DECISION: the dedupe and the scheduling happen in
 * the SAME MUTATION.
 *
 *   createJob (mutation, commits)
 *      ... caller dies here ...
 *   scheduler.runAfter (never happens)
 *
 * would leave a `queued` job that nothing will ever run — a row that
 * looks like pending work and is actually an orphan, and which the next
 * enqueue would then deduplicate against. Convex schedules from inside
 * a mutation transactionally: if the mutation commits, the function is
 * scheduled; if it aborts, neither the row nor the schedule exists.
 * Doing both here is what makes "created implies scheduled" true rather
 * than probable.
 *
 * It is also what satisfies "the dedupe decision must occur BEFORE
 * scheduling" in the strongest available sense: not merely earlier in
 * program order, but in the same transaction, so there is no window in
 * which a second caller can observe the gap.
 *
 * P1.3 added the other half. `enqueue` schedules first attempts;
 * `reportJobFailure` schedules retries of the same job, under the same
 * id and the same key. Both live here because both must schedule inside
 * the transaction that decided to — a job moved to `retrying` with
 * nothing coming looks exactly like one about to run, and never will.
 *
 * The POLICY those decisions read — what is retryable, how long to wait
 * — is in `lib/retry.ts`, and nothing outside this module applies it.
 */

/** Result of an enqueue. `created` is the signal a caller acts on. */
type EnqueueResult = {
  jobId: Id<"jobs">;
  created: boolean;
  status: Doc<"jobs">["status"];
};

/**
 * How long two catalog syncs are considered the same piece of work.
 *
 * A full catalog sync has no natural version to key on — the "logical
 * input" is just the tenant, and the same tenant is legitimately synced
 * again six hours later. So the key carries a coarse time bucket, and
 * this is its width.
 *
 * Five minutes collapses a merchant clicking Resync four times (which
 * the rate limit permits) into one job, and leaves the six-hourly cron
 * unaffected. The cost is that a genuinely-wanted resync inside the
 * window is suppressed; that is acceptable because the work is
 * idempotent in effect — the catalog is re-read from the same source and
 * lands in the same place — so suppressing it loses nothing but a
 * duplicate read.
 *
 * The boundary is a heuristic: two triggers a second apart can straddle
 * a bucket edge and produce two jobs. The guarantee that matters —
 * no *concurrent* duplicate — does not rest on this, it rests on the
 * claim in P1.1.
 */
const CATALOG_SYNC_DEDUPE_MS = 5 * 60 * 1000;

/**
 * Keys for the operations migrated in this phase.
 *
 * Key construction is where the "same logical work" judgement lives, so
 * it is centralised rather than left to call sites. Each key answers one
 * question: what makes two invocations the same?
 */
export function catalogSyncKey(tenantId: Id<"tenants">, at: number = Date.now()): string {
  // Same tenant, same five-minute window. See CATALOG_SYNC_DEDUPE_MS.
  return idempotencyKey("catalog_sync", [
    tenantId,
    Math.floor(at / CATALOG_SYNC_DEDUPE_MS),
  ]);
}

/**
 * One product's re-ingestion.
 *
 * Keyed on the tenant, the product, and a caller-supplied discriminator
 * — today the Shopify `updated_at`, which changes when and only when the
 * product does. Two deliveries of one webhook carry the same value and
 * collapse to one job; a later genuine edit carries a new one and gets
 * its own.
 *
 * P1.4 will replace the discriminator with the Shopify event id, which
 * is a stronger answer to the same question: it makes two deliveries of
 * one event identical even if the product changed again in between.
 */
export function productSyncKey(
  tenantId: Id<"tenants">,
  shopifyProductId: string,
  discriminator: string,
): string {
  return idempotencyKey("product_embedding", [
    tenantId,
    shopifyProductId,
    discriminator,
  ]);
}

/**
 * Create-or-get, then schedule if and only if this call created it.
 *
 * Returns `created: false` for work that already exists in ANY state:
 *
 *   queued / running / retrying  — an execution is already accounted for
 *   succeeded / failed / cancelled — this logical work is over
 *
 * Neither schedules. The first because something else owns it; the
 * second because re-running finished work must be an explicit new job
 * with a new key, never a side effect of asking for the old one.
 *
 * That last case is what makes a redelivered webhook a no-op rather than
 * a re-embed.
 */
export const enqueue = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    type: v.string(),
    idempotencyKey: v.string(),
    /** Worker arguments. Passed to the scheduler and stored on the row. */
    shopifyProductId: v.optional(v.string()),
    delayMs: v.optional(v.number()),
    maxAttempts: v.optional(v.number()),
    /** Set only by a manual retry: the failed job this one re-runs. */
    supersedes: v.optional(v.id("jobs")),
  },
  handler: async (ctx, args): Promise<EnqueueResult> => {
    if (!isJobType(args.type)) throw new Error(`Unknown job type: ${args.type}`);

    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) throw new Error("Unknown tenant");

    // Read-then-insert in this transaction. Two concurrent enqueues with
    // the same key both read this index; Convex's serializable isolation
    // means the second is evaluated against the first's write and finds
    // the row. Exactly one gets `created: true`, so exactly one
    // schedules — which is the invariant this phase exists to establish.
    const existing = await ctx.db
      .query("jobs")
      .withIndex("by_tenant_and_idempotency", (q) =>
        q.eq("tenantId", args.tenantId).eq("idempotencyKey", args.idempotencyKey),
      )
      .unique();

    if (existing) {
      return { jobId: existing._id, created: false, status: existing.status };
    }

    const now = Date.now();
    const delay = Math.max(0, args.delayMs ?? 0);
    const jobId = await ctx.db.insert("jobs", {
      tenantId: args.tenantId,
      type: args.type,
      status: "queued",
      idempotencyKey: args.idempotencyKey,
      attempt: 0,
      maxAttempts: args.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
      // Stored so a retry — automatic or manual — can re-schedule the
      // same worker with the same arguments. The stale-job sweeper in
      // particular has nothing else to reconstruct them from: the action
      // that held them died.
      ...(args.shopifyProductId
        ? { payload: { shopifyProductId: args.shopifyProductId } }
        : {}),
      scheduledAt: now + delay,
      ...(args.supersedes ? { supersedes: args.supersedes } : {}),
      createdAt: now,
      updatedAt: now,
    });

    await scheduleWorker(ctx, args.type, delay, {
      tenantId: args.tenantId,
      jobId,
      shopifyProductId: args.shopifyProductId,
    });

    return { jobId, created: true, status: "queued" };
  },
});

/**
 * Dispatch a job type to the action that performs it.
 *
 * Explicit branches rather than a lookup table: the argument shapes
 * differ per worker, and a table would need a cast that hides exactly
 * the mistake that matters — scheduling a worker with the wrong
 * arguments. The closed `JOB_TYPES` set keeps this bounded, and a new
 * type that reaches here without a branch throws rather than silently
 * creating a job nothing will run.
 *
 * `jobId` is threaded through so a worker can claim its own job, which
 * `runAsJob` does before running anything (P1.3). That claim is what
 * makes a second scheduled execution of the same job safe: it is refused
 * rather than run.
 */
async function scheduleWorker(
  ctx: { scheduler: { runAfter: (ms: number, fn: never, args: never) => Promise<unknown> } },
  type: JobType,
  delayMs: number,
  args: { tenantId: Id<"tenants">; jobId: Id<"jobs">; shopifyProductId?: string },
): Promise<void> {
  const scheduler = ctx.scheduler as unknown as {
    runAfter: (
      ms: number,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fn: any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fnArgs: any,
    ) => Promise<unknown>;
  };

  switch (type) {
    case "catalog_sync":
      await scheduler.runAfter(delayMs, internal.ingest.syncCatalog, {
        tenantId: args.tenantId,
        jobId: args.jobId,
      });
      return;

    case "product_embedding":
      if (!args.shopifyProductId) {
        throw new Error("product_embedding requires a shopifyProductId");
      }
      await scheduler.runAfter(delayMs, internal.ingest.syncSingleProduct, {
        tenantId: args.tenantId,
        shopifyProductId: args.shopifyProductId,
        jobId: args.jobId,
      });
      return;

    // Not scheduled through this seam yet. Listed so that adding one is
    // a deliberate edit here rather than a silent no-op: a job row with
    // no scheduled execution is exactly the orphan this module exists to
    // prevent.
    case "product_enrichment":
    case "brand_brain_build":
    case "look_vision_analysis":
    case "look_graph_rebuild":
    case "analytics_rollup":
    case "data_purge":
      throw new Error(
        `Job type "${type}" is not schedulable through enqueue yet — see PRODUCTION_IDEMPOTENCY.md`,
      );
  }
}

/**
 * Enqueue a full catalog sync for a tenant.
 *
 * The three callers — the resync cron, the OAuth install, and the
 * merchant's Resync button — all route here, which is what closes audit
 * finding P2-1: the merchant path had no concurrency guard at all, so
 * four permitted clicks meant four concurrent full syncs, four times the
 * Shopify reads and four times the embedding spend.
 */
export const enqueueCatalogSync = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    delayMs: v.optional(v.number()),
    /**
     * Whether this came from a person deciding to re-run the work.
     *
     * The distinction the whole manual-retry design turns on. An
     * automatic trigger — the cron sweep, an install — is an ordinary
     * duplicate and deduplicates against whatever exists, including a
     * failed job the retry policy already gave up on. A merchant
     * pressing "Retry sync" is a new decision, and deduplicating it into
     * a job that is already dead is how idempotency becomes a
     * user-facing deadlock: the sync failed, and the button that exists
     * to fix it does nothing.
     *
     * It changes NOTHING except the failed case. A live job still wins —
     * an explicit trigger must not start a second concurrent sync any
     * more than an automatic one may.
     */
    explicit: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<EnqueueResult & { recovered?: boolean }> => {
    const enqueued: EnqueueResult = await ctx.runMutation(internal.scheduling.enqueue, {
      tenantId: args.tenantId,
      type: "catalog_sync",
      idempotencyKey: catalogSyncKey(args.tenantId),
      delayMs: args.delayMs,
    });

    if (!args.explicit || enqueued.created || enqueued.status !== "failed") {
      return enqueued;
    }

    const retried = await ctx.runMutation(internal.scheduling.retryFailedJob, {
      tenantId: args.tenantId,
      jobId: enqueued.jobId,
    });
    if (!retried.retried) return enqueued;

    return {
      jobId: retried.jobId,
      // `created` reports whether an execution was scheduled by this
      // call, which is what a caller acts on. Two merchants
      // double-clicking still produce one: the derived key deduplicates
      // exactly like the original one does.
      created: retried.created,
      status: "queued",
      recovered: true,
    };
  },
});

// =====================================================================
// Retry (P1.3)
// =====================================================================

/**
 * Apply the retry policy to a failed attempt.
 *
 * THE ONLY PLACE A RETRY IS DECIDED. HTTP handlers, webhook handlers and
 * cron callers never retry; they enqueue logical work once and this
 * decides how many times it is attempted. A caller retrying on its own
 * would either duplicate these attempts or race them, and neither would
 * appear in the job row — the record that is meant to explain why
 * something ran three times.
 *
 * Classification happens in the action that caught the error, because
 * that is where the error object still has its type. The DECISION happens
 * here, because it needs `attempt` and `maxAttempts` off the row. The
 * split is the reason this takes a class rather than an error.
 *
 * The re-schedule is in this mutation for the same reason the original
 * enqueue is: Convex schedules transactionally, so "moved to retrying"
 * and "an attempt is scheduled" commit together or not at all. Splitting
 * them would allow a `retrying` row with nothing coming — which looks
 * exactly like a job that is about to run, and never will.
 */
export const reportJobFailure = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    jobId: v.id("jobs"),
    errorClass: v.string(),
    message: v.string(),
  },
  handler: async (
    ctx,
    args,
  ): Promise<
    | { outcome: "retrying"; attempt: number; nextAttemptAt: number }
    | { outcome: "failed"; attempt: number; reason: "terminal" | "attempts_exhausted" }
    | { outcome: "ignored"; reason: string }
  > => {
    const job = await ctx.db.get(args.jobId);
    if (!job || job.tenantId !== args.tenantId) {
      return { outcome: "ignored", reason: "not_found" };
    }

    // A job that is not running cannot have just failed. This is the
    // guard against a late report from an execution the stale-job sweeper
    // already recovered: without it, that report would consume a second
    // transition and could push a job past its ceiling on one attempt.
    if (job.status !== "running") {
      return { outcome: "ignored", reason: `not_running:${job.status}` };
    }

    const cls: FailureClass = isFailureClass(args.errorClass)
      ? args.errorClass
      : "unknown";
    const message = boundError(args.message, 200);
    const now = Date.now();

    const decision = decideRetry({
      // Read from the taxonomy, never re-derived from the message. An
      // unrecognised class degrades to `unknown`, which is terminal — an
      // error nobody classified is not an error anyone showed is safe to
      // repeat.
      retryable: isRetryableClass(cls),
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
    });

    const history = appendAttempt(job.attempts, {
      attempt: job.attempt,
      at: now,
      errorClass: cls,
      message,
      retryable: decision.action === "retry",
    });

    const fail = async (
      reason: "terminal" | "attempts_exhausted",
      failClass: FailureClass,
      failMessage: string,
    ) => {
      await ctx.db.patch(args.jobId, {
        status: "failed",
        completedAt: now,
        failedAt: now,
        lastError: failMessage,
        errorClass: failClass,
        retryable: false,
        attempts: history,
        updatedAt: now,
      });
      logJobEvent({
        event: "job_failed",
        jobId: args.jobId,
        tenantId: args.tenantId,
        type: job.type,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        errorClass: failClass,
        decision: reason,
      });
      return { outcome: "failed" as const, attempt: job.attempt, reason };
    };

    if (decision.action === "fail") {
      return await fail(decision.reason, cls, message);
    }

    // Schedule BEFORE recording the retry.
    //
    // Both happen in this one transaction either way, so ordering does
    // not affect atomicity — but scheduling can legitimately fail, and
    // when it does the job must end up `failed` rather than aborting the
    // mutation. An abort would roll the row back to `running`, where
    // nothing can reach it: the stale sweeper would pick it up, hit the
    // same error, abort again, and the job would be wedged forever with
    // no state that says why.
    //
    // The reachable case is a job whose worker needs arguments the row
    // cannot supply — a `product_embedding` with no `payload`. That is a
    // configuration fault, not a transient one, so it is terminal.
    try {
      // The SAME job, with the same id and the same idempotency key. A
      // retry never creates a second row and never derives a new key —
      // doing either would make the attempt count meaningless and would
      // let a duplicate trigger slip past deduplication as "new" work.
      await scheduleWorker(ctx, job.type as JobType, decision.delayMs, {
        tenantId: args.tenantId,
        jobId: args.jobId,
        shopifyProductId: job.payload?.shopifyProductId,
      });
    } catch (err) {
      return await fail(
        "terminal",
        "invalid_configuration",
        boundError(`Cannot schedule retry: ${boundError(err, 120)}`, 200),
      );
    }

    const nextAttemptAt = now + decision.delayMs;
    await ctx.db.patch(args.jobId, {
      status: "retrying",
      failedAt: now,
      nextAttemptAt,
      lastError: message,
      errorClass: cls,
      retryable: true,
      attempts: history,
      updatedAt: now,
    });

    logJobEvent({
      event: "job_retrying",
      jobId: args.jobId,
      tenantId: args.tenantId,
      type: job.type,
      attempt: job.attempt,
      maxAttempts: job.maxAttempts,
      errorClass: cls,
      decision: "retry",
      nextAttemptAt,
    });

    return { outcome: "retrying", attempt: job.attempt, nextAttemptAt };
  },
});

/**
 * Structured operational logging.
 *
 * One line per retry decision, carrying exactly enough to answer "why did
 * this job run three times" without opening the database. Deliberately
 * carries the error CLASS rather than the error text — a normalised
 * message is already on the row, and a raw provider message is the most
 * likely place for request context to leak into a log.
 *
 * No tokens, no keys, no headers, no provider bodies. Ever.
 */
function logJobEvent(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ scope: "jobs", ...fields }));
}

/**
 * Explicitly re-run failed logical work.
 *
 * THE PROBLEM THIS SOLVES. A failed job keeps its idempotency key
 * forever, because terminal states have no path back into the machine.
 * That is right for an ordinary duplicate — a cron sweep hitting the same
 * key must not re-drive a job the retry policy already gave up on — and
 * wrong for a merchant pressing "Retry sync", which is a new decision by
 * a person, not a repeat of the same trigger. Without this distinction,
 * idempotency becomes a user-facing deadlock: the sync failed, and the
 * button that exists to fix it does nothing.
 *
 *   ordinary duplicate + failed job  ->  deduplicate
 *   explicit retry     + failed job  ->  new execution opportunity
 *
 * THE DESIGN, and why it is this one:
 *
 * A NEW job row, carrying a derived key and a `supersedes` link back to
 * the failed one. The alternative — resetting the failed row to
 * `retrying` — was rejected because it would put an edge out of a
 * terminal state, and "a completed job cannot become pending again" is an
 * invariant with a test that asserts all thirty-six transition pairs.
 * Weakening it to add a feature would be trading a proven safety property
 * for a convenience.
 *
 * What the chosen design preserves:
 *
 *   historical attempts  the failed row is not touched at all
 *   idempotency          the derived key is itself deduplicated, so two
 *                        merchants double-clicking get one job
 *   auditability         `supersedes` makes the chain followable
 *   no double execution  the old job is terminal and unclaimable; the
 *                        new one is the only live row for that work
 */
export const retryFailedJob = internalMutation({
  args: { tenantId: v.id("tenants"), jobId: v.id("jobs") },
  handler: async (
    ctx,
    args,
  ): Promise<
    { retried: true; jobId: Id<"jobs">; created: boolean } | { retried: false; reason: string }
  > => {
    const start = await ctx.db.get(args.jobId);
    if (!start || start.tenantId !== args.tenantId) {
      return { retried: false, reason: "not_found" };
    }

    // Walk to the newest link in the chain before deciding anything.
    //
    // Without this, retrying a job that has ALREADY been retried derives
    // the key its own successor is using, finds it, and deduplicates
    // into it — so a merchant whose first retry also failed gets a
    // second "Retry" button that silently does nothing. That is the same
    // deadlock this function exists to remove, one link further along,
    // and it is what the chain test caught.
    let job = start;
    let depth = 0;
    for (; depth < MAX_MANUAL_RETRY_DEPTH; depth++) {
      const next = await ctx.db
        .query("jobs")
        .withIndex("by_tenant_and_idempotency", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("idempotencyKey", manualRetryKey(job.idempotencyKey)),
        )
        .unique();
      if (!next) break;
      job = next;
    }
    if (depth >= MAX_MANUAL_RETRY_DEPTH) {
      return { retried: false, reason: "retry_chain_too_long" };
    }

    // Only a failed job. A running or retrying one already has an attempt
    // coming and re-driving it would be the double execution this whole
    // phase exists to prevent; a succeeded one has nothing to recover;
    // a cancelled one was stopped deliberately and should not be
    // restarted by a button labelled "retry".
    if (job.status !== "failed") {
      return { retried: false, reason: `not_failed:${job.status}` };
    }

    const enqueued: EnqueueResult = await ctx.runMutation(internal.scheduling.enqueue, {
      tenantId: args.tenantId,
      type: job.type,
      idempotencyKey: manualRetryKey(job.idempotencyKey),
      shopifyProductId: job.payload?.shopifyProductId,
      supersedes: job._id,
    });

    logJobEvent({
      event: "job_manual_retry",
      jobId: enqueued.jobId,
      supersedes: job._id,
      tenantId: args.tenantId,
      type: job.type,
      created: enqueued.created,
    });

    return { retried: true, jobId: enqueued.jobId, created: enqueued.created };
  },
});

/**
 * How many times one piece of logical work can be manually re-run.
 *
 * Each link appends a fixed suffix to the key and costs one indexed read
 * when the chain is walked, so the bound is what keeps both finite. Ten
 * consecutive manual retries of the same work inside one deduplication
 * window is not a merchant who needs an eleventh — it is a merchant who
 * needs the underlying failure fixed, and refusing with a nameable
 * reason says so better than growing a key forever.
 */
const MAX_MANUAL_RETRY_DEPTH = 10;

/** Enqueue re-ingestion of one product, from a Shopify webhook. */
export const enqueueProductSync = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    shopifyProductId: v.string(),
    /** What makes this distinct from a redelivery. See productSyncKey. */
    discriminator: v.string(),
  },
  handler: async (ctx, args): Promise<EnqueueResult> =>
    await ctx.runMutation(internal.scheduling.enqueue, {
      tenantId: args.tenantId,
      type: "product_embedding",
      idempotencyKey: productSyncKey(
        args.tenantId,
        args.shopifyProductId,
        args.discriminator,
      ),
      shopifyProductId: args.shopifyProductId,
    }),
});
