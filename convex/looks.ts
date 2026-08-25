import { v } from "convex/values";
import {
  internalAction,
  internalMutation,
  internalQuery,
} from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { env } from "./lib/env";
import { extractJson, visionProvider } from "./lib/providers";
import { getEmbeddingProvider } from "./lib/embeddings";
import { usageSink } from "./usage";
import {
  deriveLookAttributes,
  pairsOf,
  parseDetections,
  sanitiseLookAttributes,
  type DetectedGarment,
} from "./lib/looks";
import { emptyProfile, type FashionProfile } from "./lib/fashion-profile";
import { slotForGarment } from "./lib/taxonomy";

/**
 * The Look Builder.
 *
 * A brand's campaign imagery already encodes styling decisions someone
 * made deliberately. This is the path that turns those decisions into
 * something Disc can reason with:
 *
 *   upload image -> vision detects garments -> Disc suggests catalog
 *   matches -> MERCHANT CONFIRMS -> structured look -> outfit graph
 *
 * The capitalised step is the one that matters. Detection produces
 * candidates, never assignments: the model can see "a white shirt" in a
 * photograph and have no idea which of the merchant's fourteen white
 * shirts it is. Auto-assigning would quietly teach Disc a relationship
 * between products that were never photographed together, and nothing
 * downstream could tell that from a real one.
 */

/** Bounds. A look is an outfit, not a catalog. */
const MAX_ITEMS = 8;
const MAX_LOOKS_PER_TENANT = 2000;
const SUGGESTIONS_PER_GARMENT = 6;

export const generateUploadUrl = internalMutation({
  args: {},
  returns: v.string(),
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/**
 * Look at an uploaded campaign image and say what garments are in it.
 *
 * Costs a vision call, metered as "vision" — per upload, not per
 * shopper, which is what keeps this affordable. The raw result is stored
 * on the look as provenance so a merchant can re-map without paying to
 * analyse the same photograph twice.
 */
export const analyseImage = internalAction({
  args: { tenantId: v.id("tenants"), storageId: v.id("_storage") },
  handler: async (
    ctx,
    args,
  ): Promise<{ detected: DetectedGarment[]; suggestions: Suggestion[][] }> => {
    const imageUrl = await ctx.storage.getUrl(args.storageId);
    if (!imageUrl) return { detected: [], suggestions: [] };

    const vision = visionProvider(
      env("ANTHROPIC_API_KEY"),
      usageSink(ctx, args.tenantId, "vision"),
    );

    const response = await vision.describe({
      system: DETECT_SYSTEM,
      user: DETECT_USER,
      promptVersion: DETECT_PROMPT_VERSION,
      imageUrls: [imageUrl],
      maxOutputTokens: 900,
      json: true,
    });

    const detected = parseDetections(extractJson(response.text));

    // Candidates per detected garment, so the merchant picks from a
    // short list rather than searching their whole catalog by hand.
    const suggestions: Suggestion[][] = [];
    for (const garment of detected) {
      suggestions.push(
        await ctx.runAction(internal.looks.suggestMatches, {
          tenantId: args.tenantId,
          description: garment.description,
          slot: garment.slot ?? undefined,
        }),
      );
    }

    return { detected, suggestions };
  },
});

export type Suggestion = {
  productId: string;
  title: string;
  imageUrl: string;
  price: number;
  currency: string;
  score: number;
};

/**
 * Catalog candidates for one detected garment.
 *
 * Vector search over the tenant's own catalog, then a slot filter. The
 * slot filter is applied *after* retrieval rather than as a vector
 * filter because the vector index filters on tenant only — and because
 * a detected "shirt" that the model got slightly wrong should still
 * surface reasonable candidates rather than nothing.
 */
export const suggestMatches = internalAction({
  args: {
    tenantId: v.id("tenants"),
    description: v.string(),
    slot: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<Suggestion[]> => {
    if (!args.description.trim()) return [];

    const provider = getEmbeddingProvider(
      env("OPENAI_API_KEY"),
      // Catalog-side work, not shopper traffic: this runs when a
      // merchant maps a look, never on a shopper's request.
      usageSink(ctx, args.tenantId, "embedding"),
    );
    const [vector] = await provider.embed([args.description]);

    const matches = await ctx.vectorSearch("productEmbeddings", "by_embedding", {
      vector,
      filter: (q) => q.eq("tenantId", args.tenantId),
      limit: 40,
    });

    return await ctx.runQuery(internal.looks.hydrateSuggestions, {
      tenantId: args.tenantId,
      embeddingIds: matches.map((m) => m._id),
      scores: matches.map((m) => m._score),
      slot: args.slot,
      limit: args.limit ?? SUGGESTIONS_PER_GARMENT,
    });
  },
});

export const hydrateSuggestions = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    embeddingIds: v.array(v.id("productEmbeddings")),
    scores: v.array(v.number()),
    slot: v.optional(v.string()),
    limit: v.number(),
  },
  handler: async (ctx, args): Promise<Suggestion[]> => {
    const out: Suggestion[] = [];

    for (let i = 0; i < args.embeddingIds.length; i++) {
      const embedding = await ctx.db.get(args.embeddingIds[i]);
      // Belt and braces on top of the vector filter — the isolation
      // guarantee is asserted at every hop, not argued for once.
      if (!embedding || embedding.tenantId !== args.tenantId) continue;

      const product = await ctx.db.get(embedding.productId);
      if (!product || product.tenantId !== args.tenantId) continue;

      if (args.slot) {
        const profile = await ctx.db
          .query("productProfiles")
          .withIndex("by_tenant_and_product", (q) =>
            q.eq("tenantId", args.tenantId).eq("productId", product._id),
          )
          .unique();
        const garment = (profile?.profile as FashionProfile | undefined)?.garment;
        // Only filter when the product's slot is actually known. An
        // un-enriched product has no garment, and dropping it would hide
        // exactly the products a merchant most needs to map.
        if (garment && slotForGarment(garment) !== args.slot) continue;
      }

      out.push({
        productId: product._id,
        title: product.title,
        imageUrl: product.imageUrl,
        price: product.price,
        currency: product.currency,
        score: args.scores[i] ?? 0,
      });
      if (out.length >= args.limit) break;
    }

    return out;
  },
});

