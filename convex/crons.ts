import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  EVENT_RETENTION_DAYS,
  JOB_STALE_RUNNING_MS,
  RESYNC_INTERVAL_HOURS,
  SHOPPER_SESSION_RETENTION_DAYS,
  STRIPE_EVENT_RETENTION_DAYS,
  USAGE_RETENTION_DAYS,
  WEBHOOK_RETENTION_DAYS,
} from "./lib/env";

/**
 * Scheduled work.
 *
 * Replaces the prototype's `_resync_loop`, an asyncio task inside the
 * web process. Three problems with that: it died silently with the
 * process, it slept before its first run so a restart delayed every
 * resync by a full interval, and N workers meant N concurrent resyncs of
 * the same catalog.
 */

const crons = cronJobs();

crons.interval(
  "resync stale catalogs",
  { hours: Math.max(1, RESYNC_INTERVAL_HOURS) },
  internal.crons.resyncStaleCatalogs,
  {},
);

/**
 * Crash recovery (P1.3).
 *
 * A job whose action died is stuck in `running` — it holds a claim that
 * nothing will ever release, so no retry can reach it and no enqueue can
 * replace it. This is the only thing that resolves that, so its interval
 * is also the worst-case latency of recovering from a lost action.
 */
crons.interval(
  "recover stuck jobs",
  { minutes: 5 },
  internal.crons.recoverStuckJobs,
  {},
);

// Cheap sweeps; these tables would otherwise grow forever.
crons.daily(
  "purge expired sessions",
  { hourUTC: 3, minuteUTC: 0 },
  internal.crons.purgeExpired,
  {},
);

export default crons;

/**
 * Resync catalogs that have gone stale.
 *
 * Bounded per run so one sweep cannot fan out across every tenant at
 * once — with hosted embeddings that is a cost spike as well as a load
 * spike. Tenants missed this run are picked up next.
 */
export const resyncStaleCatalogs = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - RESYNC_INTERVAL_HOURS * 3600 * 1000;
    const due = await ctx.runQuery(internal.tenants.dueForResync, {
      olderThan: cutoff,
      limit: 25,
    });

    for (const tenant of due) {
      // Enqueued rather than scheduled directly: `dueForResync` already
      // excludes tenants mid-sync, but a merchant pressing Resync in the
      // same window would otherwise race this sweep. One job either way.
      //
      // Still not awaited for its result — one slow or failing catalog
      // must not stop the others in this sweep.
      await ctx.runMutation(internal.scheduling.enqueueCatalogSync, {
        tenantId: tenant._id,
      });
    }
    return null;
  },
});

/**
 * Drain the enrichment backlog.
 *
 * `enrichBatch` is bounded per run so it cannot time out, which means a
 * large catalog needs several passes. This re-schedules itself while
 * work remains rather than relying on the hourly tick, so a 5,000-product
 * catalog finishes in minutes instead of days.
 */
export const drainEnrichment = internalAction({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const result: { enriched: number; remaining: number } = await ctx.runAction(
      internal.enrichment.enrichBatch,
      { tenantId },
    );
    // Only continue while progress is actually being made. A batch that
    // enriched nothing but still reports work remaining means every
    // product in it failed, and re-scheduling would spin forever.
    if (result.remaining > 0 && result.enriched > 0) {
      await ctx.scheduler.runAfter(1000, internal.crons.drainEnrichment, { tenantId });
      return null;
    }

    // Backlog drained. The Brand Brain is derived from product
    // attributes, so it can only be built once enough of them exist —
    // `canDeriveBrand` refuses below the coverage threshold, and this is
    // the point at which coverage stops changing.
    await ctx.scheduler.runAfter(0, internal.brand.buildBrandBrain, { tenantId });
    return null;
  },
});

/**
 * Recover jobs whose execution died (P1.3).
 *
 * A `running` row older than `JOB_STALE_RUNNING_MS` is the signature of
 * an action that disappeared: it claimed the job, incremented `attempt`,
 * and never reported anything. P1.1 could see these (`stuckJobs`) and had
 * no policy for them. This is the policy.
 *
 * THE STALE ATTEMPT IS CONSIDERED CONSUMED, and that is the whole reason
 * a crash loop terminates. `attempt` was incremented at claim, so a job
 * that dies three times in a row arrives at `attempt === maxAttempts` and
 * `decideRetry` fails it. Counting attempts on *failure* instead would
 * mean a process that disappears never reaches the counter, and this
 * sweeper would resurrect the same job forever.
 *
 * WHY IT DOES NOT SIMPLY RE-RUN THE WORK. Blind re-execution would race a
 * job that is merely slow rather than dead, giving two live executions of
 * the same work — the exact thing P1.2 was built to prevent. Instead the
 * job is moved back into the state machine (`running -> retrying`) and
 * `reportJobFailure` decides from the attempt count whether another
 * attempt is warranted, exactly as it would for a reported failure.
 *
 * THE ONE RACE THIS ACCEPTS, stated plainly: a job that is still alive
 * past the threshold gets moved to `retrying` under it, and its eventual
 * `succeedJob` is then refused — `retrying -> succeeded` is not a legal
 * transition — so its work is redone. The threshold is set well above
 * Convex's action time limit to make this vanishingly unlikely, and the
 * consequence when it does happen is a redundant re-run rather than
 * corruption. The alternative, widening the transition matrix so a
 * zombie execution can still report success, would weaken a tested
 * invariant to handle a case that should not occur.
 */
