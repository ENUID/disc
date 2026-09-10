import { v } from "convex/values";
import { internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import {
  eventTime,
  isStale,
  NOT_APPLIED,
  parseTimestamp,
  type DeliveryOutcome,
} from "./lib/webhooks";
import { productSyncKey } from "./scheduling";

/**
 * Shopify webhook delivery handling (P1.4) — the stateful half.
 *
 * ONE MUTATION DOES THE WHOLE DECISION:
 *
 *   dedupe -> freshness -> business work -> ledger row
 *
 * The same structural reason as P1.2's enqueue. Split across two calls,
 * a crash between them leaves either
 *
 *   ledger says processed, no work scheduled
 *     -> Shopify's retry is deduplicated and the update is lost FOREVER
 *
 * or
 *
 *   work scheduled, no ledger row
 *     -> Shopify's retry re-enqueues, and the job's idempotency key
 *        collapses it. Harmless.
 *
 * Those are not symmetric, and the first is unrecoverable without a
 * reconciliation sweep. Doing both in one transaction means neither can
 * happen: Convex mutations commit atomically, and a scheduled function
 * scheduled inside one is scheduled if and only if it commits.
 *
 * WHAT THIS IS NOT: a second deduplication mechanism. Job idempotency
 * still does its own work — this layers on top of it and answers a
 * different question. See `lib/webhooks.ts` for which layer catches what.
 */

/**
 * What a delivery should cause, if it is fresh and not a duplicate.
 *
 * An explicit union rather than a callback, for the same reason
 * `scheduleWorker` is an explicit switch: the actions differ in shape,
 * and a callback would let a route pass work that this mutation cannot
 * reason about — which for `purge_tenant` in particular would be a
 * destructive operation smuggled through a dedupe path.
 */
const deliveryAction = v.union(
  v.object({
    kind: v.literal("product_sync"),
    shopifyProductId: v.string(),
    /** The resource version. See productSyncKey. */
    discriminator: v.string(),
  }),
  v.object({
    kind: v.literal("product_delete"),
    shopifyProductId: v.string(),
  }),
  v.object({ kind: v.literal("purge_tenant") }),
  /** GDPR topics Disc holds no data for. Recorded, never acted on. */
  v.object({ kind: v.literal("acknowledge") }),
);

export type DeliveryResult = {
  outcome: DeliveryOutcome | "duplicate";
  jobId?: Id<"jobs">;
};

/**
 * Record a verified delivery and act on it exactly once.
 *
 * Called only after the HMAC has been verified and the tenant resolved —
 * so nothing here is reachable by an unauthenticated request, and every
 * row is tenant-scoped.
 */
export const recordDelivery = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    /** X-Shopify-Webhook-Id. Absent only if Shopify omitted it. */
    webhookId: v.optional(v.string()),
    /** X-Shopify-Event-Id. Stored for correlation, never compared. */
    eventId: v.optional(v.string()),
    topic: v.string(),
    triggeredAt: v.optional(v.number()),
    /** The payload's own `updated_at`, verbatim. */
    resourceUpdatedAt: v.optional(v.string()),
    action: deliveryAction,
  },
  handler: async (ctx, args): Promise<DeliveryResult> => {
    const receivedAt = Date.now();
    const resourceId =
      args.action.kind === "product_sync" || args.action.kind === "product_delete"
        ? args.action.shopifyProductId
        : undefined;

    // ---------------------------------------------------------------
    // 1. DELIVERY DEDUPLICATION — "have we already processed this exact
    //    delivery?" Keyed on the webhook id and nothing else.
    // ---------------------------------------------------------------
    if (args.webhookId) {
      const seen = await ctx.db
        .query("webhookDeliveries")
        .withIndex("by_tenant_and_webhook", (q) =>
          q.eq("tenantId", args.tenantId).eq("webhookId", args.webhookId!),
        )
        .unique();

      if (seen) {
        // Acknowledged, nothing re-run. This is the common case under a
        // Shopify retry, and it writes no row: the one that already
        // exists is the record of the delivery, and storing one per
        // redelivery would grow the table under a retry storm without
        // adding information.
        return { outcome: "duplicate", jobId: seen.jobId };
      }
    }
    // A delivery with no webhook id cannot be deduplicated. It is still
    // processed: losing deduplication is recoverable — the job key and
    // the freshness check both still apply — while dropping a real
    // update is not. Shopify always sends the header; this is the
    // defensive branch, not the expected one.

    const eventAt = eventTime({
      resourceUpdatedAt: args.resourceUpdatedAt,
      triggeredAt: args.triggeredAt,
      receivedAt,
    });

    // ---------------------------------------------------------------
    // 2. RESOURCE FRESHNESS — "is this event newer than the state we
    //    already applied?" A different question with a different answer,
    //    deliberately not folded into the step above.
    // ---------------------------------------------------------------
    const stale =
      resourceId !== undefined &&
      isStale(eventAt, await lastAppliedAt(ctx, args.tenantId, resourceId));

    if (stale) {
      // Recorded and acknowledged, but NOT applied. Shopify retries a
      // non-2xx, and a stale event will still be stale on redelivery, so
      // refusing it would produce an infinite retry of an event whose
      // only correct outcome is to be ignored.
      await ctx.db.insert("webhookDeliveries", {
        tenantId: args.tenantId,
        webhookId: args.webhookId ?? `no-id-${receivedAt}`,
        eventId: args.eventId,
        topic: args.topic,
        resourceId,
        triggeredAt: args.triggeredAt,
        resourceUpdatedAt: args.resourceUpdatedAt,
        eventAt,
        appliedEventAt: NOT_APPLIED,
        outcome: "stale",
        receivedAt,
      });
      return { outcome: "stale" };
    }

    // ---------------------------------------------------------------
    // 3. THE WORK, in this same transaction.
    // ---------------------------------------------------------------
    let jobId: Id<"jobs"> | undefined;
    let outcome: DeliveryOutcome = "applied";

    switch (args.action.kind) {
      case "product_sync": {
        const enqueued = await ctx.runMutation(internal.scheduling.enqueue, {
          tenantId: args.tenantId,
          type: "product_embedding",
          idempotencyKey: productSyncKey(
            args.tenantId,
            args.action.shopifyProductId,
            args.action.discriminator,
          ),
          shopifyProductId: args.action.shopifyProductId,
        });
        jobId = enqueued.jobId;
        break;
      }

      case "product_delete":
        await ctx.runMutation(internal.products.deleteByShopifyId, {
          tenantId: args.tenantId,
          shopifyProductId: args.action.shopifyProductId,
        });
        break;

      case "purge_tenant":
        // Deletes this tenant's rows, including the ledger row about to
        // be written below and every one before it. That is correct: an
        // uninstalled or redacted shop should leave nothing behind, and
        // a redelivered uninstall then finds no tenant at all and is a
        // no-op one level up.
        await ctx.runMutation(internal.tenants.purgeTenant, {
          tenantId: args.tenantId,
        });
        return { outcome: "applied" };

      case "acknowledge":
        // Disc holds no customer PII — only catalog data — so the two
        // customer GDPR topics are acknowledgements. Recorded so that
        // "did we receive it" is answerable, marked so it is not
        // mistaken for applied state in a freshness comparison.
        outcome = "acknowledged";
        break;
    }

    await ctx.db.insert("webhookDeliveries", {
      tenantId: args.tenantId,
      webhookId: args.webhookId ?? `no-id-${receivedAt}`,
      eventId: args.eventId,
      topic: args.topic,
      resourceId,
      triggeredAt: args.triggeredAt,
      resourceUpdatedAt: args.resourceUpdatedAt,
      eventAt,
      // Only a delivery that actually changed resource state advances the
      // freshness watermark. An acknowledgement must not, or a GDPR
      // no-op would start suppressing real product updates.
      appliedEventAt: outcome === "applied" ? eventAt : NOT_APPLIED,
      outcome,
      jobId,
      receivedAt,
    });

    return { outcome, jobId };
  },
});