/**
 * Create or update a look.
 *
 * Always lands as a draft. Approving is a separate, explicit act,
 * because approval is what lets a look influence what shoppers see and
 * that should never be a side effect of saving a form.
 */
export const saveLook = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lookId: v.optional(v.id("looks")),
    title: v.string(),
    source: v.union(v.literal("uploaded"), v.literal("merchant_built")),
    imageStorageId: v.optional(v.id("_storage")),
    detected: v.optional(v.any()),
    items: v.array(
      v.object({
        productId: v.id("products"),
        detectedLabel: v.optional(v.string()),
        confidence: v.optional(v.number()),
      }),
    ),
    occasion: v.optional(v.string()),
    style: v.optional(v.string()),
    formality: v.optional(v.number()),
    season: v.optional(v.string()),
    notes: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ lookId: Id<"looks"> } | { error: string }> => {
    const items = args.items.slice(0, MAX_ITEMS);
    if (items.length < 2) {
      return { error: "A look needs at least two products" };
    }

    // Every product must belong to this tenant. Without this a merchant
    // could build a look referencing another shop's product ids and pull
    // them into their own outfit graph.
    const profiles: FashionProfile[] = [];
    const resolved = [];
    for (const item of items) {
      const product = await ctx.db.get(item.productId);
      if (!product || product.tenantId !== args.tenantId) {
        return { error: "That product is not in your catalog" };
      }

      const profileRow = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", args.tenantId).eq("productId", product._id),
        )
        .unique();
      const profile = (profileRow?.profile as FashionProfile | undefined) ?? emptyProfile();
      profiles.push(profile);

      resolved.push({
        productId: product._id,
        slot: (profile.garment ? slotForGarment(profile.garment) : null) ?? "accessory",
        detectedLabel: item.detectedLabel,
        confidence: item.confidence,
      });
    }

    // Derived where the merchant did not say. Their value always wins —
    // this is a starting point, not an override.
    const derived = deriveLookAttributes(profiles);
    const supplied = sanitiseLookAttributes(args);
    const attributes = {
      occasion: supplied.occasion ?? derived.occasion ?? undefined,
      style: supplied.style ?? derived.style ?? undefined,
      formality: supplied.formality ?? derived.formality ?? undefined,
      season: supplied.season ?? derived.season ?? undefined,
      notes: supplied.notes,
    };

    const now = Date.now();
    const title = args.title.trim().slice(0, 120) || "Untitled look";

    if (args.lookId) {
      const existing = await ctx.db.get(args.lookId);
      if (!existing || existing.tenantId !== args.tenantId) {
        return { error: "Look not found" };
      }
      await ctx.db.patch(args.lookId, {
        title,
        items: resolved,
        ...attributes,
        updatedAt: now,
      });
      // Its products may have changed, so its edges must be rebuilt from
      // scratch rather than added to.
      await rebuildEdgesFor(ctx, args.tenantId, args.lookId);
      return { lookId: args.lookId };
    }

    const count = (
      await ctx.db
        .query("looks")
        .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
        .take(MAX_LOOKS_PER_TENANT + 1)
    ).length;
    if (count > MAX_LOOKS_PER_TENANT) {
      return { error: `A store can hold ${MAX_LOOKS_PER_TENANT} looks` };
    }

    const lookId = await ctx.db.insert("looks", {
      tenantId: args.tenantId,
      title,
      source: args.source,
      imageStorageId: args.imageStorageId,
      detected: args.detected,
      items: resolved,
      ...attributes,
      // Draft. Approval is deliberate and separate.
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    return { lookId };
  },
});

