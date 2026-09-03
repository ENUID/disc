import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { emptyProfile } from "./lib/fashion-profile";

/**
 * Catalog health aggregates (P1.6), against the real runtime.
 *
 * Two things need proving, and they are different:
 *
 *   CORRECTNESS  the maintained counters equal what the old
 *                implementation computed, across every lifecycle path
 *
 *   COST         `catalogHealth` does not read the embedding corpus
 *
 * The second cannot be shown by timing — that is flaky and proves
 * nothing about which rows were read. Instead these tests DESYNCHRONISE
 * the embeddings table from the counter and assert which one
 * `catalogHealth` reports. If it read embeddings, the answer changes.
 */

const modules = import.meta.glob("./**/*.ts");

async function seedTenant(t: ReturnType<typeof convexTest>, slug = "acme") {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain: `${slug}.myshopify.com`,
      publicKey: `disc_${slug}`,
      accessTokenCipher: "cipher",
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

type ProductSpec = {
  id: string;
  available?: boolean;
  images?: string[];
};

function productDoc(spec: ProductSpec) {
  return {
    shopifyProductId: spec.id,
    title: spec.id,
    description: "d",
    handle: spec.id,
    productType: "Tops",
    vendor: "Acme",
    tags: [],
    price: 100,
    currency: "GBP",
    imageUrl: spec.images?.[0] ?? "https://cdn/a.jpg",
    images: spec.images ?? ["https://cdn/a.jpg"],
    colour: "",
    variants: [{ id: "v1", title: "M", price: 100, available: spec.available ?? true }],
    anyVariantAvailable: spec.available ?? true,
  };
}

/** Everything goes through the real lifecycle mutations. */
async function upsert(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  specs: ProductSpec[],
) {
  await t.mutation(internal.products.upsertBatch, {
    tenantId,
    products: specs.map(productDoc),
  });
}

async function productIdOf(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  shopifyProductId: string,
): Promise<Id<"products">> {
  const doc = await t.query(internal.products.getByShopifyId, {
    tenantId,
    shopifyProductId,
  });
  return doc!._id;
}

async function embed(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  productIds: Id<"products">[],
  dimensions = 8,
) {
  await t.mutation(internal.products.saveEmbeddings, {
    tenantId,
    model: "test",
    entries: productIds.map((productId) => ({
      productId,
      embedding: new Array(dimensions).fill(0.1),
      contentHash: `${productId}`,
    })),
  });
}

async function enrich(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  productId: Id<"products">,
  over: { completeness?: number; rejectedFields?: string[] } = {},
) {
  await t.mutation(internal.enrichment.saveProfile, {
    tenantId,
    productId,
    profile: emptyProfile(),
    provenance: {},
    completeness: over.completeness ?? 0.9,
    cacheKey: `${productId}-${over.completeness ?? 0.9}`,
    rejectedFields: over.rejectedFields ?? [],
  });
}

const health = (t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) =>
  t.query(internal.merchant.catalogHealth, { tenantId });

/** Delete every embedding row, leaving the counters untouched. */
async function dropAllEmbeddings(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const rows = await ctx.db.query("productEmbeddings").collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length;
  });
}

// =====================================================================

describe("catalogHealth does not read the embedding corpus", () => {
  test("indexed survives the embedding rows being deleted underneath it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await upsert(t, tenantId, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    await embed(t, tenantId, [
      await productIdOf(t, tenantId, "a"),
      await productIdOf(t, tenantId, "b"),
    ]);
    expect((await health(t, tenantId)).indexed).toBe(2);

    // THE INSTRUMENT. Deliberately desynchronise the corpus from the
    // counter: delete every embedding row without touching the tenant.
    // The old implementation derived `indexed` by collecting this table,
    // so it would now answer 0. Reading the maintained counter answers 2.
    //
    // This is a structural proof of WHICH TABLE IS READ, which is what
    // the invariant is about. A timing assertion would prove neither
    // that, nor anything stable.
    expect(await dropAllEmbeddings(t)).toBe(2);
    expect((await health(t, tenantId)).indexed).toBe(2);
  });

  test("a 5,000-product catalog answers from counters alone", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // The scale at which the old implementation broke: ~12 KB per
    // embedding row meant ~60 MB read to produce eight integers, past
    // Convex's per-query read limit — so the Catalog page failed for the
    // largest paying tenants.
    const TOTAL = 5000;
    const BATCH = 500;
    for (let start = 0; start < TOTAL; start += BATCH) {
      await upsert(
        t,
        tenantId,
        Array.from({ length: BATCH }, (_, i) => ({
          id: `p${start + i}`,
          // Every tenth product out of stock, every twentieth imageless.
          available: (start + i) % 10 !== 0,
          images: (start + i) % 20 === 0 ? [] : undefined,
        })),
      );
    }

    const first = await health(t, tenantId);
    expect(first.total).toBe(TOTAL);
    expect(first.unavailable).toBe(TOTAL / 10);
    expect(first.missingImages).toBe(TOTAL / 20);
    expect(first.indexed).toBe(0);

    // Index a third of them, then desynchronise as above.
    const ids: Id<"products">[] = [];
    for (let i = 0; i < 1500; i++) ids.push(await productIdOf(t, tenantId, `p${i}`));
    for (let start = 0; start < ids.length; start += 250) {
      await embed(t, tenantId, ids.slice(start, start + 250));
    }
    expect((await health(t, tenantId)).indexed).toBe(1500);

    expect(await dropAllEmbeddings(t)).toBe(1500);
    const after = await health(t, tenantId);
    expect(after.indexed).toBe(1500);
    expect(after.total).toBe(TOTAL);
  }, 120_000);
});

