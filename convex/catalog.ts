import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import {
  accumulate,
  applyDelta,
  countsDrift,
  countsFrom,
  isNoOpDelta,
  ZERO_COUNTS,
  type CatalogCounts,
  type CountDelta,
} from "./lib/catalog-counts";

/**
 * Catalog aggregates (P1.6).
 *
 * Two halves that must agree, and are made to agree by sharing every
 * predicate in `lib/catalog-counts.ts`:
 *
 *   bumpCounts   applied at each lifecycle transition, in the same
 *                transaction as the change that caused it
 *
 *   reconcile    rebuilt from authoritative rows, on a schedule, never
 *                on a request path
 *
 * Neither ever reads `productEmbeddings`. That is the invariant this
 * phase exists to establish, and it is why `products.embeddedAt` exists.
 */

/**
 * Apply a counter delta to a tenant.
 *
 * A plain function rather than a mutation: it must run inside the SAME
 * transaction as the write that caused it, or a crash between the two
 * leaves a counter that disagrees with the rows it summarises. Callers
 * are already mutations, so they pass their own `ctx`.
 *
 * A zero delta writes nothing at all. That matters more than it looks:
 * it is what makes a retried job harmless, and it keeps an unchanged
 * product in a resync from touching the tenant row — which on a
 * 5,000-product catalog would otherwise be 5,000 writes to one document
 * to record nothing.
 */
export async function bumpCounts(
  ctx: {
    db: {
      get: (id: Id<"tenants">) => Promise<Doc<"tenants"> | null>;
      patch: (id: Id<"tenants">, patch: Record<string, unknown>) => Promise<void>;
    };
  },
  tenantId: Id<"tenants">,
  delta: CountDelta,
): Promise<void> {
  if (isNoOpDelta(delta)) return;

  const tenant = await ctx.db.get(tenantId);
  if (!tenant) return;

  const next = applyDelta(countsFrom(tenant), delta);
  await ctx.db.patch(tenantId, { ...next, updatedAt: Date.now() });
}

/**
 * Count one page of a tenant's catalog from authoritative rows.
 *
 * Driven off `products`, deliberately. A profile whose product has been
 * deleted is an orphan, not an enriched product, and walking profiles
 * independently would count it — which is exactly the semantics the old
 * implementation had, because it looped over products and looked each
 * profile up.
 *
 * Reads per page: one product row and one profile row each. No
 * embeddings — `embeddedAt` on the product answers that.
 */
export const countPage = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ counts: CatalogCounts; cursor: string | null; isDone: boolean }> => {
    const page = await ctx.db
      .query("products")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .paginate({ cursor: args.cursor, numItems: args.numItems ?? 200 });

    let counts = ZERO_COUNTS;
    for (const product of page.page) {
      const profile = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", args.tenantId).eq("productId", product._id),
        )
        .unique();
      counts = accumulate(counts, product, profile);
    }

    return { counts, cursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Write rebuilt counters and stamp when they were rebuilt. */
export const writeCounts = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    counts: v.object({
      productCount: v.number(),
      unavailableCount: v.number(),
      missingImagesCount: v.number(),
      embeddedCount: v.number(),
      enrichedCount: v.number(),
      lowConfidenceCount: v.number(),
      rejectedFieldsCount: v.number(),
    }),
  },
  returns: v.array(
    v.object({ field: v.string(), from: v.number(), to: v.number() }),
  ),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) return [];

    // Reported, not just corrected. Silent self-healing would hide the
    // bug that caused the drift, and the whole reason this path exists
    // is that maintained counters are the kind of thing that goes wrong
    // quietly.
    const drift = countsDrift(countsFrom(tenant), args.counts);

    await ctx.db.patch(args.tenantId, {
      ...args.counts,
      catalogCountsAt: Date.now(),
      updatedAt: Date.now(),
    });

    return drift.map((d) => ({ field: String(d.field), from: d.from, to: d.to }));
  },
});

/**
 * Rebuild one tenant's counters.
 *
 * An action so the page loop lives outside any single transaction: each
 * page is its own bounded query, and a large catalog is walked in many
 * small reads rather than one that would hit the same limit the old
 * implementation did.
 *
 * Not on a request path, by construction — nothing in `merchant.ts`
 * calls it.
 */
export const reconcileTenant = internalAction({
  args: { tenantId: v.id("tenants"), pageSize: v.optional(v.number()) },
  returns: v.object({
    counts: v.any(),
    drift: v.array(v.object({ field: v.string(), from: v.number(), to: v.number() })),
  }),
  handler: async (ctx, args) => {
    let counts: CatalogCounts = ZERO_COUNTS;
    let cursor: string | null = null;

    // Bounded: a catalog larger than pageSize * 500 is not fully walked
    // in one run. At the default that is 100,000 products, well past the
    // largest tier, and stopping is better than an unbounded loop.
    for (let page = 0; page < 500; page++) {
      const result: {
        counts: CatalogCounts;
        cursor: string | null;
        isDone: boolean;
      } = await ctx.runQuery(internal.catalog.countPage, {
        tenantId: args.tenantId,
        cursor,
        numItems: args.pageSize ?? 200,
      });

      counts = {
        productCount: counts.productCount + result.counts.productCount,
        unavailableCount: counts.unavailableCount + result.counts.unavailableCount,
        missingImagesCount: counts.missingImagesCount + result.counts.missingImagesCount,
        embeddedCount: counts.embeddedCount + result.counts.embeddedCount,
        enrichedCount: counts.enrichedCount + result.counts.enrichedCount,
        lowConfidenceCount: counts.lowConfidenceCount + result.counts.lowConfidenceCount,
        rejectedFieldsCount:
          counts.rejectedFieldsCount + result.counts.rejectedFieldsCount,
      };

      if (result.isDone) break;
      cursor = result.cursor;
    }

    const drift: Array<{ field: string; from: number; to: number }> =
      await ctx.runMutation(internal.catalog.writeCounts, {
        tenantId: args.tenantId,
        counts,
      });

    if (drift.length > 0) {
      console.log(
        JSON.stringify({
          scope: "catalog",
          event: "counts_drift_corrected",
          tenantId: args.tenantId,
          drift,
        }),
      );
    }

    return { counts, drift };
  },
});

/** Tenants whose counters were rebuilt longest ago. */
export const staleCountTenants = internalQuery({
  args: { limit: v.optional(v.number()) },
  returns: v.array(v.id("tenants")),
  handler: async (ctx, args) => {
    // Tenant count is small — this is a B2B product with merchants, not
    // consumers — so taking a bounded slice and sorting in memory is
    // honest and avoids an index that exists only for a nightly sweep.
    // If tenant count ever reaches the take() bound, this needs an index
    // on `catalogCountsAt`; the bound is what makes that visible rather
    // than silent.
    const tenants = await ctx.db.query("tenants").take(500);
    return tenants
      .sort((a, b) => (a.catalogCountsAt ?? 0) - (b.catalogCountsAt ?? 0))
      .slice(0, args.limit ?? 10)
      .map((t) => t._id);
  },
});
