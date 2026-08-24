import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { emptyProfile } from "./lib/fashion-profile";
import { defaultWidgetConfig, parseWidgetConfig } from "./lib/widget-config";

/**
 * The merchant control plane (spec §70-§75) against the real runtime.
 *
 * Two properties carry the weight here: that every status is derived
 * from real job state rather than a field someone remembered to set
 * (§18: "Do not fake progress"), and that none of this is reachable with
 * the public key.
 */

const modules = import.meta.glob("./**/*.ts");

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  over: Partial<{
    catalogStatus: "pending" | "syncing" | "ready" | "error";
    brandBrainStatus: "pending" | "building" | "ready" | "error";
    widgetStatus: "inactive" | "previewing" | "live";
    productCount: number;
  }> = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("tenants", {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
      accessTokenCipher: "cipher-should-never-be-exposed",
      scopes: "read_products",
      source: "shopify_oauth",
      catalogStatus: over.catalogStatus ?? "ready",
      brandBrainStatus: over.brandBrainStatus ?? "pending",
      widgetStatus: over.widgetStatus ?? "inactive",
      subscriptionStatus: "active",
      productCount: over.productCount ?? 0,
      email: "merchant@acme.com",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedProduct(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  opts: {
    id: string;
    enriched?: boolean;
    completeness?: number;
    embedded?: boolean;
    available?: boolean;
    images?: string[];
    rejectedFields?: string[];
  },
) {
  await t.run(async (ctx) => {
    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId: opts.id,
      title: opts.id,
      description: "d",
      handle: opts.id,
      productType: "Tops",
      vendor: "Acme",
      tags: [],
      price: 100,
      currency: "GBP",
      imageUrl: opts.images?.[0] ?? "https://cdn/a.jpg",
      images: opts.images ?? ["https://cdn/a.jpg"],
      colour: "",
      variants: [{ id: "v1", title: "M", price: 100, available: opts.available ?? true }],
      anyVariantAvailable: opts.available ?? true,
      ingestedAt: Date.now(),
    });

    if (opts.embedded !== false) {
      await ctx.db.insert("productEmbeddings", {
        tenantId,
        productId,
        embedding: new Array(1536).fill(0),
        embeddingModel: "test",
        contentHash: opts.id,
        createdAt: Date.now(),
      });
    }

    if (opts.enriched) {
      await ctx.db.insert("productProfiles", {
        tenantId,
        productId,
        profile: emptyProfile(),
        provenance: {},
        completeness: opts.completeness ?? 0.9,
        cacheKey: opts.id,
        schemaVersion: "profile_v1",
        lastEnrichedAt: Date.now(),
        rejectedFields: opts.rejectedFields,
      });
    }
  });
}

describe("onboarding progress is derived from real state (spec §18)", () => {
  test("a fresh install shows only the connection as done", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, { catalogStatus: "pending" });

    const overview = await t.query(internal.merchant.overview, { tenantId });
    const byKey = Object.fromEntries(
      overview!.onboarding.map((s: { key: string; done: boolean }) => [s.key, s.done]),
    );

    expect(byKey.connected).toBe(true);
    expect(byKey.catalog).toBe(false);
    expect(byKey.products).toBe(false);
    expect(byKey.brand).toBe(false);
    expect(byKey.live).toBe(false);
  });

  test("stages advance only when the underlying thing is actually true", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, {
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
    });
    await seedProduct(t, tenantId, { id: "p1", enriched: true });

    const overview = await t.query(internal.merchant.overview, { tenantId });
    expect(overview!.onboarding.every((s: { done: boolean }) => s.done)).toBe(true);
    expect(overview!.needsActivation).toBe(false);
  });

  test('"understanding your products" stays false with no profiles', async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, { catalogStatus: "ready" });
    await seedProduct(t, tenantId, { id: "p1", enriched: false });

    const overview = await t.query(internal.merchant.overview, { tenantId });
    const products = overview!.onboarding.find(
      (s: { key: string }) => s.key === "products",
    );
    // A catalog that is indexed but not understood is a real, visible
    // state — not the same as being ready.
    expect(products.done).toBe(false);
  });

  test("a failed catalog sync surfaces as failed, not merely incomplete", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, { catalogStatus: "error" });
    await t.run(async (ctx) => {
      await ctx.db.patch(tenantId, { catalogError: "products.json returned 404" });
    });

    const overview = await t.query(internal.merchant.overview, { tenantId });
    const catalog = overview!.onboarding.find((s: { key: string }) => s.key === "catalog");
    expect(catalog.failed).toBe(true);
    expect(overview!.catalogError).toBe("products.json returned 404");
  });
});

