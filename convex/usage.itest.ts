import { convexTest } from "convex-test";
import { describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { dayKey } from "./usage";
import { estimateCostUsd } from "./lib/model-pricing";

/**
 * Usage accounting against the real runtime.
 *
 * The question this whole module exists to answer is "what does an AI
 * shopping session cost", and every Disc price tier depends on it. So
 * what is tested is not that rows get written — it is that the number
 * that comes out the other end is right, and that it degrades honestly
 * when it cannot be computed.
 */

const modules = import.meta.glob("./**/*.ts");

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  shopDomain = "acme.myshopify.com",
  publicKey = "disc_acme",
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain,
      publicKey,
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "active",
      plan: "pilot",
      productCount: 400,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

async function seedSessions(
  t: ReturnType<typeof convexTest>,
  tenantId: Id<"tenants">,
  count: number,
) {
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      await ctx.db.insert("events", {
        tenantId,
        type: "query_submitted",
        sessionKey: `sess_${i}`,
        at: Date.now(),
      });
    }
  });
}

describe("recording", () => {
  test("calls accumulate into one bucket per tenant/day/operation/model", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    for (let i = 0; i < 5; i++) {
      await t.mutation(internal.usage.record, {
        tenantId,
        operation: "judge",
        model: "claude-sonnet-4-5",
        inputTokens: 2000,
        outputTokens: 600,
      });
    }

    const rows = await t.run(async (ctx) => ctx.db.query("modelUsage").collect());
    // One row, not five. At the traffic this has to survive, per-call
    // rows are the difference between a table you can aggregate and one
    // you cannot.
    expect(rows).toHaveLength(1);
    expect(rows[0].calls).toBe(5);
    expect(rows[0].inputTokens).toBe(10_000);
    expect(rows[0].outputTokens).toBe(3_000);
    expect(rows[0].estimatedCostUsd).toBeCloseTo(5 * estimateCostUsd("claude-sonnet-4-5", 2000, 600), 10);
    expect(rows[0].day).toBe(dayKey());
  });

  test("different operations and models keep separate buckets", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 100, outputTokens: 100,
    });
    await t.mutation(internal.usage.record, {
      tenantId, operation: "intent", model: "claude-sonnet-4-5",
      inputTokens: 100, outputTokens: 100,
    });
    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "claude-haiku-4-5-20251001",
      inputTokens: 100, outputTokens: 100,
    });

    const rows = await t.run(async (ctx) => ctx.db.query("modelUsage").collect());
    expect(rows).toHaveLength(3);
  });

  test("raw tokens are stored, so a wrong rate can be corrected later", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 12345, outputTokens: 678,
    });

    const [row] = await t.run(async (ctx) => ctx.db.query("modelUsage").collect());
    // The dollar figure is derived. The tokens are the record. If only
    // the dollars were kept, every past figure would be permanently
    // wrong the moment a published rate changed.
    expect(row.inputTokens).toBe(12345);
    expect(row.outputTokens).toBe(678);
  });

  test("an unpriced model still records spend", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "whatever-someone-configured",
      inputTokens: 1_000_000, outputTokens: 0,
    });

    const [row] = await t.run(async (ctx) => ctx.db.query("modelUsage").collect());
    // Costed at the deliberately alarming unknown rate rather than
    // silently at zero — spend must never vanish because nobody updated
    // the price table.
    expect(row.estimatedCostUsd).toBeGreaterThan(0);
  });

  test("one tenant's usage never lands in another's bucket", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme.myshopify.com", "disc_acme");
    const other = await seedTenant(t, "other.myshopify.com", "disc_other");

    await t.mutation(internal.usage.record, {
      tenantId: acme, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 1000, outputTokens: 1000,
    });

    const acmeUsage = await t.query(internal.usage.tenantUsage, {
      tenantId: acme, sinceDay: "2000-01-01",
    });
    const otherUsage = await t.query(internal.usage.tenantUsage, {
      tenantId: other, sinceDay: "2000-01-01",
    });

    expect(acmeUsage.calls).toBe(1);
    expect(otherUsage.calls).toBe(0);
    expect(otherUsage.totalCostUsd).toBe(0);
  });
});