export const recoverStuckJobs = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const stale: Array<{
      _id: Id<"jobs">;
      tenantId: Id<"tenants">;
      type: string;
      attempt: number;
    }> = await ctx.runQuery(internal.jobs.stuckJobs, {
      runningSince: Date.now() - JOB_STALE_RUNNING_MS,
      limit: 50,
    });

    for (const job of stale) {
      // `stalled` is a retryable class, so a job with attempts left gets
      // another and one without is failed with a reason that says what
      // happened rather than "unknown".
      await ctx.runMutation(internal.scheduling.reportJobFailure, {
        tenantId: job.tenantId,
        jobId: job._id,
        errorClass: "stalled",
        message: `Execution stopped reporting after attempt ${job.attempt}`,
      });
    }
    return null;
  },
});

export const purgeExpired = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.auth.purgeExpiredSessions, {});
    await ctx.runMutation(internal.auth.purgeExpiredOAuthStates, {});

    // Rate-limit windows. One row per tenant per rule, so this stays
    // small — but a row is written for every tenant that ever searched,
    // and nothing else ever deletes them.
    for (let i = 0; i < 10; i++) {
      const purged: number = await ctx.runMutation(internal.billing.purgeRateLimits, {});
      if (purged < 500) break;
    }

    // Model usage. Kept far longer than events: this is the record that
    // justifies a price, and a year-over-year comparison is worth
    // having. It is also tiny — one row per tenant per day per operation
    // per model — so the retention is generous rather than grudging.
    const usageCutoff = new Date(
      Date.now() - USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    )
      .toISOString()
      .slice(0, 10);
    for (let i = 0; i < 10; i++) {
      const purged: number = await ctx.runMutation(internal.usage.purgeOldUsage, {
        beforeDay: usageCutoff,
        limit: 1000,
      });
      if (purged < 1000) break;
    }

    // Shopper sessions (spec §92). Shortest retention of anything here:
    // this is the one record holding what a shopper *said* they wanted
    // rather than what they clicked.
    const sessionCutoff =
      Date.now() - SHOPPER_SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const deleted: number = await ctx.runMutation(internal.session.purgeStaleSessions, {
        olderThan: sessionCutoff,
        limit: 1000,
      });
      if (deleted < 1000) break;
    }

    // Webhook delivery ledger (P1.4). Deduplication only has to outlive
    // Shopify's retry window; beyond that the row is history, and one
    // row per delivery on a busy catalog is the fastest-growing table
    // this phase adds.
    const deliveryCutoff =
      Date.now() - WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const deleted: number = await ctx.runMutation(
        internal.webhooks.purgeExpiredDeliveries,
        { olderThan: deliveryCutoff, limit: 1000 },
      );
      if (deleted < 1000) break;
    }

    // Stripe event ledger (P1.5). Kept longer than the Shopify one:
    // Stripe permits a manual resend for up to 30 days, and a ledger
    // that has forgotten an event cannot deduplicate its replay.
    const stripeCutoff =
      Date.now() - STRIPE_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (let i = 0; i < 10; i++) {
      const deleted: number = await ctx.runMutation(
        internal.billing.purgeExpiredStripeEvents,
        { olderThan: stripeCutoff, limit: 1000 },
      );
      if (deleted < 1000) break;
    }

    // Event retention (spec §92). Events are shopper behaviour and are
    // aged out; recommendation traces are kept, because they are what
    // makes a past recommendation explainable.
    const cutoff = Date.now() - EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    // Bounded per run so a large backlog is drained over several nights
    // rather than in one mutation that exceeds its limits.
    for (let i = 0; i < 10; i++) {
      const deleted: number = await ctx.runMutation(internal.analytics.purgeOldEvents, {
        olderThan: cutoff,
        limit: 1000,
      });
      if (deleted < 1000) break;
    }
    return null;
  },
});