describe("counters match the old semantics", () => {
  test("indexed and enriched are counted separately", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await upsert(t, tenantId, [
      { id: "full" },
      { id: "thin" },
      { id: "bare" },
      { id: "unindexed" },
    ]);
    for (const id of ["full", "thin", "bare"]) {
      await embed(t, tenantId, [await productIdOf(t, tenantId, id)]);
    }
    await enrich(t, tenantId, await productIdOf(t, tenantId, "full"), {
      completeness: 0.9,
    });
    await enrich(t, tenantId, await productIdOf(t, tenantId, "thin"), {
      completeness: 0.2,
    });

    const result = await health(t, tenantId);
    expect(result).toMatchObject({
      total: 4,
      indexed: 3,
      enriched: 2,
      notEnriched: 2,
      lowConfidence: 1,
    });
  });

  test("a zero-product tenant reports zeroes", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    expect(await health(t, tenantId)).toMatchObject({
      total: 0,
      indexed: 0,
      enriched: 0,
      notEnriched: 0,
    });
  });

  test("a fully embedded, fully enriched catalog", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }, { id: "b" }]);
    for (const id of ["a", "b"]) {
      const pid = await productIdOf(t, tenantId, id);
      await embed(t, tenantId, [pid]);
      await enrich(t, tenantId, pid);
    }
    expect(await health(t, tenantId)).toMatchObject({
      total: 2,
      indexed: 2,
      enriched: 2,
      notEnriched: 0,
      lowConfidence: 0,
    });
  });

  test("what a merchant needs to fix", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [
      { id: "gone", available: false },
      { id: "no-image", images: [] },
      { id: "odd" },
    ]);
    await enrich(t, tenantId, await productIdOf(t, tenantId, "odd"), {
      rejectedFields: ["garment"],
    });

    expect(await health(t, tenantId)).toMatchObject({
      unavailable: 1,
      missingImages: 1,
      rejectedFields: 1,
    });
  });
});