describe("economics", () => {
  test("cost per session divides shopper spend by sessions, not total spend", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await seedSessions(t, tenantId, 10);

    // Shopper-driven: 10 judge calls.
    for (let i = 0; i < 10; i++) {
      await t.mutation(internal.usage.record, {
        tenantId, operation: "judge", model: "claude-sonnet-4-5",
        inputTokens: 2000, outputTokens: 600,
      });
    }
    // Catalog-driven: one big enrichment pass. This must NOT inflate the
    // per-session figure — it is a one-time cost per product that a
    // catalog-size price tier already covers.
    await t.mutation(internal.usage.record, {
      tenantId, operation: "enrichment", model: "claude-haiku-4-5-20251001",
      inputTokens: 5_000_000, outputTokens: 1_000_000,
    });

    const report = await t.query(internal.usage.economics, {
      sinceDay: "2000-01-01",
      since: 0,
    });

    const row = report.tenants[0];
    expect(row.sessions).toBe(10);
    expect(row.catalogCostUsd).toBeGreaterThan(row.shopperCostUsd);

    const perSession = estimateCostUsd("claude-sonnet-4-5", 2000, 600);
    expect(row.costPerSessionUsd).toBeCloseTo(perSession, 10);
    // The trap: dividing TOTAL cost by sessions would make this tenant
    // look ruinously expensive per session because of a one-off
    // ingestion that has nothing to do with shopper traffic.
    expect(row.costPerSessionUsd!).toBeLessThan(row.totalCostUsd / row.sessions);
  });

  test("cost per session is null with no sessions, never zero", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 2000, outputTokens: 600,
    });

    const report = await t.query(internal.usage.economics, {
      sinceDay: "2000-01-01", since: 0,
    });
    // Spend with no sessions to divide by is undefined, not free.
    // Rendering it as $0.00 would be the most flattering possible lie.
    expect(report.tenants[0].costPerSessionUsd).toBeNull();
    expect(report.tenants[0].totalCostUsd).toBeGreaterThan(0);
  });

  test("tenants are ranked by spend, so the expensive one is first", async () => {
    const t = convexTest(schema, modules);
    const cheap = await seedTenant(t, "cheap.myshopify.com", "disc_cheap");
    const pricey = await seedTenant(t, "pricey.myshopify.com", "disc_pricey");

    await t.mutation(internal.usage.record, {
      tenantId: cheap, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 1000, outputTokens: 100,
    });
    await t.mutation(internal.usage.record, {
      tenantId: pricey, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 1_000_000, outputTokens: 500_000,
    });

    const report = await t.query(internal.usage.economics, {
      sinceDay: "2000-01-01", since: 0,
    });
    expect(report.tenants[0].shopDomain).toBe("pricey.myshopify.com");
    expect(report.totals.tenants).toBe(2);
  });

  test("the breakdown attributes spend to the operation that caused it", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 1000, outputTokens: 1000,
    });
    await t.mutation(internal.usage.record, {
      tenantId, operation: "query_embedding", model: "text-embedding-3-small",
      inputTokens: 50, outputTokens: 0,
    });

    const usage = await t.query(internal.usage.tenantUsage, {
      tenantId, sinceDay: "2000-01-01",
    });

    expect(Object.keys(usage.byOperation).sort()).toEqual(["judge", "query_embedding"]);
    // Both are shopper-driven, so both belong in the per-session number.
    expect(usage.shopperCostUsd).toBeCloseTo(usage.totalCostUsd, 10);
    expect(usage.catalogCostUsd).toBe(0);
  });
});

describe("what a merchant may see", () => {
  test("sessionsUsed counts distinct sessions and nothing else", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.run(async (ctx) => {
      // Three events across two sessions, plus one with no session key.
      for (const key of ["a", "a", "b"]) {
        await ctx.db.insert("events", {
          tenantId, type: "query_submitted", sessionKey: key, at: Date.now(),
        });
      }
      await ctx.db.insert("events", {
        tenantId, type: "error", at: Date.now(),
      });
    });

    const used = await t.query(internal.usage.sessionsUsed, { tenantId, since: 0 });
    expect(used).toBe(2);
  });

  test("§79: nothing merchant-facing carries tokens, models or dollars", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await seedSessions(t, tenantId, 3);
    await t.mutation(internal.usage.record, {
      tenantId, operation: "judge", model: "claude-sonnet-4-5",
      inputTokens: 2000, outputTokens: 600,
    });

    // The merchant-facing surface is a session count and nothing else.
    const used = await t.query(internal.usage.sessionsUsed, { tenantId, since: 0 });
    expect(typeof used).toBe("number");

    const merchantBilling = await t.query(internal.billing.billingState, { tenantId });
    const serialised = JSON.stringify(merchantBilling);
    for (const leak of ["token", "Token", "claude", "Usd", "usd", "model"]) {
      expect(serialised).not.toContain(leak);
    }
  });
});

test("the sweep drops old rollups and keeps recent ones", async () => {
  const t = convexTest(schema, modules);
  const tenantId = await seedTenant(t);

  await t.run(async (ctx) => {
    await ctx.db.insert("modelUsage", {
      tenantId, day: "2020-01-01", operation: "judge", model: "m",
      calls: 1, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 1,
      updatedAt: Date.now(),
    });
    await ctx.db.insert("modelUsage", {
      tenantId, day: dayKey(), operation: "judge", model: "m",
      calls: 1, inputTokens: 1, outputTokens: 1, estimatedCostUsd: 1,
      updatedAt: Date.now(),
    });
  });

  const purged = await t.mutation(internal.usage.purgeOldUsage, {
    beforeDay: "2024-01-01",
  });
  expect(purged).toBe(1);

  const rows = await t.run(async (ctx) => ctx.db.query("modelUsage").collect());
  expect(rows.map((r) => r.day)).toEqual([dayKey()]);
});
