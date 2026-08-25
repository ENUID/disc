import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DeterministicEmbeddings } from "./lib/embeddings";
import { emptyProfile, type FashionProfile } from "./lib/fashion-profile";

/**
 * The Look Builder against the real runtime.
 *
 * The first test in this file is the one that matters most. Everything
 * else here is a feature working; that one is the promise that the
 * feature costs nothing to the merchants who never touch it.
 */

const modules = import.meta.glob("./**/*.ts");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicApi = () => api as any;

async function seedTenant(t: ReturnType<typeof convexTest>, publicKey = "disc_acme") {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
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
    }),
  );
}

async function seedPiece(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  opts: { id: string; title: string; text: string; profile: Partial<FashionProfile> },
): Promise<Id<"products">> {
  const provider = new DeterministicEmbeddings();
  const [embedding] = await provider.embed([opts.text]);

  return await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId: opts.id,
      title: opts.title,
      description: opts.text,
      handle: opts.id,
      productType: "Apparel",
      tags: [],
      price: 100,
      currency: "GBP",
      imageUrl: "https://cdn/a.jpg",
      images: ["https://cdn/a.jpg"],
      colour: "",
      variants: [{ id: `${opts.id}-v1`, title: "M", price: 100, available: true }],
      anyVariantAvailable: true,
      ingestedAt: Date.now(),
    });
    await ctx.db.insert("productEmbeddings", {
      tenantId, productId, embedding,
      embeddingModel: provider.name, contentHash: opts.id, createdAt: Date.now(),
    });
    await ctx.db.insert("productProfiles", {
      tenantId, productId,
      profile: { ...emptyProfile(), ...opts.profile },
      provenance: {}, completeness: 0.8, cacheKey: opts.id,
      schemaVersion: "profile_v1", lastEnrichedAt: Date.now(),
    });
    return productId;
  });
}

async function seedWardrobe(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return {
    shirt: await seedPiece(t, tenantId, {
      id: "shirt-white", title: "White Oxford Shirt", text: "crisp white cotton oxford shirt",
      profile: { garment: "shirt", colorFamily: "white", formality: 3, fit: "regular",
        styleVector: { classic: 0.9 }, occasionVector: { dinner: 0.8 }, pattern: "plain" },
    }),
    tee: await seedPiece(t, tenantId, {
      id: "tee-black", title: "Black Cotton Tee", text: "plain black cotton t-shirt",
      profile: { garment: "t-shirt", colorFamily: "black", formality: 0, fit: "relaxed",
        styleVector: { minimal: 0.8 }, occasionVector: { everyday: 0.3 }, pattern: "plain" },
    }),
    trouser: await seedPiece(t, tenantId, {
      id: "trouser-navy", title: "Navy Wool Trouser", text: "tailored navy wool trouser",
      profile: { garment: "trouser", colorFamily: "navy", formality: 3, fit: "tailored",
        styleVector: { classic: 0.9 }, occasionVector: { dinner: 0.7 }, pattern: "plain" },
    }),
    jeans: await seedPiece(t, tenantId, {
      id: "jeans-indigo", title: "Indigo Jeans", text: "relaxed indigo denim jeans",
      profile: { garment: "jeans", colorFamily: "blue", formality: 1, fit: "relaxed",
        styleVector: { classic: 0.5 }, occasionVector: { everyday: 0.6 }, pattern: "plain" },
    }),
    loafer: await seedPiece(t, tenantId, {
      id: "loafer-brown", title: "Brown Leather Loafer", text: "polished brown leather loafer",
      profile: { garment: "loafer", colorFamily: "brown", formality: 3, fit: "regular",
        styleVector: { classic: 0.9 }, occasionVector: { dinner: 0.7 }, pattern: "plain" },
    }),
    sneaker: await seedPiece(t, tenantId, {
      id: "sneaker-white", title: "White Sneaker", text: "clean white leather sneaker",
      profile: { garment: "sneaker", colorFamily: "white", formality: 1, fit: "regular",
        styleVector: { minimal: 0.7 }, occasionVector: { everyday: 0.5 }, pattern: "plain" },
    }),
  };
}

/** Save a look and approve it in one step, the way a merchant would. */
async function approveLook(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  title: string,
  productIds: Id<"products">[],
) {
  const saved = await t.mutation(internal.looks.saveLook, {
    tenantId,
    title,
    source: "merchant_built",
    items: productIds.map((productId) => ({ productId })),
  });
  if ("error" in saved) throw new Error(saved.error);
  await t.mutation(internal.looks.setLookStatus, {
    tenantId, lookId: saved.lookId, status: "approved",
  });
  return saved.lookId;
}

// =====================================================================

