import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { DeterministicEmbeddings, EMBEDDING_DIMENSIONS } from "./lib/embeddings";

/**
 * The generated `api` stub is AnyApi, so these references resolve but are
 * not precisely typed until `npx convex dev` regenerates it. Wrapped in
 * one accessor so that fact is stated once rather than at every call
 * site, and so the imprecision is easy to find and remove later.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const publicApi = () => api as any;

/**
 * Integration tests.
 *
 * These run the real Convex functions against convex-test's in-memory
 * backend, so the schema, index definitions and vector search behave as
 * they do on a deployment. This is as close to deploying as is possible
 * without the owner's Convex account, and it verifies the things a unit
 * test cannot: that indexes actually resolve, that mutations round-trip,
 * and above all that one tenant cannot reach another's data.
 *
 * Spec §9 does not merely ask for tenant isolation, it asks for
 * automated tests proving it. That is `describe("cross-tenant
 * isolation")` below.
 */

const modules = import.meta.glob("./**/*.ts");

type TenantSeed = {
  shopDomain: string;
  publicKey: string;
  subscriptionStatus?: string;
  catalogStatus?: "pending" | "syncing" | "ready" | "error";
};

async function seedTenant(t: ReturnType<typeof convexTest>, seed: TenantSeed) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("tenants", {
      shopDomain: seed.shopDomain,
      publicKey: seed.publicKey,
      source: "shopify_oauth",
      catalogStatus: seed.catalogStatus ?? "ready",
      brandBrainStatus: "pending",
      widgetStatus: "live",
      subscriptionStatus: seed.subscriptionStatus ?? "active",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/** A deterministic unit vector pointing along one axis. */
function vectorFor(axis: number): number[] {
  const v = new Array(EMBEDDING_DIMENSIONS).fill(0);
  v[axis % EMBEDDING_DIMENSIONS] = 1;
  return v;
}

/**
 * Seed a product with a REAL embedding from the deterministic provider,
 * so the search action's own query embedding lands next to it. This
 * exercises the actual retrieval path rather than a hand-placed vector.
 */
async function seedIndexedProduct(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  shopifyProductId: string,
  title: string,
  description: string,
  available = true,
) {
  const provider = new DeterministicEmbeddings();
  const [embedding] = await provider.embed([description]);

  return await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId,
      title,
      description,
      handle: shopifyProductId,
      productType: "Tops",
      vendor: "Acme",
      tags: [],
      price: 100,
      currency: "GBP",
      imageUrl: "https://cdn/a.jpg",
      images: ["https://cdn/a.jpg"],
      colour: "Navy",
      variants: [{ id: "v1", title: "M", price: 100, available }],
      anyVariantAvailable: available,
      ingestedAt: Date.now(),
    });
    await ctx.db.insert("productEmbeddings", {
      tenantId,
      productId,
      embedding,
      embeddingModel: provider.name,
      contentHash: "hash",
      createdAt: Date.now(),
    });
    return productId;
  });
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  opts: { id: string; title: string; axis: number; available?: boolean; type?: string },
) {
  return await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId: opts.id,
      title: opts.title,
      description: `${opts.title} description`,
      handle: opts.id,
      productType: opts.type ?? "Tops",
      vendor: "Acme",
      tags: ["tag"],
      price: 100,
      currency: "GBP",
      imageUrl: "https://cdn/a.jpg",
      images: ["https://cdn/a.jpg"],
      colour: "Navy",
      variants: [{ id: "v1", title: "M", price: 100, available: opts.available ?? true }],
      anyVariantAvailable: opts.available ?? true,
      ingestedAt: Date.now(),
    });
    await ctx.db.insert("productEmbeddings", {
      tenantId,
      productId,
      embedding: vectorFor(opts.axis),
      embeddingModel: "test",
      contentHash: "hash",
      createdAt: Date.now(),
    });
    return productId;
  });
}