describe("lifecycle transitions", () => {
  test("deleting a product removes everything it contributed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a", available: false, images: [] }, { id: "b" }]);
    const a = await productIdOf(t, tenantId, "a");
    await embed(t, tenantId, [a]);
    await enrich(t, tenantId, a, { completeness: 0.2, rejectedFields: ["fit"] });

    expect(await health(t, tenantId)).toMatchObject({
      total: 2,
      indexed: 1,
      enriched: 1,
      lowConfidence: 1,
      rejectedFields: 1,
      unavailable: 1,
      missingImages: 1,
    });

    await t.mutation(internal.products.deleteByShopifyId, {
      tenantId,
      shopifyProductId: "a",
    });

    // A deleted product must not remain counted anywhere — including in
    // the counters derived from its profile, which the delete path does
    // not itself remove.
    expect(await health(t, tenantId)).toMatchObject({
      total: 1,
      indexed: 0,
      enriched: 0,
      lowConfidence: 0,
      rejectedFields: 0,
      unavailable: 0,
      missingImages: 0,
    });
  });

  test("reconciliation removes products missing from the source catalog", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "keep" }, { id: "drop1" }, { id: "drop2" }]);
    await embed(t, tenantId, [await productIdOf(t, tenantId, "drop1")]);

    await t.mutation(internal.products.deleteMissing, {
      tenantId,
      seenShopifyIds: ["keep"],
    });

    expect(await health(t, tenantId)).toMatchObject({ total: 1, indexed: 0 });
  });

  test("re-embedding the same product does not double count", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }]);
    const a = await productIdOf(t, tenantId, "a");

    // The retry case: an embedding job that runs three times.
    await embed(t, tenantId, [a]);
    await embed(t, tenantId, [a]);
    await embed(t, tenantId, [a]);

    expect((await health(t, tenantId)).indexed).toBe(1);
  });

  test("re-enriching does not double count, but does move confidence", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }]);
    const a = await productIdOf(t, tenantId, "a");

    await enrich(t, tenantId, a, { completeness: 0.2, rejectedFields: ["fit"] });
    expect(await health(t, tenantId)).toMatchObject({
      enriched: 1,
      lowConfidence: 1,
      rejectedFields: 1,
    });

    // A better second pass. `enriched` must not increment again, but
    // `lowConfidence` and `rejectedFields` must both clear.
    await enrich(t, tenantId, a, { completeness: 0.95, rejectedFields: [] });
    expect(await health(t, tenantId)).toMatchObject({
      enriched: 1,
      lowConfidence: 0,
      rejectedFields: 0,
    });
  });

  test("re-upserting an unchanged catalog changes nothing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const specs = [{ id: "a" }, { id: "b", available: false }];

    await upsert(t, tenantId, specs);
    await embed(t, tenantId, [await productIdOf(t, tenantId, "a")]);
    const before = await health(t, tenantId);

    // The six-hourly resync of an unchanged catalog.
    await upsert(t, tenantId, specs);
    await upsert(t, tenantId, specs);

    expect(await health(t, tenantId)).toEqual(before);
  });

  test("a product going out of stock and back is tracked in both directions", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }]);
    expect((await health(t, tenantId)).unavailable).toBe(0);

    await upsert(t, tenantId, [{ id: "a", available: false }]);
    expect((await health(t, tenantId)).unavailable).toBe(1);

    await upsert(t, tenantId, [{ id: "a", available: true }]);
    expect((await health(t, tenantId)).unavailable).toBe(0);
  });

  test("updating an indexed product keeps it indexed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }]);
    await embed(t, tenantId, [await productIdOf(t, tenantId, "a")]);

    // A price or availability edit must not make the product look
    // un-indexed — `db.patch` merges, so `embeddedAt` survives.
    await upsert(t, tenantId, [{ id: "a", available: false }]);
    expect((await health(t, tenantId)).indexed).toBe(1);
  });
});

