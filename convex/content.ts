import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Id } from "./_generated/dataModel";
import {
  parsePresenceState,
  parseScope,
  WHOLE_SCOPE,
  type PresenceScope,
  type PresenceState,
} from "./lib/content";

/**
 * Content presence (P2.3) — "product X appears in this content".
 *
 * The other half of the content model. `looks.items` is a look's styled
 * SET, and it is what `rebuildEdgesFor` reads to build compatibility
 * edges. This module stores the weaker, more general claim, and nothing
 * here is ever consulted when deriving an edge.
 *
 * That is the separation, and it is structural rather than documented:
 * `convex/looks.ts` does not import this module, so making presence
 * create compatibility takes a deliberate new query rather than a
 * plausible-looking one-line change.
 *
 * Everything is tenant-scoped and bounded. There is no global content
 * index, and no query here reads a corpus to answer a question about one
 * content item.
 */

/**
 * Presence rows per content item.
 *
 * A campaign photograph holds a handful of products; a lookbook might
 * hold more. This is a cap on how much any single content item may
 * assert, so one item cannot become an unbounded read for everything
 * that later lists it.
 */
export const MAX_PRESENCE_PER_CONTENT = 100;

type PresenceRow = {
  productId: Id<"products">;
  state: PresenceState;
  scope: PresenceScope;
  detectedLabel: string | null;
  confidence: number | null;
  detectedBy: string;
};

/** Flatten a validated scope into the stored shape. */
function storedScope(scope: PresenceScope) {
  if (scope.kind === "region") {
    return { kind: "region", x: scope.x, y: scope.y, w: scope.w, h: scope.h };
  }
  if (scope.kind === "interval") {
    return { kind: "interval", startMs: scope.startMs, endMs: scope.endMs };
  }
  return { kind: "whole" };
}

/**
 * Record what an analysis PROPOSED.
 *
 * MERCHANT DECISIONS ARE NEVER OVERWRITTEN. A row already `confirmed` or
 * `rejected` is left exactly as it is, including when a later analysis
 * of the same content proposes the same product again with a different
 * label or a higher confidence.
 *
 * That is the same authority rule P2.2 established for the Brand Brain —
 * derived inference loses to a merchant's decision — applied at a
 * different granularity rather than reimplemented as a second system.
 * Without it, "reject this suggestion" would mean "reject it until the
 * next time this content is processed", which is not what a merchant
 * would understand by rejecting something.
 */
export const recordDetections = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    contentId: v.id("looks"),
    detections: v.array(
      v.object({
        productId: v.id("products"),
        detectedLabel: v.optional(v.string()),
        confidence: v.optional(v.number()),
        scope: v.optional(v.any()),
      }),
    ),
  },
  returns: v.object({
    proposed: v.number(),
    /** Left alone because a merchant had already decided. */
    preserved: v.number(),
  }),
  handler: async (ctx, args) => {
    const content = await ctx.db.get(args.contentId);
    if (!content || content.tenantId !== args.tenantId) {
      return { proposed: 0, preserved: 0 };
    }

    let proposed = 0;
    let preserved = 0;
    const now = Date.now();

    for (const detection of args.detections.slice(0, MAX_PRESENCE_PER_CONTENT)) {
      // A detection naming a product outside this tenant's catalog is
      // not a weak claim, it is an impossible one.
      const product = await ctx.db.get(detection.productId);
      if (!product || product.tenantId !== args.tenantId) continue;

      const existing = await ctx.db
        .query("contentProducts")
        .withIndex("by_tenant_content_product", (q) =>
          q
            .eq("tenantId", args.tenantId)
            .eq("contentId", args.contentId)
            .eq("productId", detection.productId),
        )
        .unique();

      if (existing && existing.state !== "detected") {
        preserved++;
        continue;
      }

      const row = {
        tenantId: args.tenantId,
        contentId: args.contentId,
        productId: detection.productId,
        state: "detected",
        scope: storedScope(parseScope(detection.scope)),
        detectedLabel: detection.detectedLabel?.slice(0, 120),
        confidence:
          typeof detection.confidence === "number" && Number.isFinite(detection.confidence)
            ? Math.max(0, Math.min(1, detection.confidence))
            : undefined,
        detectedBy: "model",
        updatedAt: now,
      };

      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert("contentProducts", { ...row, createdAt: now });
      proposed++;
    }

    return { proposed, preserved };
  },
});

/**
 * A merchant's decision about one proposed relationship.
 *
 * Confirming or rejecting keeps the row and its provenance rather than
 * replacing it: `detectedLabel` and `confidence` describe what the model
 * originally thought, and they stay readable after a human has ruled on
 * it. Erasing them at confirmation time would make "did a human approve
 * this, or did a model?" unanswerable a week later, which is precisely
 * the question that makes a confirmed relationship worth more than a
 * detected one.
 *
 * Note what this does NOT do: it never touches `lookEdges`. Confirming
 * that a product appears in a campaign is not a claim that it goes with
 * anything else in that campaign.
 */
