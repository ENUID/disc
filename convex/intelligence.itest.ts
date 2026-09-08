import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { BRAND_SAMPLE_LIMIT, BRAND_SAMPLE_PAGE } from "./brand";
import { enrichmentKey } from "./scheduling";

/**
 * The catalog intelligence lifecycle (P2.2), against the real runtime.
 *
 * These run with no ANTHROPIC_API_KEY, which is not a limitation here —
 * `reasoningProvider` returns `NullReasoningProvider` without one, and it
 * answers `{}` rather than throwing. So every step of the real pipeline
 * executes: the cursor scan, the staleness comparison, `enrichOne`, its
 * deterministic `ruleDerivedProfile` fallback, `saveProfile`, the counter
 * deltas, the window completion and the chain. Only the model's opinion
 * is absent, and none of the properties below depend on it.
 *
 * What they exist to catch is a class of bug that shipped and survived:
 * enrichment that silently stopped after one batch, and a Brand Brain
 * that discarded a merchant's correction six hours later. Neither was
 * covered by a single test before this file.
 */

const modules = import.meta.glob("./**/*.ts");

/**
 * Timers are faked so the enrichment chain — which paces itself with a
 * one-second delay between windows — can be driven to completion, and
 * `Date` deliberately is NOT, so `updatedAt` stays a real signal that a
 * document was written. Freezing the clock would make "nothing was
 * written" true by construction rather than by observation.
 */
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval"],
  });
});
afterEach(() => {
  vi.useRealTimers();
});

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  slug: string,
  productCount: number,
  opts: { titlePrefix?: string } = {},
) {
  return await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      // Hyphens, not underscores: `isValidShopDomain` rejects an
      // underscore, and a domain that fails validation would make these
      // pass for the wrong reason.
      shopDomain: `${slug}.myshopify.com`,
      publicKey: `disc_${slug}`,
      accessTokenCipher: "cipher-should-never-be-exposed",
      scopes: "read_products",
      source: "shopify_oauth" as const,
      catalogStatus: "ready" as const,
      brandBrainStatus: "pending" as const,
      widgetStatus: "inactive" as const,
      subscriptionStatus: "active",
      productCount,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const prefix = opts.titlePrefix ?? "Linen Shirt";
    for (let i = 0; i < productCount; i++) {
      await ctx.db.insert("products", {
        tenantId,
        shopifyProductId: `${slug}-p${i}`,
        title: `${prefix} ${i}`,
        description: `A ${prefix.toLowerCase()} number ${i}.`,
        handle: `${slug}-product-${i}`,
        productType: "Shirt",
        tags: ["shirt"],
        price: 100 + (i % 50),
        currency: "GBP",
        imageUrl: "",
        images: [],
        colour: "black",
        variants: [],
        anyVariantAvailable: true,
        ingestedAt: Date.now(),
      });
    }
    return tenantId;
  });
}

/** How many products still lack a current profile, counted directly. */
async function unenrichedCount(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
): Promise<number> {
  // `.collect()` + filter rather than `.withIndex`: `ReturnType<typeof
  // convexTest>` drops the schema type parameter, so index names do not
  // typecheck inside a helper declared that way. Same approach as
  // `privacy.itest.ts`, and at test scale the read is trivial.
  return await t.run(async (ctx) => {
    const products = (await ctx.db.query("products").collect()).filter(
      (p) => p.tenantId === tenantId,
    );
    const profiled = new Set(
      (await ctx.db.query("productProfiles").collect())
        .filter((r) => r.tenantId === tenantId)
        .map((r) => r.productId as string),
    );
    return products.filter((p) => !profiled.has(p._id as string)).length;
  });
}

async function sweepState(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return await t.query(internal.enrichment.sweepState, { tenantId });
}

async function tenantRow(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("tenants").collect()).find((x) => x._id === tenantId),
  );
}

async function jobsOfType(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  type: string,
) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("jobs").collect()).filter(
      (j) => j.tenantId === tenantId && j.type === type,
    ),
  );
}