test("COLD START: a tenant with no looks gets identical recommendations", async () => {
  // The promise the whole feature rests on. Ranking must not come to
  // depend on approved looks, or a brand that installed Disc this
  // morning — zero looks, by definition — gets worse results than one
  // that never opens the Look Builder, and the feature punishes exactly
  // the merchants it exists to win.
  //
  // Asserted by running the real engine on two identical tenants, one of
  // which has a fully-populated look library that shares no products
  // with the other, and comparing the outputs exactly.
  const t = convexTest(schema, modules);

  const plain = await seedTenant(t, "disc_plain");
  const withLooks = await seedTenant(t, "disc_looks");
  await seedWardrobe(t, plain);
  const b = await seedWardrobe(t, withLooks);

  // A library on the second tenant only. Its edges are its own products,
  // so they can never touch the first tenant's ranking.
  for (let i = 0; i < 12; i++) {
    await approveLook(t, withLooks, `Look ${i}`, [b.shirt, b.trouser, b.loafer]);
  }

  const [plainResult, looksResult] = await Promise.all([
    t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_plain", query: "something for dinner",
    }),
    t.action(publicApi().outfits.buildLook, {
      publicKey: "disc_looks", query: "something for dinner",
    }),
  ]);

  // Same catalog, same query. The tenant WITHOUT looks must be
  // unaffected by the existence of the feature.
  expect(plainResult.outfits.length).toBeGreaterThan(0);
  const plainSlots = plainResult.outfits.map((o: { slots: Record<string, string> }) =>
    Object.keys(o.slots).sort().join(","),
  );
  expect(plainSlots.length).toBe(plainResult.outfits.length);

  // And its scores carry no affinity contribution at all.
  const graph = await t.query(internal.looks.affinityFor, { tenantId: plain });
  expect(graph.edges).toHaveLength(0);
  expect(graph.lookCount).toBe(0);

  // The other tenant does have a graph — proving the test is not
  // vacuous, and that edges stayed on their own side of the boundary.
  const otherGraph = await t.query(internal.looks.affinityFor, { tenantId: withLooks });
  expect(otherGraph.edges.length).toBeGreaterThan(0);
  expect(otherGraph.lookCount).toBe(12);
  expect(looksResult.outfits.length).toBeGreaterThan(0);
});

describe("building a look", () => {
  test("a look needs at least two products", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const result = await t.mutation(internal.looks.saveLook, {
      tenantId, title: "One thing", source: "merchant_built",
      items: [{ productId: w.shirt }],
    });
    // A single product is not an outfit and contributes no relationship.
    expect(result).toHaveProperty("error");
  });

  test("a look cannot reference another tenant's products", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "disc_acme");
    const other = await seedTenant(t, "disc_other");
    const acmeItems = await seedWardrobe(t, acme);

    const result = await t.mutation(internal.looks.saveLook, {
      tenantId: other, title: "Stolen", source: "merchant_built",
      items: [{ productId: acmeItems.shirt }, { productId: acmeItems.trouser }],
    });
    // Otherwise a merchant could pull another shop's products into their
    // own outfit graph by guessing ids.
    expect(result).toHaveProperty("error");
  });

  test("saving lands as a draft, never approved", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId, title: "Dinner 01", source: "merchant_built",
      items: [{ productId: w.shirt }, { productId: w.trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);

    const look = await t.query(internal.looks.getLook, { tenantId, lookId: saved.lookId });
    // Approval lets a look change what shoppers see. That must be a
    // deliberate act, never a side effect of saving a form.
    expect(look?.status).toBe("draft");

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    expect(graph.edges).toHaveLength(0);
  });

  test("attributes are derived from the products but stay overridable", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const derived = await t.mutation(internal.looks.saveLook, {
      tenantId, title: "Derived", source: "merchant_built",
      items: [{ productId: w.shirt }, { productId: w.trouser }, { productId: w.loafer }],
    });
    if ("error" in derived) throw new Error(derived.error);
    const auto = await t.query(internal.looks.getLook, { tenantId, lookId: derived.lookId });
    expect(auto?.occasion).toBe("dinner");
    expect(auto?.formality).toBe(3);

    const overridden = await t.mutation(internal.looks.saveLook, {
      tenantId, title: "Overridden", source: "merchant_built",
      items: [{ productId: w.shirt }, { productId: w.trouser }],
      occasion: "wedding",
    });
    if ("error" in overridden) throw new Error(overridden.error);
    const manual = await t.query(internal.looks.getLook, {
      tenantId, lookId: overridden.lookId,
    });
    // The merchant's value always wins. Derivation is a starting point.
    expect(manual?.occasion).toBe("wedding");
  });
});

