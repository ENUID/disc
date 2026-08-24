import { cronJobs } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api";
import { internalAction } from "./_generated/server";
import { RESYNC_INTERVAL_HOURS } from "./lib/env";

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
      // Scheduled rather than awaited: one slow or failing catalog must
      // not stop the others in this sweep.
      await ctx.scheduler.runAfter(0, internal.ingest.syncCatalog, {
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

export const purgeExpired = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.auth.purgeExpiredSessions, {});
    await ctx.runMutation(internal.auth.purgeExpiredOAuthStates, {});
    return null;
  },
});