describe("reconciliation", () => {
  test("drift is detected, reported and corrected", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }, { id: "b" }, { id: "c" }]);
    await embed(t, tenantId, [await productIdOf(t, tenantId, "a")]);
    await enrich(t, tenantId, await productIdOf(t, tenantId, "b"), {
      completeness: 0.1,
    });

    // Corrupt the counters the way a bug in a lifecycle path would.
    await t.run(async (ctx) => {
      await ctx.db.patch(tenantId, {
        productCount: 99,
        embeddedCount: 0,
        enrichedCount: 42,
        lowConfidenceCount: 7,
      });
    });

    const result = await t.action(internal.catalog.reconcileTenant, { tenantId });

    // Reported per field, not silently healed — the drift is evidence of
    // a bug somewhere, and hiding it would hide the bug.
    const fields = result.drift.map((d: { field: string }) => d.field).sort();
    expect(fields).toEqual([
      "embeddedCount",
      "enrichedCount",
      "lowConfidenceCount",
      "productCount",
    ]);

    expect(await health(t, tenantId)).toMatchObject({
      total: 3,
      indexed: 1,
      enriched: 1,
      lowConfidence: 1,
    });
  });

  test("a lifecycle write that skipped the counter is caught and corrected", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }]);

    // Simulates a counter update that did not happen — the shape of a bug
    // in a lifecycle path, or of rows written before this phase existed.
    // Inserted directly, so no delta is applied.
    await t.run(async (ctx) => {
      await ctx.db.insert("products", {
        tenantId,
        shopifyProductId: "ghost",
        title: "ghost",
        description: "d",
        handle: "ghost",
        productType: "Tops",
        tags: [],
        price: 100,
        currency: "GBP",
        imageUrl: "",
        images: [],
        colour: "",
        variants: [],
        anyVariantAvailable: false,
        ingestedAt: Date.now(),
        embeddedAt: Date.now(),
      });
    });

    // The dashboard is wrong until the sweep runs — inherent to a
    // maintained aggregate, and the reason the sweep exists.
    expect((await health(t, tenantId)).total).toBe(1);

    const result = await t.action(internal.catalog.reconcileTenant, { tenantId });
    expect(result.drift.map((d: { field: string }) => d.field).sort()).toEqual([
      "embeddedCount",
      "missingImagesCount",
      "productCount",
      "unavailableCount",
    ]);
    expect(await health(t, tenantId)).toMatchObject({
      total: 2,
      indexed: 1,
      unavailable: 1,
      missingImages: 1,
    });
  });

  test("work that never completed leaves its counters untouched", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }, { id: "b" }]);

    // Enrichment and embedding that failed never call their save
    // mutations at all — `enrichBatch` catches per-product failures and
    // leaves the stale cache key for the next pass. So a failure must
    // read as "not yet done", never as done.
    const result = await health(t, tenantId);
    expect(result).toMatchObject({
      total: 2,
      indexed: 0,
      enriched: 0,
      notEnriched: 2,
      lowConfidence: 0,
      rejectedFields: 0,
    });

    // And the rebuild agrees, so a failed job cannot show as complete
    // after the nightly sweep either.
    const reconciled = await t.action(internal.catalog.reconcileTenant, { tenantId });
    expect(reconciled.drift).toEqual([]);
  });

  test("reconciling correct counters reports no drift", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a", available: false }, { id: "b", images: [] }]);
    await embed(t, tenantId, [await productIdOf(t, tenantId, "b")]);
    await enrich(t, tenantId, await productIdOf(t, tenantId, "a"));

    // The maintained counters and the rebuild must agree, or the nightly
    // sweep would "correct" correct numbers and report phantom drift
    // every night.
    const result = await t.action(internal.catalog.reconcileTenant, { tenantId });
    expect(result.drift).toEqual([]);
  });

  test("reconciliation pages through a large catalog", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    for (let start = 0; start < 1200; start += 400) {
      await upsert(
        t,
        tenantId,
        Array.from({ length: 400 }, (_, i) => ({
          id: `p${start + i}`,
          available: (start + i) % 4 !== 0,
        })),
      );
    }
    await t.run(async (ctx) => ctx.db.patch(tenantId, { productCount: 0 }));

    // Small pages, so the loop is genuinely exercised rather than
    // completing in one.
    const result = await t.action(internal.catalog.reconcileTenant, {
      tenantId,
      pageSize: 100,
    });

    expect(result.counts.productCount).toBe(1200);
    expect(result.counts.unavailableCount).toBe(300);
  }, 120_000);

  test("an orphaned profile is not counted as enriched", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await upsert(t, tenantId, [{ id: "a" }, { id: "b" }]);
    const a = await productIdOf(t, tenantId, "a");
    await enrich(t, tenantId, a);

    // The delete path leaves the profile behind — pre-existing, and a
    // storage leak rather than a counting bug. Reconciliation walks
    // PRODUCTS and looks profiles up, so an orphan is invisible to it.
    await t.mutation(internal.products.deleteByShopifyId, {
      tenantId,
      shopifyProductId: "a",
    });

    const orphans = await t.run(async (ctx) =>
      (await ctx.db.query("productProfiles").collect()).length,
    );
    expect(orphans).toBe(1);

    const result = await t.action(internal.catalog.reconcileTenant, { tenantId });
    expect(result.drift).toEqual([]);
    expect(result.counts.enrichedCount).toBe(0);
  });

  test("the sweep reconciles the tenants left longest", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");
    await upsert(t, acme, [{ id: "a" }]);
    await upsert(t, other, [{ id: "b" }]);
    for (const id of [acme, other]) {
      await t.run(async (ctx) => ctx.db.patch(id, { productCount: 77 }));
    }

    await t.action(internal.crons.reconcileCatalogCounts, {});

    expect((await health(t, acme)).total).toBe(1);
    expect((await health(t, other)).total).toBe(1);
  });

  test("counters are tenant scoped", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");

    await upsert(t, acme, [{ id: "a" }, { id: "b" }]);
    await upsert(t, other, [{ id: "a" }]);
    await embed(t, acme, [await productIdOf(t, acme, "a")]);

    expect(await health(t, acme)).toMatchObject({ total: 2, indexed: 1 });
    expect(await health(t, other)).toMatchObject({ total: 1, indexed: 0 });
  });
});
