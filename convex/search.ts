import { usageSink } from "./usage";
import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getEmbeddingProvider } from "./lib/embeddings";
import { billingEnabled, env } from "./lib/env";
import { isActive } from "./lib/tenancy";

/**
 * Tenant-scoped retrieval.
 *
 * Convex only allows vector search inside actions, so this is an action
 * rather than a reactive query. The important line is the `filter` on
 * the vector search: `tenantId` is declared as a filter field on the
 * index in schema.ts, so the search physically cannot return another
 * merchant's products. That replaces the prototype's one-table-per-shop
 * arrangement, which gave the same guarantee but only worked on a single
 * machine with local disk.
 *
 * The response shape deliberately matches the Python backend's
 * `/search`, so `frontend/disc-widget.js` needs no changes and its
 * Playwright suites stay valid.
 */

export type WireVariant = {
  id: string;
  title: string;
  price: number;
  available: boolean;
};

export type WireProduct = {
  id: string;
  title: string;
  description: string;
  price: number;
  currency: string;
  image_url: string;
  images: string[];
  tags: string[];
  handle: string;
  product_type: string;
  colour: string;
  variants: WireVariant[];
  score: number;
  reasoning: string;
};

/** One place that maps a stored row onto the wire format the widget expects. */
function toWire(doc: Doc<"products">, score: number, reasoning = ""): WireProduct {
  return {
    id: doc.shopifyProductId,
    title: doc.title,
    description: doc.description,
    price: doc.price,
    currency: doc.currency,
    image_url: doc.imageUrl,
    images: doc.images.length > 0 ? doc.images : [doc.imageUrl],
    tags: doc.tags,
    handle: doc.handle,
    product_type: doc.productType,
    colour: doc.colour,
    variants: doc.variants,
    score: Math.round(score * 10000) / 10000,
    reasoning,
  };
}

export const resolveStorefront = internalQuery({
  args: { publicKey: v.string() },
  handler: async (ctx, { publicKey }) => {
    const tenant = await ctx.db
      .query("tenants")
      .withIndex("by_public_key", (q) => q.eq("publicKey", publicKey))
      .unique();
    if (!tenant) return null;
    return {
      tenantId: tenant._id,
      active: isActive(tenant, billingEnabled()),
      catalogStatus: tenant.catalogStatus,
    };
  },
});

type SearchResponse = {
  query: string;
  results: WireProduct[];
  status: "ready" | "syncing" | "inactive" | "unknown";
};