async function countersAndProfiles(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
) {
  return await t.run(async (ctx) => {
    const tenant = (await ctx.db.query("tenants").collect()).find(
      (x) => x._id === tenantId,
    );
    const profiles = (await ctx.db.query("productProfiles").collect()).filter(
      (r) => r.tenantId === tenantId,
    );
    return { enrichedCount: tenant!.enrichedCount, profiles: profiles.length };
  });
}

async function cacheKeyOf(t: ReturnType<typeof convexTest>, productId: Id<"products">) {
  return await t.run(async (ctx) => {
    const profile = (await ctx.db.query("productProfiles").collect()).find(
      (r) => (r.productId as string) === (productId as string),
    );
    return profile!.cacheKey;
  });
}

/**
 * Drive enrichment windows until the sweep completes.
 *
 * The window action is invoked directly rather than through the scheduler
 * so the test controls the pump and can count invocations — but it is the
 * real action, so the cursor, the chaining enqueue and the completion
 * mutation all run exactly as they do in production.
 */
async function runSweep(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
): Promise<void> {
  await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });
  await settle(t);
}

/**
 * Run the scheduler to a standstill.
 *
 * The whole chain is driven this way rather than by calling the window
 * action in a loop: the chain IS the production mechanism, and a test
 * that pumped it by hand would prove the window works while saying
 * nothing about whether one window actually reaches the next. It also
 * settles the Brand Brain build a completed sweep enqueues.
 */
async function settle(t: ReturnType<typeof convexTest>): Promise<void> {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 5000);
}

describe("enrichment discovery and scale", () => {
  test("a 25-product catalog enriches completely", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-small", 25);

    await runSweep(t, tenantId);

    expect(await unenrichedCount(t, tenantId)).toBe(0);
  });

  test("a 500-product catalog enriches completely", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-large", 500);

    // THE REGRESSION. Before P2.2 this stopped at 25: the scan re-read
    // the front of the index with no cursor, and `remaining` was inferred
    // from a second front-of-index probe that returned nothing as soon as
    // the first four products were enriched. Coverage stuck at 0.05, and
    // `canDeriveBrand` refuses below 0.3 — so the Brand Brain never built
    // for any catalog worth having one.
    await runSweep(t, tenantId);

    expect(await unenrichedCount(t, tenantId)).toBe(0);
  }, 120000);

  test("every window makes forward progress, and the sweep terminates", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-progress", 200);

    let previous = await unenrichedCount(t, tenantId);
    expect(previous).toBe(200);

    // Pumped one window at a time here specifically to watch each step,
    // rather than through the scheduler as everywhere else.
    let windows = 0;
    for (; windows < 100; windows++) {
      const outcome = await t.action(internal.enrichment.runEnrichmentWindow, {
        tenantId,
      });
      const now = await unenrichedCount(t, tenantId);
      // Never goes backwards, and never stalls while work remains.
      expect(now).toBeLessThan(previous);
      previous = now;
      if (now === 0 || outcome.sweepComplete) break;
    }

    expect(previous).toBe(0);
    // 200 products at 25 per window: the sweep must not need materially
    // more passes than the work requires.
    expect(windows).toBeLessThanOrEqual(10);
  });

  test("a scan is bounded regardless of catalog size", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-bounded", 2000);

    // "Does not require an unbounded request": one scan reads one page,
    // whatever the catalog holds behind it. This is the property that
    // keeps a large catalog off the read limit, and it is asserted rather
    // than argued.
    const scan = await t.query(internal.enrichment.scanForEnrichment, {
      tenantId,
      cursor: null,
      model: "null-provider",
    });
    expect(scan.scanned).toBeLessThanOrEqual(200);
    expect(scan.pageIsLast).toBe(false);
    expect(scan.staleIds.length).toBeLessThanOrEqual(25);
  }, 60000);

  test("remaining is counted from the page, never inferred", async () => {
    const t = convexTest(schema, modules);

    // Empty catalog.
    const empty = await seedTenant(t, "brand-empty", 0);
    let scan = await t.query(internal.enrichment.scanForEnrichment, {
      tenantId: empty,
      cursor: null,
      model: "null-provider",
    });
    expect(scan.staleIds).toEqual([]);
    expect(scan.remainingInPage).toBe(0);
    expect(scan.pageIsLast).toBe(true);

    // Fewer products than one batch.
    const under = await seedTenant(t, "brand-under", 10);
    scan = await t.query(internal.enrichment.scanForEnrichment, {
      tenantId: under,
      cursor: null,
      model: "null-provider",
    });
    expect(scan.staleIds.length).toBe(10);
    expect(scan.remainingInPage).toBe(0);
    expect(scan.pageIsLast).toBe(true);

    // Exactly one batch.
    const exact = await seedTenant(t, "brand-exact", 25);
    scan = await t.query(internal.enrichment.scanForEnrichment, {
      tenantId: exact,
      cursor: null,
      model: "null-provider",
    });
    expect(scan.staleIds.length).toBe(25);
    expect(scan.remainingInPage).toBe(0);

    // More stale in the page than one batch may enrich. The old code had
    // no way to express this: it probed the front of the index and got a
    // number that had nothing to do with the page it had just processed.
    const over = await seedTenant(t, "brand-over", 120);
    scan = await t.query(internal.enrichment.scanForEnrichment, {
      tenantId: over,
      cursor: null,
      model: "null-provider",
    });
    expect(scan.staleIds.length).toBe(25);
    expect(scan.remainingInPage).toBe(95);
    expect(scan.scanned).toBe(120);
  });
});

