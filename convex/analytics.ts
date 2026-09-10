import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

import {
  isClientReportable,
  isEventType,
  isRecommendationId,
  sanitisePayload,
  VersionStamp,
} from "./lib/events";

/**
 * Event and trace persistence (spec §80, §81).
 *
 * Two distinct things live here and they are not interchangeable:
 *
 *   events  what a shopper did. High volume, cheap, forgeable (they come
 *           from a public storefront), aggregated into merchant metrics.
 *   traces  what Disc decided and why. One per result set, written
 *           server-side only, never accepts client input.
 *
 * The trace is the thing that answers "why did Disc recommend that?"
 * (§82). It has to be written at the moment of the recommendation —
 * scores, candidate ids and versions cannot be reconstructed afterwards.
 */

export const recordEvent = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    type: v.string(),
    sessionKey: v.optional(v.string()),
    recommendationId: v.optional(v.string()),
    productIds: v.optional(v.array(v.string())),
    payload: v.optional(v.any()),
    /**
     * Whether this came from a storefront. Client-reported events are
     * restricted to a safe subset — a forged request must not be able to
     * write `purchase` and inflate a merchant's revenue metric.
     */
    fromClient: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const allowed = args.fromClient ? isClientReportable(args.type) : isEventType(args.type);
    if (!allowed) return false;

    await ctx.db.insert("events", {
      tenantId: args.tenantId,
      type: args.type,
      sessionKey: args.sessionKey?.slice(0, 80),
      // Silently dropped rather than rejected if malformed: a bad id
      // should cost attribution on one event, not the event itself.
      recommendationId: isRecommendationId(args.recommendationId)
        ? args.recommendationId
        : undefined,
      productIds: args.productIds?.slice(0, 24).map((id) => id.slice(0, 64)),
      payload: sanitisePayload(args.payload),
      at: Date.now(),
    });
    return true;
  },
});

export const recordTrace = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    recommendationId: v.string(),
    sessionKey: v.optional(v.string()),
    workflow: v.string(),
    request: v.any(),
    intent: v.optional(v.any()),
    brandBrainVersion: v.optional(v.number()),
    candidateIds: v.array(v.string()),
    finalIds: v.array(v.string()),
    scores: v.any(),
    judge: v.optional(v.any()),
    versions: v.any(),
    fallback: v.optional(v.string()),
    latencyMs: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await ctx.db.insert("recommendationTraces", {
      ...args,
      // Candidates can run to hundreds; the trace needs enough to
      // reproduce the decision, not the entire funnel.
      candidateIds: args.candidateIds.slice(0, 200),
      at: Date.now(),
    });
    return null;
  },
});

export const traceById = internalQuery({
  args: { recommendationId: v.string() },
  handler: async (ctx, { recommendationId }) => {
    return await ctx.db
      .query("recommendationTraces")
      .withIndex("by_recommendation_id", (q) => q.eq("recommendationId", recommendationId))
      .unique();
  },
});

/**
 * Merchant-facing metrics (spec §75).
 *
 * Deliberately business metrics, not "messages processed" — §75 is
 * explicit that the volume of AI calls is not the value being sold.
 *
 * Bounded by `since` and a hard take() cap: this runs on a page load,
 * and an unbounded scan of a busy tenant's events would be the slowest
 * query in the system.
 */
export const overview = internalQuery({
  args: { tenantId: v.id("tenants"), since: v.number() },
  handler: async (ctx, { tenantId, since }) => {
    const events = await ctx.db
      .query("events")
      .withIndex("by_tenant_and_at", (q) => q.eq("tenantId", tenantId).gte("at", since))
      .take(20000);

    const counts = new Map<string, number>();
    const sessions = new Set<string>();
    const productsDiscovered = new Set<string>();

    for (const event of events) {
      counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
      if (event.sessionKey) sessions.add(event.sessionKey);
      if (event.type === "product_viewed" || event.type === "product_clicked") {
        for (const id of event.productIds ?? []) productsDiscovered.add(id);
      }
    }

    const get = (type: string) => counts.get(type) ?? 0;
    const clicks = get("product_clicked");
    const addToCart = get("add_to_cart");

    return {
      sessions: sessions.size,
      queries: get("query_submitted"),
      outfitsGenerated: get("outfit_generated"),
      productsDiscovered: productsDiscovered.size,
      productClicks: clicks,
      productSaves: get("product_saved"),
      outfitSaves: get("outfit_saved"),
      addToCart,
      refinements: get("refinement_requested"),
      errors: get("error"),
      // Rates only where the denominator is real. A 0/0 rendered as 0%
      // reads as "nothing works" rather than "nothing happened yet".
      clickThroughRate: clicks > 0 ? round(clicks / Math.max(1, get("product_viewed"))) : null,
      cartRate: clicks > 0 ? round(addToCart / clicks) : null,
      truncated: events.length >= 20000,
    };
  },
});

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Recent traces, for the internal debug panel (spec §82). */
export const recentTraces = internalQuery({
  args: { tenantId: v.id("tenants"), limit: v.number() },
  handler: async (ctx, { tenantId, limit }) => {
    return await ctx.db
      .query("recommendationTraces")
      .withIndex("by_tenant_and_at", (q) => q.eq("tenantId", tenantId))
      .order("desc")
      .take(Math.min(limit, 100));
  },
});

/**
 * Build the version stamp for a trace.
 *
 * Assembled in one place so a new version axis is added once rather than
 * at every call site — and so a missing axis is visible here rather than
 * silently absent from half the traces.
 */
export function versionStamp(input: {
  brandBrainVersion: number | null;
  embeddingModel: string;
  reasoningModel: string | null;
  promptVersions: Record<string, string>;
  ranker: string;
  judge: string | null;
  schemaVersion: string;
  appVersion: string;
}): VersionStamp {
  return {
    app: input.appVersion,
    schema: input.schemaVersion,
    brandBrain: input.brandBrainVersion,
    embedding: input.embeddingModel,
    reasoningModel: input.reasoningModel,
    promptVersions: input.promptVersions,
    ranker: input.ranker,
    judge: input.judge,
  };
}

/**
 * Event retention sweep.
 *
 * Spec §92 requires a documented retention period. Events are shopper
 * behaviour, so they should not accumulate indefinitely; traces are kept
 * longer because they are what makes a recommendation explainable.
 */
export const purgeOldEvents = internalMutation({
  args: { olderThan: v.number(), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, { olderThan, limit }) => {
    const stale = await ctx.db
      .query("events")
      .filter((q) => q.lt(q.field("at"), olderThan))
      .take(limit ?? 1000);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