/**
 * The newest state already applied for a resource, as an event time.
 *
 * Two sources, because neither alone is sufficient:
 *
 *   the ledger    survives a delete. After `products/delete` there is no
 *                 product row left, so a stale `products/update` arriving
 *                 afterwards would look like a brand-new product and be
 *                 re-created. The ledger remembers the delete.
 *
 *   the product   survives ledger retention, and covers every product
 *                 that arrived by catalog sync rather than by webhook —
 *                 which on a fresh install is all of them. Without this,
 *                 the first webhook for a synced product would always
 *                 look fresh.
 *
 * The higher of the two wins.
 */
async function lastAppliedAt(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  tenantId: Id<"tenants">,
  resourceId: string,
): Promise<number> {
  // Descending on `appliedEventAt`, first row. Unapplied rows carry 0 and
  // sort below every real event time, so this is the newest applied
  // delivery in one read — no scan and no "take the last N" constant.
  const latest = await ctx.db
    .query("webhookDeliveries")
    .withIndex("by_tenant_and_resource", (q: any) =>
      q.eq("tenantId", tenantId).eq("resourceId", resourceId),
    )
    .order("desc")
    .first();

  const product = await ctx.db
    .query("products")
    .withIndex("by_tenant_and_shopify_id", (q: any) =>
      q.eq("tenantId", tenantId).eq("shopifyProductId", resourceId),
    )
    .unique();

  return Math.max(
    latest?.appliedEventAt ?? NOT_APPLIED,
    parseTimestamp(product?.sourceUpdatedAt) ?? NOT_APPLIED,
  );
}

/**
 * Age out the ledger.
 *
 * Deduplication only needs to outlive Shopify's retry window, which is
 * measured in days rather than months. Freshness needs longer in
 * principle, but `products.sourceUpdatedAt` carries that for every
 * product that still exists — the ledger's unique contribution is
 * remembering deletes, and a delete older than the retention window has
 * long since been reconciled by the periodic catalog sweep.
 */
export const purgeExpiredDeliveries = internalMutation({
  args: { olderThan: v.number(), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("webhookDeliveries")
      .withIndex("by_received", (q) => q.lt("receivedAt", args.olderThan))
      .take(Math.min(args.limit ?? 200, 1000));

    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