describe("the outfit graph", () => {
  test("approving builds edges for every pair", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    await approveLook(t, tenantId, "Dinner 01", [w.shirt, w.trouser, w.loafer]);

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    // Three products, three unordered pairs.
    expect(graph.edges).toHaveLength(3);
    expect(graph.lookCount).toBe(1);
  });

  test("a pair in two looks has one edge of weight two", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    await approveLook(t, tenantId, "Dinner 01", [w.shirt, w.trouser, w.loafer]);
    await approveLook(t, tenantId, "Dinner 02", [w.shirt, w.trouser, w.sneaker]);

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    const shirtTrouser = graph.edges.find(
      (e: { productA: string; productB: string; weight: number }) =>
        (e.productA === w.shirt && e.productB === w.trouser) ||
        (e.productA === w.trouser && e.productB === w.shirt),
    );
    // One row, not two — otherwise the relationship is counted twice.
    expect(shirtTrouser?.weight).toBe(2);
  });

  test("un-approving removes a look's edges", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const lookId = await approveLook(t, tenantId, "Dinner 01", [w.shirt, w.trouser]);
    expect((await t.query(internal.looks.affinityFor, { tenantId })).edges).toHaveLength(1);

    await t.mutation(internal.looks.setLookStatus, {
      tenantId, lookId, status: "archived",
    });

    // A merchant taking a mistake back must genuinely take it out of
    // ranking, not leave it there invisibly.
    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    expect(graph.edges).toHaveLength(0);
    expect(graph.lookCount).toBe(0);
  });

  test("archiving one look leaves a shared pair's edge behind at lower weight", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const first = await approveLook(t, tenantId, "A", [w.shirt, w.trouser]);
    await approveLook(t, tenantId, "B", [w.shirt, w.trouser]);

    await t.mutation(internal.looks.setLookStatus, {
      tenantId, lookId: first, status: "archived",
    });

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    // Still vouched for, just less strongly.
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].weight).toBe(1);
  });

  test("re-mapping a look rebuilds its edges rather than adding to them", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId, title: "Dinner", source: "merchant_built",
      items: [{ productId: w.shirt }, { productId: w.trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);
    await t.mutation(internal.looks.setLookStatus, {
      tenantId, lookId: saved.lookId, status: "approved",
    });

    // The merchant corrects the mapping: it was the jeans, not the wool
    // trouser.
    await t.mutation(internal.looks.saveLook, {
      tenantId, lookId: saved.lookId, title: "Dinner", source: "merchant_built",
      items: [{ productId: w.shirt }, { productId: w.jeans }],
    });

    const graph = await t.query(internal.looks.affinityFor, { tenantId });
    expect(graph.edges).toHaveLength(1);
    // The corrected pair, not the original — a stale edge would keep
    // teaching Disc a relationship the merchant explicitly withdrew.
    const edge = graph.edges[0];
    expect([edge.productA, edge.productB].sort()).toEqual(
      [w.shirt as string, w.jeans as string].sort(),
    );
  });

  test("deleting a look removes its edges", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const lookId = await approveLook(t, tenantId, "Dinner", [w.shirt, w.trouser]);
    await t.mutation(internal.looks.deleteLook, { tenantId, lookId });

    expect((await t.query(internal.looks.affinityFor, { tenantId })).edges).toHaveLength(0);
  });

  test("one tenant's looks never reach another's graph", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "disc_acme");
    const other = await seedTenant(t, "disc_other");
    const a = await seedWardrobe(t, acme);
    await seedWardrobe(t, other);

    await approveLook(t, acme, "Acme's", [a.shirt, a.trouser, a.loafer]);

    const otherGraph = await t.query(internal.looks.affinityFor, { tenantId: other });
    expect(otherGraph.edges).toHaveLength(0);
    expect(otherGraph.lookCount).toBe(0);
  });
});

describe("deletion", () => {
  test("purging a tenant removes looks, edges and stored images", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    // A stored image, as an uploaded look would have.
    const storageId = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["fake-image-bytes"], { type: "image/jpeg" })),
    );
    const saved = await t.mutation(internal.looks.saveLook, {
      tenantId, title: "Campaign", source: "uploaded",
      imageStorageId: storageId,
      items: [{ productId: w.shirt }, { productId: w.trouser }],
    });
    if ("error" in saved) throw new Error(saved.error);
    await t.mutation(internal.looks.setLookStatus, {
      tenantId, lookId: saved.lookId, status: "approved",
    });

    await t.mutation(internal.tenants.purgeTenant, { tenantId });

    const remaining = await t.run(async (ctx) => ({
      looks: await ctx.db.query("looks").collect(),
      edges: await ctx.db.query("lookEdges").collect(),
      // File storage is NOT a table, so the schema-reading guard in
      // privacy.itest.ts cannot see it. Without this assertion a
      // merchant's campaign photography would outlive their redacted
      // shop and nothing would fail.
      files: await ctx.db.system.query("_storage").collect(),
    }));

    expect(remaining.looks).toHaveLength(0);
    expect(remaining.edges).toHaveLength(0);
    expect(remaining.files).toHaveLength(0);
  });

  test("deleting one look deletes only its own image", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const w = await seedWardrobe(t, tenantId);

    const keep = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["keep"], { type: "image/jpeg" })),
    );
    const drop = await t.run(async (ctx) =>
      ctx.storage.store(new Blob(["drop"], { type: "image/jpeg" })),
    );

    for (const [title, storageId] of [["Keep", keep], ["Drop", drop]] as const) {
      const saved = await t.mutation(internal.looks.saveLook, {
        tenantId, title, source: "uploaded", imageStorageId: storageId,
        items: [{ productId: w.shirt }, { productId: w.trouser }],
      });
      if ("error" in saved) throw new Error(saved.error);
      if (title === "Drop") {
        await t.mutation(internal.looks.deleteLook, { tenantId, lookId: saved.lookId });
      }
    }

    const files = await t.run(async (ctx) =>
      ctx.db.system.query("_storage").collect(),
    );
    expect(files).toHaveLength(1);
  });
});