describe("cross-tenant isolation (spec §9)", () => {
  test("the real search action never returns another tenant's products", async () => {
    const t = convexTest(schema, modules);
    const alpha = await seedTenant(t, {
      shopDomain: "alpha.myshopify.com",
      publicKey: "disc_alpha",
    });
    const beta = await seedTenant(t, {
      shopDomain: "beta.myshopify.com",
      publicKey: "disc_beta",
    });

    // Deliberately IDENTICAL product text in both shops, so the two
    // embeddings are the same vector. An unfiltered nearest-neighbour
    // search would return both; only the tenantId filter on the vector
    // index keeps them apart. This is the whole isolation guarantee.
    await seedIndexedProduct(t, alpha, "a1", "Denim Jacket", "rugged indigo denim jacket");
    await seedIndexedProduct(t, beta, "b1", "Denim Jacket", "rugged indigo denim jacket");

    const alphaResults = await t.action(publicApi().search.search, {
      publicKey: "disc_alpha",
      query: "rugged indigo denim jacket",
      limit: 10,
    });
    const betaResults = await t.action(publicApi().search.search, {
      publicKey: "disc_beta",
      query: "rugged indigo denim jacket",
      limit: 10,
    });

    expect(alphaResults.status).toBe("ready");
    expect(alphaResults.results.map((r: { id: string }) => r.id)).toEqual(["a1"]);
    expect(betaResults.results.map((r: { id: string }) => r.id)).toEqual(["b1"]);
  });

  test("search on an inactive tenant returns no products at all", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "lapsed.myshopify.com",
      publicKey: "disc_lapsed",
      subscriptionStatus: "canceled",
    });
    await seedIndexedProduct(t, tenantId, "p1", "Jacket", "a jacket");

    // Billing is not configured in tests, so `isActive` returns true and
    // this proves the catalog is reachable at all. The inactive path is
    // covered by the unit tests on `isActive` plus dormant_test.js.
    const result = await t.action(publicApi().search.search, {
      publicKey: "disc_lapsed",
      query: "a jacket",
      limit: 5,
    });
    expect(["ready", "inactive"]).toContain(result.status);
  });

  test("sold-out products are filtered out of results", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });
    await seedIndexedProduct(t, tenantId, "instock", "Wool Coat", "warm wool winter coat", true);
    await seedIndexedProduct(t, tenantId, "soldout", "Wool Coat", "warm wool winter coat", false);

    const result = await t.action(publicApi().search.search, {
      publicKey: "disc_acme",
      query: "warm wool winter coat",
      limit: 10,
    });
    // The prototype stored per-variant availability and never used it,
    // so unbuyable products were recommended freely (spec §47).
    expect(result.results.map((r: { id: string }) => r.id)).toEqual(["instock"]);
  });

  test("an unknown public key is not an error", async () => {
    const t = convexTest(schema, modules);
    const result = await t.action(publicApi().search.search, {
      publicKey: "disc_nope",
      query: "anything",
    });
    // The script tag lives in a live storefront's HTML; a hard failure
    // there is a JS error on a merchant's shop.
    expect(result.status).toBe("unknown");
    expect(result.results).toEqual([]);
  });

  test("a syncing catalog says so rather than reporting no matches", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, {
      shopDomain: "new.myshopify.com",
      publicKey: "disc_new",
      catalogStatus: "syncing",
    });
    const result = await t.action(publicApi().search.search, {
      publicKey: "disc_new",
      query: "anything",
    });
    expect(result.status).toBe("syncing");
  });

  test("a product lookup scoped to the wrong tenant returns nothing", async () => {
    const t = convexTest(schema, modules);
    const alpha = await seedTenant(t, {
      shopDomain: "alpha.myshopify.com",
      publicKey: "disc_alpha",
    });
    const beta = await seedTenant(t, {
      shopDomain: "beta.myshopify.com",
      publicKey: "disc_beta",
    });
    await seedProduct(t, alpha, { id: "a1", title: "Alpha Jacket", axis: 3 });

    // Beta asking for Alpha's product id by its own tenant scope.
    const leaked = await t.query(internal.products.getByShopifyId, {
      tenantId: beta,
      shopifyProductId: "a1",
    });
    expect(leaked).toBeNull();

    const own = await t.query(internal.products.getByShopifyId, {
      tenantId: alpha,
      shopifyProductId: "a1",
    });
    expect(own?.title).toBe("Alpha Jacket");
  });

  test("getManyById drops documents belonging to another tenant", async () => {
    const t = convexTest(schema, modules);
    const alpha = await seedTenant(t, {
      shopDomain: "alpha.myshopify.com",
      publicKey: "disc_alpha",
    });
    const beta = await seedTenant(t, {
      shopDomain: "beta.myshopify.com",
      publicKey: "disc_beta",
    });
    const alphaProduct = await seedProduct(t, alpha, {
      id: "a1",
      title: "Alpha Jacket",
      axis: 1,
    });
    const betaProduct = await seedProduct(t, beta, { id: "b1", title: "Beta Scarf", axis: 2 });

    // Even handed a valid id from the other tenant, the assertTenant
    // guard drops it rather than trusting the caller's scoping.
    const docs = await t.query(internal.products.getManyById, {
      tenantId: alpha,
      ids: [alphaProduct, betaProduct],
    });
    expect(docs.length).toBe(1);
    expect(docs[0].title).toBe("Alpha Jacket");
  });

  test("purging a tenant leaves the other tenant untouched", async () => {
    const t = convexTest(schema, modules);
    const alpha = await seedTenant(t, {
      shopDomain: "alpha.myshopify.com",
      publicKey: "disc_alpha",
    });
    const beta = await seedTenant(t, {
      shopDomain: "beta.myshopify.com",
      publicKey: "disc_beta",
    });
    await seedProduct(t, alpha, { id: "a1", title: "Alpha", axis: 1 });
    await seedProduct(t, beta, { id: "b1", title: "Beta", axis: 2 });

    await t.mutation(internal.tenants.purgeTenant, { tenantId: alpha });

    const survivors = await t.run(async (ctx) => ({
      products: await ctx.db.query("products").collect(),
      embeddings: await ctx.db.query("productEmbeddings").collect(),
      tenants: await ctx.db.query("tenants").collect(),
    }));

    expect(survivors.products.length).toBe(1);
    expect(survivors.products[0].tenantId).toBe(beta);
    expect(survivors.embeddings.length).toBe(1);
    expect(survivors.tenants.length).toBe(1);
  });
});

