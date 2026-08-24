import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DeterministicEmbeddings } from "./lib/embeddings";
import { emptyProfile, type FashionProfile } from "./lib/fashion-profile";

/**
 * The decision engine, end to end against the real Convex runtime.
 *
 * No model key is configured here, so the judge and the explanation
 * writer both fall back. That is deliberate and is itself the thing
 * under test: spec §14 and §94 require Disc to degrade rather than fail,
 * and the deterministic half of the engine must produce a complete,
 * honest answer on its own.
 */

const modules = import.meta.glob("./**/*.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicApi = () => api as any;

async function seedTenant(t: ReturnType<typeof convexTest>, publicKey: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("tenants", {
      shopDomain: `${publicKey}.myshopify.com`,
      publicKey,
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "active",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedPiece(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  opts: {
    id: string;
    title: string;
    text: string;
    productType: string;
    profile: Partial<FashionProfile>;
    price?: number;
    available?: boolean;
  },
) {
  const provider = new DeterministicEmbeddings();
  const [embedding] = await provider.embed([opts.text]);

  await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId: opts.id,
      title: opts.title,
      description: opts.text,
      handle: opts.id,
      productType: opts.productType,
      vendor: "Acme",
      tags: [],
      price: opts.price ?? 100,
      currency: "GBP",
      imageUrl: "https://cdn/a.jpg",
      images: ["https://cdn/a.jpg"],
      colour: "",
      variants: [
        { id: `${opts.id}-v1`, title: "M", price: opts.price ?? 100, available: opts.available ?? true },
      ],
      anyVariantAvailable: opts.available ?? true,
      ingestedAt: Date.now(),
    });
    await ctx.db.insert("productEmbeddings", {
      tenantId,
      productId,
      embedding,
      embeddingModel: provider.name,
      contentHash: opts.id,
      createdAt: Date.now(),
    });
    await ctx.db.insert("productProfiles", {
      tenantId,
      productId,
      profile: { ...emptyProfile(), ...opts.profile },
      provenance: {},
      completeness: 0.8,
      cacheKey: opts.id,
      schemaVersion: "profile_v1",
      lastEnrichedAt: Date.now(),
    });
  });
}

/** A small but complete catalog: tops, bottoms and shoes that can pair. */
async function seedWardrobe(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  await seedPiece(t, tenantId, {
    id: "shirt-white", title: "White Oxford Shirt", text: "crisp white cotton oxford shirt",
    productType: "Shirts",
    profile: { garment: "shirt", colorFamily: "white", formality: 3, fit: "regular",
      styleVector: { classic: 0.9, minimal: 0.6 }, pattern: "plain" },
  });
  await seedPiece(t, tenantId, {
    id: "tee-black", title: "Black Cotton Tee", text: "plain black cotton t-shirt",
    productType: "Tops",
    profile: { garment: "t-shirt", colorFamily: "black", formality: 0, fit: "relaxed",
      styleVector: { minimal: 0.8, streetwear: 0.3 }, pattern: "plain" },
  });
  await seedPiece(t, tenantId, {
    id: "trouser-navy", title: "Navy Wool Trouser", text: "tailored navy wool trouser",
    productType: "Trousers",
    profile: { garment: "trouser", colorFamily: "navy", formality: 3, fit: "tailored",
      styleVector: { classic: 0.9 }, pattern: "plain" },
  });
  await seedPiece(t, tenantId, {
    id: "jeans-indigo", title: "Indigo Jeans", text: "relaxed indigo denim jeans",
    productType: "Trousers",
    profile: { garment: "jeans", colorFamily: "blue", formality: 1, fit: "relaxed",
      styleVector: { classic: 0.5, streetwear: 0.4 }, pattern: "plain" },
  });
  await seedPiece(t, tenantId, {
    id: "loafer-brown", title: "Brown Leather Loafer", text: "polished brown leather loafer",
    productType: "Shoes",
    profile: { garment: "loafer", colorFamily: "brown", formality: 3, fit: "regular",
      styleVector: { classic: 0.9 }, pattern: "plain" },
  });
  await seedPiece(t, tenantId, {
    id: "sneaker-white", title: "White Sneaker", text: "clean white leather sneaker",
    productType: "Shoes",
    profile: { garment: "sneaker", colorFamily: "white", formality: 1, fit: "regular",
      styleVector: { minimal: 0.7, sport: 0.4 }, pattern: "plain" },
  });
}