/**
 * Approve or archive.
 *
 * The only thing that changes what shoppers see. Approving rebuilds the
 * look's edges into the outfit graph; archiving removes them, so
 * un-approving genuinely takes a merchant's mistake back out of ranking
 * rather than leaving it there invisibly.
 */
export const setLookStatus = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    lookId: v.id("looks"),
    status: v.union(v.literal("draft"), v.literal("approved"), v.literal("archived")),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const look = await ctx.db.get(args.lookId);
    if (!look || look.tenantId !== args.tenantId) return false;

    await ctx.db.patch(args.lookId, { status: args.status, updatedAt: Date.now() });
    await rebuildEdgesFor(ctx, args.tenantId, args.lookId);
    return true;
  },
});

export const deleteLook = internalMutation({
  args: { tenantId: v.id("tenants"), lookId: v.id("looks") },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const look = await ctx.db.get(args.lookId);
    if (!look || look.tenantId !== args.tenantId) return false;

    await removeEdgesFor(ctx, args.tenantId, args.lookId);
    // The image goes too. It is the merchant's campaign photography and
    // there is no reason to keep paying to store it once the look that
    // referenced it is gone.
    if (look.imageStorageId) {
      await ctx.storage.delete(look.imageStorageId);
    }
    await ctx.db.delete(args.lookId);
    return true;
  },
});

// ---------------------------------------------------------------------
// The outfit graph
// ---------------------------------------------------------------------

/**
 * Rebuild one look's contribution to the graph.
 *
 * Remove-then-add rather than incremental: a look's products change when
 * a merchant re-maps it, and incrementally adjusting edges for a changed
 * membership is the kind of arithmetic that drifts silently until the
 * graph no longer describes any real look.
 *
 * Only approved looks contribute. A draft is a merchant thinking aloud.
 */
async function rebuildEdgesFor(
  ctx: { db: any },
  tenantId: Id<"tenants">,
  lookId: Id<"looks">,
): Promise<void> {
  await removeEdgesFor(ctx, tenantId, lookId);

  const look: Doc<"looks"> | null = await ctx.db.get(lookId);
  if (!look || look.status !== "approved") return;

  for (const pair of pairsOf(look.items.map((i: { productId: string }) => i.productId))) {
    const existing = await ctx.db
      .query("lookEdges")
      .withIndex("by_tenant_and_pair", (q: any) =>
        q.eq("tenantId", tenantId).eq("productA", pair.a).eq("productB", pair.b),
      )
      .unique();

    if (existing) {
      if (existing.lookIds.includes(lookId)) continue;
      await ctx.db.patch(existing._id, {
        weight: existing.weight + 1,
        lookIds: [...existing.lookIds, lookId],
        updatedAt: Date.now(),
      });
    } else {
      await ctx.db.insert("lookEdges", {
        tenantId,
        productA: pair.a,
        productB: pair.b,
        weight: 1,
        lookIds: [lookId],
        updatedAt: Date.now(),
      });
    }
  }
}

async function removeEdgesFor(
  ctx: { db: any },
  tenantId: Id<"tenants">,
  lookId: Id<"looks">,
): Promise<void> {
  const edges = await ctx.db
    .query("lookEdges")
    .withIndex("by_tenant_and_a", (q: any) => q.eq("tenantId", tenantId))
    .collect();

  for (const edge of edges) {
    if (!edge.lookIds.includes(lookId)) continue;
    const lookIds = edge.lookIds.filter((id: Id<"looks">) => id !== lookId);
    // An edge with no looks behind it is not a weak relationship, it is
    // no relationship — delete it rather than leaving a zero-weight row
    // that still matches a lookup.
    if (lookIds.length === 0) await ctx.db.delete(edge._id);
    else {
      await ctx.db.patch(edge._id, {
        weight: lookIds.length,
        lookIds,
        updatedAt: Date.now(),
      });
    }
  }
}

/**
 * The graph, for one request.
 *
 * Returns edges plus the approved-look count, which is what scales the
 * bonus: one look is not evidence about a brand's styling, thirty is.
 */