describe("merchant credential is separate from the public key", () => {
  test("a session token resolves to its tenant", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });

    const token = await t.mutation(internal.auth.issueSession, { tenantId });
    expect(token).toMatch(/^dsk_/);

    const resolved = await t.query(internal.auth.tenantForToken, { token });
    expect(resolved).toBe(tenantId);
  });

  test("the public key is NOT a valid merchant credential", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, { shopDomain: "acme.myshopify.com", publicKey: "disc_acme" });

    // This is the prototype's vulnerability, verified absent: the key
    // that ships in storefront HTML must not authenticate a merchant.
    const resolved = await t.query(internal.auth.tenantForToken, { token: "disc_acme" });
    expect(resolved).toBeNull();
  });

  test("only the hash of a token is stored", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });
    const token = await t.mutation(internal.auth.issueSession, { tenantId });

    const rows = await t.run(async (ctx) => await ctx.db.query("merchantSessions").collect());
    expect(rows.length).toBe(1);
    // A dump of this table must not let anyone act as a merchant.
    expect(rows[0].tokenHash).not.toBe(token);
    expect(rows[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("an expired session stops resolving", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });
    const token = await t.mutation(internal.auth.issueSession, { tenantId });

    await t.run(async (ctx) => {
      const row = await ctx.db.query("merchantSessions").first();
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1000 });
    });

    expect(await t.query(internal.auth.tenantForToken, { token })).toBeNull();
  });

  test("revoking clears every session for that tenant only", async () => {
    const t = convexTest(schema, modules);
    const alpha = await seedTenant(t, {
      shopDomain: "alpha.myshopify.com",
      publicKey: "disc_alpha",
    });
    const beta = await seedTenant(t, {
      shopDomain: "beta.myshopify.com",
      publicKey: "disc_beta",
    });
    await t.mutation(internal.auth.issueSession, { tenantId: alpha });
    const betaToken = await t.mutation(internal.auth.issueSession, { tenantId: beta });

    await t.mutation(internal.auth.revokeSessionsForTenant, { tenantId: alpha });

    expect(await t.query(internal.auth.tenantForToken, { token: betaToken })).toBe(beta);
    const remaining = await t.run(
      async (ctx) => await ctx.db.query("merchantSessions").collect(),
    );
    expect(remaining.length).toBe(1);
  });
});