describe("edit discovery", () => {
  // The second half of the same root cause: a product outside the
  // front-of-index window could be edited and never re-enriched, because
  // nothing ever scanned past the first hundred products.
  for (const [label, position] of [
    ["at the beginning", 0],
    ["in the middle", 150],
    ["near the end", 299],
  ] as const) {
    test(`an edit ${label} of the catalog is rediscovered`, async () => {
      const t = convexTest(schema, modules);
      const tenantId = await seedTenant(t, `brand-edit-${position}`, 300);

      await runSweep(t, tenantId);
      expect(await unenrichedCount(t, tenantId)).toBe(0);

      // A merchant edits one product. Its content changes, so the stored
      // cache key no longer matches what its content would produce.
      const edited = await t.run(async (ctx) => {
        const products = (await ctx.db.query("products").collect()).filter(
          (p) => p.tenantId === tenantId,
        );
        const target = products[position];
        await ctx.db.patch(target._id, { description: "EDITED BY THE MERCHANT" });
        return target._id;
      });

      const staleAfterEdit = await cacheKeyOf(t, edited);

      await runSweep(t, tenantId);

      const rebuilt = await cacheKeyOf(t, edited);

      expect(rebuilt).not.toBe(staleAfterEdit);
    }, 120000);
  }
});