describe("catalog health (spec §73)", () => {
  test("counts indexed and enriched separately", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await seedProduct(t, tenantId, { id: "full", enriched: true, completeness: 0.9 });
    await seedProduct(t, tenantId, { id: "thin", enriched: true, completeness: 0.2 });
    await seedProduct(t, tenantId, { id: "bare", enriched: false });
    await seedProduct(t, tenantId, { id: "unindexed", enriched: false, embedded: false });

    const health = await t.query(internal.merchant.catalogHealth, { tenantId });

    expect(health.total).toBe(4);
    // Searchable but not understood is a distinct state: such a product
    // participates in outfits scoring everything neutral.
    expect(health.indexed).toBe(3);
    expect(health.enriched).toBe(2);
    expect(health.notEnriched).toBe(2);
    expect(health.lowConfidence).toBe(1);
  });

  test("surfaces what a merchant would need to fix", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await seedProduct(t, tenantId, { id: "gone", available: false });
    await seedProduct(t, tenantId, { id: "no-image", images: [] });
    await seedProduct(t, tenantId, {
      id: "odd",
      enriched: true,
      rejectedFields: ["garment"],
    });

    const health = await t.query(internal.merchant.catalogHealth, { tenantId });
    expect(health.unavailable).toBe(1);
    expect(health.missingImages).toBe(1);
    // A model repeatedly failing one field should be visible rather than
    // silently degrading every product.
    expect(health.rejectedFields).toBe(1);
  });

  test("an empty catalog reports zeroes rather than failing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const health = await t.query(internal.merchant.catalogHealth, { tenantId });
    expect(health.total).toBe(0);
    expect(health.enriched).toBe(0);
  });
});

describe("experience controls (spec §74)", () => {
  test("Disc starts switched off", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const experience = await t.query(internal.merchant.experience, { tenantId });
    // Installing must never silently change what shoppers see; the
    // merchant previews, then activates (§13, §127).
    expect(experience!.config.enabled).toBe(false);
    expect(experience!.widgetStatus).toBe("inactive");
  });

  test("enabling puts Disc live, disabling takes it off", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: { ...defaultWidgetConfig(), enabled: true },
    });
    let experience = await t.query(internal.merchant.experience, { tenantId });
    expect(experience!.widgetStatus).toBe("live");

    await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: { ...defaultWidgetConfig(), enabled: false },
    });
    experience = await t.query(internal.merchant.experience, { tenantId });
    // Removable without uninstalling the app (spec §127).
    expect(experience!.widgetStatus).toBe("inactive");
  });

  test("merchant input is validated, never stored raw", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const saved = await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: {
        enabled: true,
        placement: "javascript:alert(1)",
        greeting: "x".repeat(500),
        workflows: ["OUTFIT", "NOT_A_WORKFLOW"],
        design: { density: "<script>", cornerRadius: "small" },
      },
    });

    // This value is rendered into a storefront, so anything outside the
    // known sets must not survive.
    expect(saved.placement).toBe("bottom_bar");
    expect(saved.greeting.length).toBeLessThanOrEqual(80);
    expect(saved.workflows).toEqual(["OUTFIT"]);
    expect(saved.design.density).toBe("airy");
    expect(saved.design.cornerRadius).toBe("small");
  });

  test("an empty workflow list falls back rather than bricking the widget", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const saved = await t.mutation(internal.merchant.saveExperience, {
      tenantId,
      config: { workflows: [] },
    });
    expect(saved.workflows.length).toBeGreaterThan(0);
  });

  test("preview does not put Disc live", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await t.mutation(internal.merchant.setPreviewing, { tenantId });

    const experience = await t.query(internal.merchant.experience, { tenantId });
    expect(experience!.widgetStatus).toBe("previewing");
    expect(experience!.config.enabled).toBe(false);
  });

  test("preview never demotes a live widget", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, { widgetStatus: "live" });
    await t.mutation(internal.merchant.setPreviewing, { tenantId });
    const experience = await t.query(internal.merchant.experience, { tenantId });
    expect(experience!.widgetStatus).toBe("live");
  });
});

describe("settings never leak a secret", () => {
  test("no access token or ciphertext is exposed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const settings = await t.query(internal.merchant.settings, { tenantId });
    const serialised = JSON.stringify(settings);

    // The Shopify token is the one credential that would let someone
    // read a merchant's whole catalog. It must not appear in a response
    // even to the authenticated merchant.
    expect(serialised).not.toContain("cipher-should-never-be-exposed");
    expect(settings).not.toHaveProperty("accessTokenCipher");
    // The public key is safe: it ships in storefront HTML anyway.
    expect(settings!.publicKey).toBe("disc_acme");
  });
});

describe("widget config parsing", () => {
  test("round-trips a valid config", () => {
    const config = defaultWidgetConfig();
    expect(parseWidgetConfig(config)).toEqual(config);
  });

  test("garbage yields the default rather than throwing", () => {
    for (const bad of [null, undefined, "string", 42, []]) {
      expect(() => parseWidgetConfig(bad)).not.toThrow();
      expect(parseWidgetConfig(bad).enabled).toBe(false);
    }
  });
});