export const affinityFor = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const edges = await ctx.db
      .query("lookEdges")
      .withIndex("by_tenant_and_a", (q) => q.eq("tenantId", tenantId))
      .take(20000);

    const approved = await ctx.db
      .query("looks")
      .withIndex("by_tenant_and_status", (q) =>
        q.eq("tenantId", tenantId).eq("status", "approved"),
      )
      .take(MAX_LOOKS_PER_TENANT);

    return {
      edges: edges.map((e) => ({
        productA: e.productA as string,
        productB: e.productB as string,
        weight: e.weight,
      })),
      lookCount: approved.length,
    };
  },
});

// ---------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------

export const listLooks = internalQuery({
  args: { tenantId: v.id("tenants"), status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const looks = args.status
      ? await ctx.db
          .query("looks")
          .withIndex("by_tenant_and_status", (q) =>
            q.eq("tenantId", args.tenantId).eq("status", args.status as "approved"),
          )
          .take(500)
      : await ctx.db
          .query("looks")
          .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
          .take(500);

    const out = [];
    for (const look of looks) {
      out.push({
        id: look._id,
        title: look.title,
        status: look.status,
        source: look.source,
        occasion: look.occasion ?? null,
        style: look.style ?? null,
        season: look.season ?? null,
        formality: look.formality ?? null,
        itemCount: look.items.length,
        imageUrl: look.imageStorageId
          ? await ctx.storage.getUrl(look.imageStorageId)
          : null,
        products: await productSummaries(ctx, look),
        createdAt: look.createdAt,
      });
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    return out;
  },
});

export const getLook = internalQuery({
  args: { tenantId: v.id("tenants"), lookId: v.id("looks") },
  handler: async (ctx, args) => {
    const look = await ctx.db.get(args.lookId);
    if (!look || look.tenantId !== args.tenantId) return null;

    return {
      id: look._id,
      title: look.title,
      status: look.status,
      source: look.source,
      occasion: look.occasion ?? null,
      style: look.style ?? null,
      season: look.season ?? null,
      formality: look.formality ?? null,
      notes: look.notes ?? null,
      // What the model saw, kept alongside what the merchant confirmed —
      // never merged, so "did a human approve this?" stays answerable.
      detected: look.detected ?? null,
      imageUrl: look.imageStorageId ? await ctx.storage.getUrl(look.imageStorageId) : null,
      products: await productSummaries(ctx, look),
      createdAt: look.createdAt,
    };
  },
});

async function productSummaries(ctx: { db: any }, look: Doc<"looks">) {
  const out = [];
  for (const item of look.items) {
    const product = await ctx.db.get(item.productId);
    if (!product) continue;
    out.push({
      productId: product._id,
      title: product.title,
      imageUrl: product.imageUrl,
      price: product.price,
      currency: product.currency,
      slot: item.slot,
      detectedLabel: item.detectedLabel ?? null,
    });
  }
  return out;
}

/** Counts for the dashboard header. */
export const lookStats = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const looks = await ctx.db
      .query("looks")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .take(MAX_LOOKS_PER_TENANT);

    const edges = await ctx.db
      .query("lookEdges")
      .withIndex("by_tenant_and_a", (q) => q.eq("tenantId", tenantId))
      .take(20000);

    return {
      total: looks.length,
      approved: looks.filter((l) => l.status === "approved").length,
      draft: looks.filter((l) => l.status === "draft").length,
      relationships: edges.length,
    };
  },
});

// ---------------------------------------------------------------------

const DETECT_PROMPT_VERSION = "look_detect_v1";

const DETECT_SYSTEM = `You identify garments in fashion photography.

Return JSON: {"garments": [{"label": string, "garment": string, "colour": string, "description": string}]}

Rules:
- One entry per distinct garment worn in the image, front to back: outerwear, top, bottom, footwear, then accessories.
- "garment" must be one of: shirt, t-shirt, polo, blouse, sweater, hoodie, trouser, jeans, chinos, shorts, skirt, dress, jumpsuit, jacket, blazer, coat, suit, vest, sneaker, loafer, boot, derby, sandal, heel, flat, bag, belt, hat, scarf, jewelry, watch. If none fits, omit the field.
- "label" is a short human name, e.g. "white linen shirt".
- "description" describes what you can SEE — colour, material, cut, details — in one sentence. It is used to search a product catalog, so describe the garment, not the model, the pose or the setting.
- Describe only what is visible. Do not guess a brand, a price, or a product name.
- Ignore anything not worn: props, furniture, background.`;

const DETECT_USER = `Identify every garment worn in this image.`;