describe("durable scheduling and idempotency", () => {
  test("duplicate enqueues at the same sweep position collapse to one job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-dupe", 50);

    const first = await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });
    const second = await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });
    const third = await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(third.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);

    const jobs = await jobsOfType(t, tenantId, "product_enrichment");
    expect(jobs.length).toBe(1);
  });

  test("enrichment runs as a real job, and its key advances with the sweep", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-job", 60);

    const enqueued = await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });
    const before = await sweepState(t, tenantId);
    expect(before!.cursor).toBeNull();

    // A job row exists, keyed on where the sweep currently is.
    const job = (await jobsOfType(t, tenantId, "product_enrichment"))[0];
    expect(job.status).toBe("queued");
    expect(job.idempotencyKey).toBe(enrichmentKey(tenantId, 0, null, 0));

    await t.action(internal.enrichment.runEnrichmentWindow, {
      tenantId,
      jobId: enqueued.jobId,
    });

    const finished = (await jobsOfType(t, tenantId, "product_enrichment")).find(
      (j) => j._id === enqueued.jobId,
    );
    expect(finished!.status).toBe("succeeded");

    // The sweep moved, so the next window is different logical work and
    // gets its own job rather than deduplicating into the finished one.
    const after = await sweepState(t, tenantId);
    const next = await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });
    expect(next.jobId).not.toBe(enqueued.jobId);
    expect(next.created).toBe(false); // the window already chained it
    const nextJob = (await jobsOfType(t, tenantId, "product_enrichment")).find(
      (j) => j._id === next.jobId,
    );
    expect(nextJob!.idempotencyKey).toBe(
      enrichmentKey(tenantId, after!.sweep, after!.cursor, after!.sweepEnriched),
    );
  });

  test("every window of a sweep is its own durable job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-chain", 120);

    // 120 products at 25 a window needs five windows. Each one must be a
    // job row — not just the first, with the rest chained by a raw
    // scheduler call that leaves no record and cannot be retried.
    await runSweep(t, tenantId);
    expect(await unenrichedCount(t, tenantId)).toBe(0);

    const jobs = await jobsOfType(t, tenantId, "product_enrichment");
    expect(jobs.length).toBeGreaterThanOrEqual(5);
    expect(jobs.every((j) => j.status === "succeeded")).toBe(true);
    // Every window is distinct logical work, so no two share a key.
    expect(new Set(jobs.map((j) => j.idempotencyKey)).size).toBe(jobs.length);
  }, 60000);

  test("a second execution of the same job is refused, not run twice", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-claim", 40);

    const enqueued = await t.mutation(internal.scheduling.enqueueEnrichment, { tenantId });
    await t.action(internal.enrichment.runEnrichmentWindow, {
      tenantId,
      jobId: enqueued.jobId,
    });

    const enrichedOnce = 40 - (await unenrichedCount(t, tenantId));
    const cursorOnce = (await sweepState(t, tenantId))!;

    // The job is `succeeded`; claiming it again must fail, so the work
    // must not happen a second time and the sweep must not advance twice.
    await t.action(internal.enrichment.runEnrichmentWindow, {
      tenantId,
      jobId: enqueued.jobId,
    });

    expect(40 - (await unenrichedCount(t, tenantId))).toBe(enrichedOnce);
    const cursorTwice = (await sweepState(t, tenantId))!;
    expect(cursorTwice.sweepEnriched).toBe(cursorOnce.sweepEnriched);
  });

  test("re-enriching a product is harmless", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-retry", 10);

    await runSweep(t, tenantId);
    const after = await countersAndProfiles(t, tenantId);

    // A retry re-runs the same window. Profiles are replaced, not
    // duplicated, and the maintained counter does not drift.
    await t.action(internal.enrichment.runEnrichmentWindow, { tenantId });
    await runSweep(t, tenantId);

    const again = await countersAndProfiles(t, tenantId);

    expect(again.profiles).toBe(after.profiles);
    expect(again.enrichedCount).toBe(after.enrichedCount);
  });
});