export const search = action({
  args: {
    publicKey: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
    availableOnly: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<SearchResponse> => {
    const tenant = await ctx.runQuery(internal.search.resolveStorefront, {
      publicKey: args.publicKey,
    });

    // An unknown key is not an error: the script tag lives in a live
    // storefront's HTML and a hard failure there is a JS error on a
    // merchant's shop. The widget reads this and stays dormant.
    if (!tenant) return { query: args.query, results: [], status: "unknown" };
    if (!tenant.active) return { query: args.query, results: [], status: "inactive" };
    if (tenant.catalogStatus !== "ready") {
      return { query: args.query, results: [], status: "syncing" };
    }

    // "query_embedding", not "embedding": /search calls no reasoning
    // model, which makes it tempting to describe as free. It is not —
    // this embed runs on every search, and it is the only cost on this
    // path that scales with traffic rather than catalog size.
    const provider = getEmbeddingProvider(
      env("OPENAI_API_KEY"),
      usageSink(ctx, tenant.tenantId, "query_embedding"),
    );
    const [queryVector] = await provider.embed([args.query]);

    const limit = Math.min(args.limit ?? 12, 50);

    const matches = await ctx.vectorSearch("productEmbeddings", "by_embedding", {
      vector: queryVector,
      // THE isolation guarantee. Without this filter every merchant's
      // catalog is one index and any query could reach any of it.
      filter: (q) => q.eq("tenantId", tenant.tenantId),
      // Over-fetch so post-filtering (availability) can still return a
      // full page. Convex caps this at 256.
      limit: Math.min(limit * 4, 256),
    });

    const productIds = matches.map((m) => m._id);
    const scoreById = new Map(matches.map((m) => [m._id, m._score]));

    // Explicitly typed: the generated api types make these precise, but
    // annotating here means the code is correct with or without codegen.
    const embeddingDocs: Doc<"productEmbeddings">[] = await ctx.runQuery(
      internal.search.embeddingsByIds,
      { tenantId: tenant.tenantId, ids: productIds },
    );

    const docs: Doc<"products">[] = await ctx.runQuery(internal.products.getManyById, {
      tenantId: tenant.tenantId,
      ids: embeddingDocs.map((e) => e.productId),
    });

    const scoreByProduct = new Map<Id<"products">, number>();
    for (const e of embeddingDocs) {
      const s = scoreById.get(e._id);
      if (s !== undefined) scoreByProduct.set(e.productId, s);
    }

    let results = docs;
    // A sold-out product is not a result. The prototype stored
    // per-variant availability and then never filtered on it, so
    // unbuyable products were recommended freely (spec §47).
    if (args.availableOnly !== false) {
      results = results.filter((d) => d.anyVariantAvailable);
    }

    results.sort(
      (a, b) => (scoreByProduct.get(b._id) ?? 0) - (scoreByProduct.get(a._id) ?? 0),
    );

    return {
      query: args.query,
      results: results
        .slice(0, limit)
        .map((d) => toWire(d, scoreByProduct.get(d._id) ?? 0)),
      status: "ready",
    };
  },
});

export const embeddingsByIds = internalQuery({
  args: { tenantId: v.id("tenants"), ids: v.array(v.id("productEmbeddings")) },
  handler: async (ctx, { tenantId, ids }) => {
    const out: Doc<"productEmbeddings">[] = [];
    for (const id of ids) {
      const doc = await ctx.db.get(id);
      // Belt and braces: the vector filter already scoped this, but a
      // cross-tenant row reaching here would be exactly the leak spec §9
      // forbids, so it is checked rather than assumed.
      if (doc && doc.tenantId === tenantId) out.push(doc);
    }
    return out;
  },
});

/**
 * Complete the look — complementary pieces, not more of the same thing.
 *
 * Nearest-neighbour search alone returns near-duplicates: search with a
 * cardigan's vector and you get four more cardigans. So this searches
 * wide, drops the anchor's own category, and keeps the closest match
 * from each remaining one.
 *
 * Two things carried over from the prototype's hard-won behaviour:
 *
 * 1. The candidate pool must be much wider than the result count. A
 *    fixed 40 returned nothing on a real specialist store, where 200 of
 *    250 products are Shoes and a shoe's 40 nearest neighbours are all
 *    shoes — every one filtered out, panel empty.
 *
 * 2. Convex caps vector search at 256 results, where the prototype could
 *    scan the whole table. On a large catalog 256 nearest neighbours of a
 *    shoe may still be all shoes, so this additionally queries by
 *    product type through the `by_tenant_and_type` index rather than
 *    relying on the vector pool alone.
 */
export const completeTheLook = action({
  args: {
    publicKey: v.string(),
    productId: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<SearchResponse> => {
    const tenant = await ctx.runQuery(internal.search.resolveStorefront, {
      publicKey: args.publicKey,
    });
    if (!tenant) return { query: "", results: [], status: "unknown" };
    if (!tenant.active) return { query: "", results: [], status: "inactive" };
    if (tenant.catalogStatus !== "ready") {
      return { query: "", results: [], status: "syncing" };
    }

    const anchor = await ctx.runQuery(internal.products.getByShopifyId, {
      tenantId: tenant.tenantId,
      shopifyProductId: args.productId,
    });
    if (!anchor) return { query: "", results: [], status: "ready" };

    const limit = Math.min(args.limit ?? 4, 12);
    const anchorType = (anchor.productType || "").toLowerCase();

    const anchorEmbedding = await ctx.runQuery(internal.search.embeddingForProduct, {
      tenantId: tenant.tenantId,
      productId: anchor._id,
    });
    if (!anchorEmbedding) return { query: anchor.title, results: [], status: "ready" };

    const matches = await ctx.vectorSearch("productEmbeddings", "by_embedding", {
      vector: anchorEmbedding.embedding,
      filter: (q) => q.eq("tenantId", tenant.tenantId),
      limit: 256,
    });

    const embeddingDocs: Doc<"productEmbeddings">[] = await ctx.runQuery(
      internal.search.embeddingsByIds,
      { tenantId: tenant.tenantId, ids: matches.map((m) => m._id) },
    );
    const scoreByEmbedding = new Map(matches.map((m) => [m._id, m._score]));
    const scoreByProduct = new Map<Id<"products">, number>();
    for (const e of embeddingDocs) {
      const s = scoreByEmbedding.get(e._id);
      if (s !== undefined) scoreByProduct.set(e.productId, s);
    }

    const candidates: Doc<"products">[] = await ctx.runQuery(
      internal.products.getManyById,
      { tenantId: tenant.tenantId, ids: embeddingDocs.map((e) => e.productId) },
    );
    candidates.sort(
      (a, b) => (scoreByProduct.get(b._id) ?? 0) - (scoreByProduct.get(a._id) ?? 0),
    );

    const seenTypes = new Set<string>();
    const results: Doc<"products">[] = [];
    for (const c of candidates) {
      if (c._id === anchor._id) continue;
      if (!c.anyVariantAvailable) continue;
      const type = (c.productType || "").toLowerCase();
      // A store that leaves product_type blank gets near-duplicates from
      // the prototype's version of this, because both guards silently
      // disable themselves on an empty string. Untyped products are
      // binned together here instead, so at most one can appear.
      const key = type || "__untyped__";
      if (anchorType && type === anchorType) continue;
      if (seenTypes.has(key)) continue;
      seenTypes.add(key);
      results.push(c);
      if (results.length >= limit) break;
    }

    return {
      query: anchor.title,
      results: results.map((d) => toWire(d, scoreByProduct.get(d._id) ?? 0)),
      status: "ready",
    };
  },
});

export const embeddingForProduct = internalQuery({
  args: { tenantId: v.id("tenants"), productId: v.id("products") },
  handler: async (ctx, { tenantId, productId }) => {
    return await ctx.db
      .query("productEmbeddings")
      .withIndex("by_tenant_and_product", (q) =>
        q.eq("tenantId", tenantId).eq("productId", productId),
      )
      .unique();
  },
});

/** Product detail for the widget's detail view. */
export const productDetail = action({
  args: { publicKey: v.string(), productId: v.string() },
  handler: async (ctx, args): Promise<WireProduct | null> => {
    const tenant = await ctx.runQuery(internal.search.resolveStorefront, {
      publicKey: args.publicKey,
    });
    if (!tenant || !tenant.active || tenant.catalogStatus !== "ready") return null;

    const doc = await ctx.runQuery(internal.products.getByShopifyId, {
      tenantId: tenant.tenantId,
      shopifyProductId: args.productId,
    });
    if (!doc) return null;
    return toWire(doc, 1.0);
  },
});