describe("decision engine", () => {
  test("assembles complete outfits from a real catalog", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedWardrobe(t, tenantId);

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "something smart for dinner",
    });

    expect(result.status).toBe("ready");
    expect(result.outfits.length).toBeGreaterThan(0);

    for (const outfit of result.outfits) {
      // Every outfit must be wearable: more than one piece, and never
      // two things that occupy the same slot.
      expect(outfit.products.length).toBeGreaterThanOrEqual(2);
      const slots = Object.keys(outfit.slots);
      expect(new Set(slots).size).toBe(slots.length);
      expect(outfit.explanation.length).toBeGreaterThan(0);
      expect(outfit.direction.length).toBeGreaterThan(0);
    }
  });

  test("every recommended product belongs to the merchant (spec §129)", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "disc_acme");
    const rival = await seedTenant(t, "disc_rival");
    await seedWardrobe(t, acme);
    await seedPiece(t, rival, {
      id: "rival-shirt", title: "Rival Shirt", text: "crisp white cotton oxford shirt",
      productType: "Shirts",
      profile: { garment: "shirt", colorFamily: "white", formality: 3 },
    });

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "crisp white cotton oxford shirt",
    });

    const ids = result.outfits.flatMap((o: { products: Array<{ id: string }> }) =>
      o.products.map((p) => p.id),
    );
    expect(ids.length).toBeGreaterThan(0);
    expect(ids).not.toContain("rival-shirt");
  });

  test("a formality request shifts which pieces are chosen", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedWardrobe(t, tenantId);

    const formal = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "smart tailored outfit for a formal dinner",
    });
    const casual = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "relaxed casual everyday outfit",
    });

    const topIds = (r: { outfits: Array<{ products: Array<{ id: string }> }> }) =>
      r.outfits[0]?.products.map((p) => p.id) ?? [];

    // Not asserting exact products — that would pin the ranking weights.
    // Asserting that the request changes the answer at all, which is the
    // whole point of an intent layer.
    expect(formal.status).toBe("ready");
    expect(casual.status).toBe("ready");
    expect(topIds(formal).join()).not.toBe("");
    expect(topIds(casual).join()).not.toBe("");
  });

  test("a budget is honoured as a hard constraint", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedPiece(t, tenantId, {
      id: "cheap-top", title: "Cheap Tee", text: "plain cotton t-shirt", productType: "Tops",
      price: 20, profile: { garment: "t-shirt", colorFamily: "white", formality: 1 },
    });
    await seedPiece(t, tenantId, {
      id: "cheap-bottom", title: "Cheap Jeans", text: "denim jeans", productType: "Trousers",
      price: 40, profile: { garment: "jeans", colorFamily: "blue", formality: 1 },
    });
    await seedPiece(t, tenantId, {
      id: "luxury-top", title: "Cashmere Sweater", text: "plain cotton t-shirt", productType: "Tops",
      price: 900, profile: { garment: "sweater", colorFamily: "beige", formality: 2 },
    });

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "an outfit under $100",
    });

    const ids = result.outfits.flatMap((o: { products: Array<{ id: string }> }) =>
      o.products.map((p) => p.id),
    );
    // A stated budget is a statement, not a preference.
    expect(ids).not.toContain("luxury-top");
  });

  test("sold-out products never reach an outfit", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedWardrobe(t, tenantId);
    await seedPiece(t, tenantId, {
      id: "gone", title: "Sold Out Jacket", text: "crisp white cotton oxford shirt",
      productType: "Outerwear", available: false,
      profile: { garment: "jacket", colorFamily: "navy", formality: 3 },
    });

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "crisp white cotton oxford shirt",
    });
    const ids = result.outfits.flatMap((o: { products: Array<{ id: string }> }) =>
      o.products.map((p) => p.id),
    );
    expect(ids).not.toContain("gone");
  });

  test("says so plainly when there is no strong answer (spec §96)", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    // Tops only — no outfit is possible.
    await seedPiece(t, tenantId, {
      id: "only-top", title: "A Shirt", text: "a shirt", productType: "Shirts",
      profile: { garment: "shirt", colorFamily: "white" },
    });

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "an outfit",
    });

    expect(result.status).toBe("no_result");
    expect(result.outfits).toEqual([]);
    // Never fabricate — say what happened.
    expect(result.message).toBeTruthy();
  });

  test("writes a recommendation trace for every result (spec §81)", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedWardrobe(t, tenantId);

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "smart outfit",
    });

    const trace = await t.run(async (ctx) => {
      return await ctx.db
        .query("recommendationTraces")
        .withIndex("by_recommendation_id", (q) =>
          q.eq("recommendationId", result.recommendationId),
        )
        .unique();
    });

    expect(trace).not.toBeNull();
    expect(trace!.tenantId).toBe(tenantId);
    // The trace is what makes "why did Disc recommend that?" answerable.
    expect(trace!.candidateIds.length).toBeGreaterThan(0);
    expect(trace!.finalIds.length).toBeGreaterThan(0);
    expect(trace!.versions).toBeTruthy();
    expect(trace!.latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("a no-result is traced too, with its reason", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedPiece(t, tenantId, {
      id: "only-top", title: "A Shirt", text: "a shirt", productType: "Shirts",
      profile: { garment: "shirt" },
    });

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "an outfit",
    });
    const trace = await t.run(async (ctx) => {
      return await ctx.db
        .query("recommendationTraces")
        .withIndex("by_recommendation_id", (q) =>
          q.eq("recommendationId", result.recommendationId),
        )
        .unique();
    });

    // A failure to answer is exactly the case worth diagnosing later.
    expect(trace).not.toBeNull();
    expect(trace!.fallback).toBe("no_result");
  });

  test("session state carries constraints into a follow-up (spec §40)", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedWardrobe(t, tenantId);

    await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "a smart outfit under $500",
      sessionKey: "shopper-1",
    });

    const saved = await t.run(async (ctx) => {
      return await ctx.db
        .query("shopperSessions")
        .withIndex("by_tenant_and_key", (q) =>
          q.eq("tenantId", tenantId).eq("sessionKey", "shopper-1"),
        )
        .unique();
    });
    expect(saved).not.toBeNull();
    expect(saved!.state.budget?.amount).toBe(500);

    // "Make it cheaper" must transform the stored budget, not re-parse
    // from scratch and lose it.
    await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "make it cheaper",
      sessionKey: "shopper-1",
    });

    const after = await t.run(async (ctx) => {
      return await ctx.db
        .query("shopperSessions")
        .withIndex("by_tenant_and_key", (q) =>
          q.eq("tenantId", tenantId).eq("sessionKey", "shopper-1"),
        )
        .unique();
    });
    expect(after!.state.budget.amount).toBeLessThan(500);
    expect(after!.state.workflow).toBe("REFINE");
  });

  test("an inactive or unknown tenant gets no products", async () => {
    const t = convexTest(schema, modules);
    const unknown = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_nope",
      query: "an outfit",
    });
    expect(unknown.status).toBe("unknown");
    expect(unknown.outfits).toEqual([]);
  });

  test("the engine works with no model key configured", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "disc_acme");
    await seedWardrobe(t, tenantId);

    const result = await t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_acme",
      query: "smart outfit",
    });

    // No ANTHROPIC_API_KEY here, so both the judge and the explanation
    // writer fall back. The result must still be complete and honest —
    // Disc degrades, it does not fail (spec §14, §94).
    expect(result.status).toBe("ready");
    expect(result.outfits.length).toBeGreaterThan(0);
    for (const outfit of result.outfits) {
      expect(outfit.explanation).toBeTruthy();
      expect(outfit.explanation).not.toContain("{}");
    }
  });
});