describe("Brand Brain triggers and merchant authority", () => {
  /** Enrich enough of a catalog that `canDeriveBrand` is satisfied. */
  async function readyBrand(t: ReturnType<typeof convexTest>, slug: string, n = 40) {
    const tenantId = await seedTenant(t, slug, n);
    // Completing a sweep that enriched something enqueues a build, and
    // `runSweep` flushes it. So by the time this returns the tenant has
    // the brain the REAL trigger path produced — which is the thing worth
    // asserting against, rather than one a test called by hand.
    await runSweep(t, tenantId);
    return tenantId;
  }

  async function brainVersions(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
    return await t.run(async (ctx) =>
      (await ctx.db.query("brandBrains").collect()).filter(
        (b) => b.tenantId === tenantId,
      ),
    );
  }

  test("a build happens once when the inputs change", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await readyBrand(t, "brand-build");

    // Finishing the sweep is what scheduled the build — no test-only
    // trigger involved. Asking again changes nothing, because the inputs
    // have not moved.
    await t.action(internal.brand.buildBrandBrain, { tenantId });

    const versions = await brainVersions(t, tenantId);
    expect(versions.length).toBe(1);
    expect(versions[0].isCurrent).toBe(true);
    expect(versions[0].source).toBe("derived");

    const tenant = await tenantRow(t, tenantId);
    expect(tenant!.brandBrainStatus).toBe("ready");
    expect(typeof tenant!.brandInputHash).toBe("string");
  });

  test("unchanged inputs produce no new version and no writes at all", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await readyBrand(t, "brand-stable");
    const before = await tenantRow(t, tenantId);
    const currentBefore = await t.query(internal.brand.currentBrain, { tenantId });

    // Three more builds, nothing changed in between. This is the
    // six-hourly cron's whole behaviour before P2.2, and it used to cost
    // a model call and a new version every time.
    await t.action(internal.brand.buildBrandBrain, { tenantId });
    await t.action(internal.brand.buildBrandBrain, { tenantId });
    await t.action(internal.brand.buildBrandBrain, { tenantId });
    await settle(t);

    expect((await brainVersions(t, tenantId)).length).toBe(1);

    // NO WRITES AT ALL, which is the stronger claim and the one that
    // proves no model call happened: the fingerprint check returns before
    // `setBrandStatus("building")`, and the model call is downstream of
    // that. A single touched field here would mean the build ran.
    const after = await tenantRow(t, tenantId);
    const currentAfter = await t.query(internal.brand.currentBrain, { tenantId });
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect(after!.brandInputHash).toBe(before!.brandInputHash);

    // And the current brain is the same ROW, not an identical-looking
    // replacement — a demote-and-insert would change this even if every
    // field it wrote happened to match.
    expect(currentAfter!._id).toBe(currentBefore!._id);
    expect(currentAfter!.version).toBe(currentBefore!.version);
  });

  test("a changed catalog does produce a new version", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await readyBrand(t, "brand-changed");
    expect((await brainVersions(t, tenantId)).length).toBe(1);

    // The gate must not be so tight that real change is missed.
    await t.run(async (ctx) => {
      for (let i = 0; i < 20; i++) {
        await ctx.db.insert("products", {
          tenantId,
          shopifyProductId: `added-${i}`,
          title: `Wool Coat ${i}`,
          description: `A heavy wool coat, number ${i}.`,
          handle: `added-${i}`,
          productType: "Coat",
          tags: ["coat"],
          price: 500,
          currency: "GBP",
          imageUrl: "",
          images: [],
          colour: "navy",
          variants: [],
          anyVariantAvailable: true,
          ingestedAt: Date.now(),
        });
      }
    });
    await runSweep(t, tenantId);

    expect((await brainVersions(t, tenantId)).length).toBe(2);
  });

  test("a merchant correction survives automatic rebuilds", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await readyBrand(t, "brand-corrected");

    await t.mutation(internal.brand.applyMerchantCorrection, {
      tenantId,
      styleVector: { tailored: 1 },
      summary: "We are a tailoring house, not streetwear.",
    });

    // Change the catalog so a rebuild genuinely has something to do —
    // otherwise the fingerprint gate would protect the correction by
    // accident rather than by design, and the test would prove nothing.
    await t.run(async (ctx) => {
      for (let i = 0; i < 30; i++) {
        await ctx.db.insert("products", {
          tenantId,
          shopifyProductId: `street-${i}`,
          title: `Oversized Hoodie ${i}`,
          description: `A boxy heavyweight hoodie, number ${i}.`,
          handle: `street-${i}`,
          productType: "Hoodie",
          tags: ["hoodie", "streetwear"],
          price: 90,
          currency: "GBP",
          imageUrl: "",
          images: [],
          colour: "grey",
          variants: [],
          anyVariantAvailable: true,
          ingestedAt: Date.now(),
        });
      }
    });
    await runSweep(t, tenantId);

    await t.action(internal.brand.buildBrandBrain, { tenantId });
    await settle(t);

    const current = await t.query(internal.brand.currentBrain, { tenantId });

    // THE INVARIANT: merchant correction outranks derived inference.
    // Before P2.2 this failed within six hours — `buildBrandBrain` never
    // read `source`, so the next automatic rebuild demoted the corrected
    // version and inserted a derived one.
    expect(current!.source).toBe("merchant_corrected");
    expect(current!.styleVector).toEqual({ tailored: 1 });
    expect(current!.summary).toBe("We are a tailoring house, not streetwear.");
    expect(current!.confidence).toBe(1);
    expect(current!.correctedFields).toEqual(
      expect.arrayContaining(["styleVector", "summary"]),
    );
  });

  test("derived inference still updates what the merchant did not touch", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await readyBrand(t, "brand-partial");

    // Only the summary is corrected. Everything else stays derivable —
    // freezing the whole brain would be a different way of being wrong.
    await t.mutation(internal.brand.applyMerchantCorrection, {
      tenantId,
      summary: "Merchant wrote this.",
    });
    const beforeWorld = (await t.query(internal.brand.currentBrain, { tenantId }))!
      .productWorld;

    await t.run(async (ctx) => {
      for (let i = 0; i < 40; i++) {
        await ctx.db.insert("products", {
          tenantId,
          shopifyProductId: `boot-${i}`,
          title: `Chelsea Boot ${i}`,
          description: `A leather chelsea boot, number ${i}.`,
          handle: `boot-${i}`,
          productType: "Boots",
          tags: ["boots"],
          price: 300,
          currency: "GBP",
          imageUrl: "",
          images: [],
          colour: "brown",
          variants: [],
          anyVariantAvailable: true,
          ingestedAt: Date.now(),
        });
      }
    });
    await runSweep(t, tenantId);

    const current = await t.query(internal.brand.currentBrain, { tenantId });
    expect(current!.summary).toBe("Merchant wrote this.");
    // The product world is derived and was not corrected, so it moved.
    expect(current!.productWorld).not.toEqual(beforeWorld);
  });

  test("a catalog too thin to characterise writes nothing on re-check", async () => {
    const t = convexTest(schema, modules);
    // Below MIN_COVERAGE_FOR_BRAND: enough products, none enriched.
    const tenantId = await seedTenant(t, "brand-thin", 40);

    await t.action(internal.brand.buildBrandBrain, { tenantId });
    const before = await tenantRow(t, tenantId);
    expect(before!.brandBrainStatus).toBe("pending");

    // The reconciliation cron re-checks these hourly. Refusing must be
    // free, or a tenant that cannot yet be characterised pays a write an
    // hour to keep saying so.
    await t.action(internal.brand.buildBrandBrain, { tenantId });
    await t.action(internal.brand.buildBrandBrain, { tenantId });

    const after = await tenantRow(t, tenantId);
    expect(after!.updatedAt).toBe(before!.updatedAt);
    expect((await brainVersions(t, tenantId)).length).toBe(0);
  });

  test("finishing a sweep that enriched nothing schedules no build", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await readyBrand(t, "brand-quiet");

    const before = (await jobsOfType(t, tenantId, "brand_brain_build")).length;

    // A sweep over a fully-enriched catalog. Nothing changed, so nothing
    // should be scheduled — the old code enqueued a rebuild here every
    // six hours forever.
    await runSweep(t, tenantId);

    const after = (await jobsOfType(t, tenantId, "brand_brain_build")).length;
    expect(after).toBe(before);
  });
});