export const setPresenceState = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    contentId: v.id("looks"),
    productId: v.id("products"),
    state: v.string(),
    scope: v.optional(v.any()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const state = parsePresenceState(args.state);
    if (!state) return false;

    const content = await ctx.db.get(args.contentId);
    if (!content || content.tenantId !== args.tenantId) return false;

    const product = await ctx.db.get(args.productId);
    if (!product || product.tenantId !== args.tenantId) return false;

    const existing = await ctx.db
      .query("contentProducts")
      .withIndex("by_tenant_content_product", (q) =>
        q
          .eq("tenantId", args.tenantId)
          .eq("contentId", args.contentId)
          .eq("productId", args.productId),
      )
      .unique();

    const now = Date.now();
    const scope = args.scope === undefined ? undefined : storedScope(parseScope(args.scope));

    if (existing) {
      await ctx.db.patch(existing._id, {
        state,
        ...(scope ? { scope } : {}),
        updatedAt: now,
      });
      return true;
    }

    // A merchant can assert presence the model never proposed. That row
    // has no model provenance because there was none — recording a
    // confidence for a human decision would be inventing one.
    await ctx.db.insert("contentProducts", {
      tenantId: args.tenantId,
      contentId: args.contentId,
      productId: args.productId,
      state,
      scope: scope ?? storedScope(WHOLE_SCOPE),
      detectedBy: "merchant",
      createdAt: now,
      updatedAt: now,
    });
    return true;
  },
});

/** Everything asserted about one content item. Bounded per item. */
export const presenceFor = internalQuery({
  args: { tenantId: v.id("tenants"), contentId: v.id("looks") },
  handler: async (ctx, args): Promise<PresenceRow[]> => {
    const rows = await ctx.db
      .query("contentProducts")
      .withIndex("by_tenant_and_content", (q) =>
        q.eq("tenantId", args.tenantId).eq("contentId", args.contentId),
      )
      .take(MAX_PRESENCE_PER_CONTENT);

    return rows.map((row) => ({
      productId: row.productId,
      state: (parsePresenceState(row.state) ?? "detected") as PresenceState,
      scope: parseScope(row.scope),
      detectedLabel: row.detectedLabel ?? null,
      confidence: row.confidence ?? null,
      detectedBy: row.detectedBy,
    }));
  },
});

/**
 * Which content a product has been confirmed to appear in.
 *
 * The read a future content-aware ranker would use — bounded, tenant
 * scoped, and confirmed-only, so a model's unreviewed proposal cannot
 * reach a shopper by this route. Nothing consumes it yet; it exists so
 * that the presence relation is queryable from both ends, which is what
 * makes it a relation rather than a list hanging off one document.
 */
export const contentForProduct = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    productId: v.id("products"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("contentProducts")
      .withIndex("by_tenant_and_product", (q) =>
        q.eq("tenantId", args.tenantId).eq("productId", args.productId),
      )
      .take(Math.min(args.limit ?? 50, MAX_PRESENCE_PER_CONTENT));

    return rows
      .filter((row) => row.state === "confirmed")
      .map((row) => ({
        contentId: row.contentId,
        scope: parseScope(row.scope),
      }));
  },
});

/**
 * Drop every presence row for one content item.
 *
 * Called when the content is deleted. Presence rows are removed
 * INDEPENDENTLY of compatibility edges — the two are separate relations
 * with separate lifecycles, and a caller that wanted only one of them
 * gone must be able to say so.
 */
export const clearPresenceFor = internalMutation({
  args: { tenantId: v.id("tenants"), contentId: v.id("looks") },
  returns: v.number(),
  handler: async (ctx, args) => {
    let deleted = 0;
    for (;;) {
      const batch = await ctx.db
        .query("contentProducts")
        .withIndex("by_tenant_and_content", (q) =>
          q.eq("tenantId", args.tenantId).eq("contentId", args.contentId),
        )
        .take(200);
      if (batch.length === 0) break;
      for (const row of batch) {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return deleted;
  },
});

/** Counts for a merchant view. One bounded read per content item. */
export const presenceStats = internalQuery({
  args: { tenantId: v.id("tenants"), contentId: v.id("looks") },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("contentProducts")
      .withIndex("by_tenant_and_content", (q) =>
        q.eq("tenantId", args.tenantId).eq("contentId", args.contentId),
      )
      .take(MAX_PRESENCE_PER_CONTENT);

    return {
      detected: rows.filter((r) => r.state === "detected").length,
      confirmed: rows.filter((r) => r.state === "confirmed").length,
      rejected: rows.filter((r) => r.state === "rejected").length,
    };
  },
});
