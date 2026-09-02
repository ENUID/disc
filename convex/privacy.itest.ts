import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { emptyProfile } from "./lib/fashion-profile";

/**
 * Deletion and retention (spec §92, §93), against the real runtime.
 *
 * `shop/redact` and `app/uninstalled` both promise that a shop's data is
 * gone. The way that promise breaks is not dramatic: someone adds a
 * table, wires it to `tenantId`, and never touches `purgeTenant`. The
 * row then outlives the shop that owned it, silently, and nothing fails
 * until an audit asks.
 *
 * So the check here is not "the tables I remembered are empty" — that
 * test passes forever while quietly going out of date. It is "no row
 * anywhere still carries this tenant's id".
 */

const modules = import.meta.glob("./**/*.ts");

/** Every table that stores tenant-owned rows. Kept in sync by the test below. */
const TENANT_OWNED = [
  "products",
  "productEmbeddings",
  "productProfiles",
  "brandBrains",
  "events",
  "recommendationTraces",
  "shopperSessions",
  "merchantSessions",
  "modelUsage",
  "looks",
  "lookEdges",
  "jobs",
  "webhookDeliveries",
  "stripeEvents",
] as const;

async function seedFullTenant(
  t: ReturnType<typeof convexTest>,
  shopDomain: string,
  publicKey: string,
) {
  return await t.run(async (ctx) => {
    const tenantId = await ctx.db.insert("tenants", {
      shopDomain,
      publicKey,
      accessTokenCipher: "cipher",
      scopes: "read_products",
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "active",
      productCount: 1,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const productId = await ctx.db.insert("products", {
      tenantId,
      shopifyProductId: "gid://1",
      title: "Linen Overshirt",
      description: "",
      handle: "linen-overshirt",
      productType: "Outerwear",
      tags: [],
      price: 180,
      currency: "GBP",
      imageUrl: "https://cdn/1.jpg",
      images: ["https://cdn/1.jpg"],
      colour: "olive",
      variants: [{ id: "v1", title: "M", price: 180, available: true }],
      anyVariantAvailable: true,
      ingestedAt: Date.now(),
    });

    await ctx.db.insert("productEmbeddings", {
      tenantId,
      productId,
      embedding: Array.from({ length: 1536 }, () => 0.01),
      embeddingModel: "test",
      contentHash: "hash",
      createdAt: Date.now(),
    });

    await ctx.db.insert("productProfiles", {
      tenantId,
      productId,
      profile: emptyProfile(),
      provenance: {},
      completeness: 0.5,
      cacheKey: "key",
      schemaVersion: "1",
      lastEnrichedAt: Date.now(),
    });

    await ctx.db.insert("brandBrains", {
      tenantId,
      version: 1,
      isCurrent: true,
      styleVector: {},
      palette: {},
      formality: {},
      productWorld: {},
      voice: {},
      summary: "",
      derivedFrom: {},
      source: "derived",
      confidence: 0.5,
      createdAt: Date.now(),
    });

    await ctx.db.insert("events", {
      tenantId,
      type: "product_viewed",
      at: Date.now(),
    });

    await ctx.db.insert("recommendationTraces", {
      tenantId,
      recommendationId: `rec_${publicKey}`,
      workflow: "search",
      request: {},
      candidateIds: [],
      finalIds: [],
      scores: {},
      versions: {},
      latencyMs: 10,
      at: Date.now(),
    });

    await ctx.db.insert("shopperSessions", {
      tenantId,
      sessionKey: "sess_1",
      state: {},
      lastSeenAt: Date.now(),
      createdAt: Date.now(),
    });

    await ctx.db.insert("merchantSessions", {
      tenantId,
      tokenHash: `hash_${publicKey}`,
      expiresAt: Date.now() + 1000,
      createdAt: Date.now(),
    });

    await ctx.db.insert("jobs", {
      tenantId,
      type: "catalog_sync",
      status: "queued",
      idempotencyKey: `catalog_sync|${publicKey}`,
      attempt: 0,
      maxAttempts: 3,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    await ctx.db.insert("modelUsage", {
      tenantId,
      day: new Date().toISOString().slice(0, 10),
      operation: "judge",
      model: "claude-sonnet-4-5",
      calls: 1,
      inputTokens: 100,
      outputTokens: 50,
      estimatedCostUsd: 0.001,
      updatedAt: Date.now(),
    });

    return tenantId;
  });
}

/** Every row, anywhere, still carrying this tenant's id. */
async function rowsOwnedBy(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
): Promise<string[]> {
  return await t.run(async (ctx) => {
    const found: string[] = [];
    for (const table of TENANT_OWNED) {
      const rows = await ctx.db.query(table).collect();
      for (const row of rows) {
        if (row.tenantId === tenantId) found.push(table);
      }
    }
    return found;
  });
}

test("the deletion list covers every tenant-owned table in the schema", () => {
  // The guard against the real failure mode: a table added later,
  // scoped by tenantId, and never added to purgeTenant. If this fails,
  // add the table to TENANT_OWNED *and* to purgeTenant — not just here.
  const tenantScoped = Object.entries(schema.tables)
    .filter(([, table]) => {
      const fields = (table as { validator: { fields?: Record<string, unknown> } })
        .validator.fields;
      return fields !== undefined && "tenantId" in fields;
    })
    .map(([name]) => name)
    .sort();

  expect(tenantScoped).toEqual([...TENANT_OWNED].sort());
});

test("§93: purging a tenant leaves nothing of it behind", async () => {
  const t = convexTest(schema, modules);
  const acme = await seedFullTenant(t, "acme.myshopify.com", "disc_acme");

  expect(await rowsOwnedBy(t, acme)).not.toHaveLength(0);

  await t.mutation(internal.tenants.purgeTenant, { tenantId: acme });

  expect(await rowsOwnedBy(t, acme)).toEqual([]);
  const tenant = await t.run(async (ctx) => await ctx.db.get(acme));
  expect(tenant).toBeNull();
});

test("§93: purging one shop does not touch another's data", async () => {
  const t = convexTest(schema, modules);
  const acme = await seedFullTenant(t, "acme.myshopify.com", "disc_acme");
  const other = await seedFullTenant(t, "other.myshopify.com", "disc_other");

  const before = await rowsOwnedBy(t, other);
  await t.mutation(internal.tenants.purgeTenant, { tenantId: acme });

  expect(await rowsOwnedBy(t, other)).toEqual(before);
  expect(await t.run(async (ctx) => await ctx.db.get(other))).not.toBeNull();
});

test("§92: idle shopper sessions age out, recent ones do not", async () => {
  const t = convexTest(schema, modules);
  const tenantId = await seedFullTenant(t, "acme.myshopify.com", "disc_acme");
  const now = Date.now();

  await t.run(async (ctx) => {
    await ctx.db.insert("shopperSessions", {
      tenantId,
      sessionKey: "sess_old",
      state: { occasion: "wedding" },
      lastSeenAt: now - 90 * 86400_000,
      createdAt: now - 90 * 86400_000,
    });
  });

  const deleted = await t.mutation(internal.session.purgeStaleSessions, {
    olderThan: now - 30 * 86400_000,
  });
  expect(deleted).toBe(1);

  const remaining = await t.run(
    async (ctx) => await ctx.db.query("shopperSessions").collect(),
  );
  expect(remaining.map((r) => r.sessionKey)).toEqual(["sess_1"]);
});