describe("bounded Brand Brain input loading", () => {
  test("a sample page never exceeds its bound", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-page", 900);

    // The N+1 this replaces was one query doing `take(2000)` and then a
    // profile lookup per product — 2,000 sequential reads inside a single
    // query, every six hours, per tenant. Convex has no multi-get, so the
    // per-row join stays; what must be true is that no single query's
    // read volume scales with the catalog.
    let cursor: string | null = null;
    let pages = 0;
    let total = 0;
    for (;;) {
      const page: {
        products: unknown[];
        profiles: unknown[];
        cursor: string | null;
        isDone: boolean;
      } = await t.query(internal.brand.catalogPageForBrand, { tenantId, cursor });

      expect(page.products.length).toBeLessThanOrEqual(BRAND_SAMPLE_PAGE);
      expect(page.profiles.length).toBeLessThanOrEqual(BRAND_SAMPLE_PAGE);
      total += page.products.length;
      pages++;
      if (page.isDone) break;
      cursor = page.cursor;
      expect(pages).toBeLessThan(50);
    }

    expect(total).toBe(900);
    // 900 products at 200 a page.
    expect(pages).toBeGreaterThanOrEqual(5);
  }, 60000);

  test("a page cannot be asked to exceed the bound", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "brand-clamp", 600);

    const page = await t.query(internal.brand.catalogPageForBrand, {
      tenantId,
      cursor: null,
      numItems: 5000,
    });
    expect(page.products.length).toBeLessThanOrEqual(BRAND_SAMPLE_PAGE);
  });

  test("the sample never overshoots its limit", async () => {
    const t = convexTest(schema, modules);
    // 2,100 products: a naive page walk lands on 2,100 and trims
    // afterwards, which is wrong because `profiles` is sparse and does not
    // index-align with `products` — the trim would keep profiles for
    // products outside the sample and inflate `coverage`.
    const tenantId = await seedTenant(t, "brand-overshoot", 2100);

    let cursor: string | null = null;
    let products = 0;
    for (let page = 0; page < 20; page++) {
      const room = BRAND_SAMPLE_LIMIT - products;
      if (room <= 0) break;
      const got: { products: unknown[]; cursor: string | null; isDone: boolean } =
        await t.query(internal.brand.catalogPageForBrand, {
          tenantId,
          cursor,
          numItems: Math.min(BRAND_SAMPLE_PAGE, room),
        });
      products += got.products.length;
      if (got.isDone) break;
      cursor = got.cursor;
    }

    expect(products).toBe(BRAND_SAMPLE_LIMIT);
  }, 120000);

  test("the catalog sample stays within its existing limit", async () => {
    // The bound was not raised to compensate for the read pattern.
    expect(BRAND_SAMPLE_LIMIT).toBe(2000);
  });
});