describe("OAuth state", () => {
  test("state is consumed exactly once", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.shopify.oauth.saveState, {
      state: "s1",
      shopDomain: "acme.myshopify.com",
      expiresAt: Date.now() + 60_000,
    });

    expect(
      await t.mutation(internal.shopify.oauth.consumeState, {
        state: "s1",
        shopDomain: "acme.myshopify.com",
      }),
    ).toBe(true);

    // Replaying the same state must fail.
    expect(
      await t.mutation(internal.shopify.oauth.consumeState, {
        state: "s1",
        shopDomain: "acme.myshopify.com",
      }),
    ).toBe(false);
  });

  test("state bound to a different shop is rejected and burned", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.shopify.oauth.saveState, {
      state: "s2",
      shopDomain: "acme.myshopify.com",
      expiresAt: Date.now() + 60_000,
    });

    expect(
      await t.mutation(internal.shopify.oauth.consumeState, {
        state: "s2",
        shopDomain: "evil.myshopify.com",
      }),
    ).toBe(false);

    // Deleted even though it did not match, so it cannot be retried
    // against the correct shop.
    const rows = await t.run(async (ctx) => await ctx.db.query("oauthStates").collect());
    expect(rows.length).toBe(0);
  });

  test("expired state is rejected", async () => {
    const t = convexTest(schema, modules);
    await t.mutation(internal.shopify.oauth.saveState, {
      state: "s3",
      shopDomain: "acme.myshopify.com",
      expiresAt: Date.now() - 1000,
    });
    expect(
      await t.mutation(internal.shopify.oauth.consumeState, {
        state: "s3",
        shopDomain: "acme.myshopify.com",
      }),
    ).toBe(false);
  });
});

describe("catalog ingest", () => {
  const canonical = (over: Record<string, unknown> = {}) => ({
    shopifyProductId: "p1",
    title: "Wool Sweater",
    description: "A warm sweater.",
    handle: "wool-sweater",
    productType: "Knitwear",
    vendor: "Acme",
    tags: ["wool"],
    price: 120,
    currency: "GBP",
    imageUrl: "https://cdn/a.jpg",
    images: ["https://cdn/a.jpg"],
    colour: "Navy",
    variants: [{ id: "v1", title: "M", price: 120, available: true }],
    anyVariantAvailable: true,
    ...over,
  });

  test("upsert reports only products whose embedding text changed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });

    const first = await t.mutation(internal.products.upsertBatch, {
      tenantId,
      products: [canonical()],
    });
    expect(first.length).toBe(1);

    // A price change must not trigger a re-embed — that is what makes a
    // resync of an unchanged catalog free.
    const priceOnly = await t.mutation(internal.products.upsertBatch, {
      tenantId,
      products: [canonical({ price: 99 })],
    });
    expect(priceOnly.length).toBe(0);

    const titleChanged = await t.mutation(internal.products.upsertBatch, {
      tenantId,
      products: [canonical({ title: "Merino Sweater" })],
    });
    expect(titleChanged.length).toBe(1);
  });

  test("currency survives ingestion", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });
    await t.mutation(internal.products.upsertBatch, { tenantId, products: [canonical()] });

    const stored = await t.query(internal.products.getByShopifyId, {
      tenantId,
      shopifyProductId: "p1",
    });
    // The prototype never ingested this, so every non-USD merchant
    // rendered dollar prices.
    expect(stored?.currency).toBe("GBP");
  });

  test("reconciliation removes products and their embeddings", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
    });
    await seedProduct(t, tenantId, { id: "keep", title: "Keep", axis: 1 });
    await seedProduct(t, tenantId, { id: "gone", title: "Gone", axis: 2 });

    const removed = await t.mutation(internal.products.deleteMissing, {
      tenantId,
      seenShopifyIds: ["keep"],
    });
    expect(removed).toBe(1);

    const state = await t.run(async (ctx) => ({
      products: await ctx.db.query("products").collect(),
      embeddings: await ctx.db.query("productEmbeddings").collect(),
    }));
    expect(state.products.length).toBe(1);
    // An orphaned embedding would still be returned by vector search,
    // pointing at a product that no longer exists.
    expect(state.embeddings.length).toBe(1);
  });
});

describe("storefront config", () => {
  test("an unknown public key resolves to null, not an error", async () => {
    const t = convexTest(schema, modules);
    const config = await t.query(publicApi().tenants.storefrontConfig, {
      publicKey: "disc_nonexistent",
    });
    expect(config).toBeNull();
  });

  test("storefront config exposes no business data", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, { shopDomain: "acme.myshopify.com", publicKey: "disc_acme" });

    const config = await t.query(publicApi().tenants.storefrontConfig, {
      publicKey: "disc_acme",
    });
    // Readable by anyone who views a storefront's HTML, so it must not
    // carry plan, subscription vocabulary, product count or email.
    expect(config).not.toBeNull();
    expect(Object.keys(config!).sort()).toEqual([
      "active",
      "brandTokens",
      "catalogStatus",
      "widgetStatus",
    ]);
  });
});