describe("tenant isolation", () => {
  test("one tenant's sweep does not touch another's products", async () => {
    const t = convexTest(schema, modules);
    const a = await seedTenant(t, "brand-iso-a", 60);
    const b = await seedTenant(t, "brand-iso-b", 60);

    await runSweep(t, a);

    expect(await unenrichedCount(t, a)).toBe(0);
    // B was never swept, so nothing of B's may have been enriched.
    expect(await unenrichedCount(t, b)).toBe(60);

    const bState = await sweepState(t, b);
    expect(bState!.cursor).toBeNull();
    expect(bState!.sweepEnriched).toBe(0);

    // And no profile written for A may reference a product of B's.
    const leaked = await t.run(async (ctx) => {
      const profiles = (await ctx.db.query("productProfiles").collect()).filter(
        (r) => r.tenantId === a,
      );
      const products = new Map(
        (await ctx.db.query("products").collect()).map((p) => [p._id as string, p]),
      );
      let wrong = 0;
      for (const profile of profiles) {
        const product = products.get(profile.productId as string);
        if (!product || product.tenantId !== a) wrong++;
      }
      return wrong;
    });
    expect(leaked).toBe(0);
  });

  test("a Brand Brain is derived only from its own tenant's catalog", async () => {
    const t = convexTest(schema, modules);
    const a = await seedTenant(t, "brand-iso-brand-a", 40, { titlePrefix: "Silk Blouse" });
    const b = await seedTenant(t, "brand-iso-brand-b", 40, { titlePrefix: "Cargo Short" });

    await runSweep(t, a);
    await runSweep(t, b);

    const page = await t.query(internal.brand.catalogPageForBrand, {
      tenantId: a,
      cursor: null,
    });
    const titles = page.products.map((p: { title: string }) => p.title).join(" ");
    expect(titles).toContain("Silk Blouse");
    expect(titles).not.toContain("Cargo Short");

    // Each brain is derived from its own tenant's catalog only. Both
    // tenants hold 40 products, so a brain that had consumed the other's
    // would report 80.
    const brainA = await t.query(internal.brand.currentBrain, { tenantId: a });
    const brainB = await t.query(internal.brand.currentBrain, { tenantId: b });
    expect(brainA!.derivedFrom.productCount).toBe(40);
    expect(brainB!.derivedFrom.productCount).toBe(40);
    expect(brainA!.tenantId).toBe(a);
    expect(brainB!.tenantId).toBe(b);
  });
});
