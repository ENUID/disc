import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

/**
 * Idempotent scheduling (P1.2).
 *
 * The invariant: for the same tenant + logical operation + logical
 * input, at most one job represents that work, and exactly one
 * execution is scheduled for it.
 *
 * The thing that must be true and is easy to get wrong is the ORDER:
 * the dedupe decision has to happen before scheduling, not be
 * discovered by a worker afterwards. `enqueue` does both inside one
 * mutation, so there is no window in which a second caller observes a
 * gap between "row exists" and "execution scheduled".
 */

const modules = import.meta.glob("./**/*.ts");

/**
 * The webhook signing secret for this file.
 *
 * Set on the process rather than injected because `SHOPIFY_API_SECRET()`
 * reads `process.env` at call time inside the route, which is the same
 * path a deployment takes. Restored afterwards so nothing here leaks into
 * another suite.
 */
const WEBHOOK_SECRET = "test-shopify-api-secret";
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = WEBHOOK_SECRET;
});

afterAll(() => {
  if (previousSecret === undefined) delete process.env.SHOPIFY_API_SECRET;
  else process.env.SHOPIFY_API_SECRET = previousSecret;
});

/**
 * Sign a webhook body the way Shopify does: base64 HMAC-SHA256 over the
 * raw bytes.
 *
 * Written out here rather than imported from `lib/crypto` on purpose. A
 * test that signs with the same function the route verifies with proves
 * only that the function agrees with itself; an independent
 * implementation of the documented scheme is what makes a passing
 * signature evidence.
 */
async function hmac(body: string): Promise<string> {
  const bytes = new TextEncoder().encode(body);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes));
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * A tenant.
 *
 * `slug` becomes both the shop domain and the public key. It must be a
 * real Shopify domain shape — `isValidShopDomain` rejects underscores,
 * and the webhook route refuses a request whose shop domain does not
 * parse, so an invalid slug would make these tests pass for the wrong
 * reason (a 401 that looks like "nothing was scheduled").
 */
async function seedTenant(t: ReturnType<typeof convexTest>, slug = "acme") {
  const publicKey = `disc_${slug}`;
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain: `${slug}.myshopify.com`,
      publicKey,
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

/** Jobs, and the scheduler's own queue, are both observable in the harness. */
async function jobRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("jobs").collect());
}

/**
 * How many executions the scheduler actually holds.
 *
 * The point of the phase is that a duplicate request produces no second
 * execution — counting jobs alone would not prove that, because a
 * caller could correctly deduplicate the row and still schedule twice.
 */
async function scheduledCount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return scheduled.length;
  });
}

// =====================================================================

describe("the core invariant", () => {
  test("1. the same key resolves to the same job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const first = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    const second = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.jobId).toBe(first.jobId);
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("8. two callers racing schedule exactly one execution", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const [a, b] = await Promise.all([
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
    ]);

    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    expect(await jobRows(t)).toHaveLength(1);
    // THE assertion this phase exists for. Deduplicating the row while
    // still scheduling twice would satisfy every other check here.
    expect(await scheduledCount(t)).toBe(1);
  });

  test("many concurrent callers still schedule exactly once", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
      ),
    );

    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(await jobRows(t)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });
});

describe("duplicate suppression across every job state", () => {
  test("3. a running job suppresses a duplicate request", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const first = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: first.jobId });

    const again = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    expect(again.created).toBe(false);
    expect(again.status).toBe("running");
    expect(await scheduledCount(t)).toBe(1);
  });

  test("4. a retrying job suppresses a duplicate request", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const first = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: first.jobId });
    await t.mutation(internal.jobs.retryJob, {
      tenantId, jobId: first.jobId, error: "provider 429",
    });

    // The retry policy owns re-scheduling this. An enqueue must not
    // race it by scheduling a second execution of the same attempt.
    const again = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    expect(again.created).toBe(false);
    expect(again.status).toBe("retrying");
    expect(await scheduledCount(t)).toBe(1);
  });

  test("2. a succeeded job suppresses a duplicate request", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const first = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: first.jobId });
    await t.mutation(internal.jobs.succeedJob, { tenantId, jobId: first.jobId });

    const again = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    expect(again.created).toBe(false);
    expect(again.status).toBe("succeeded");
    expect(await scheduledCount(t)).toBe(1);
  });

  test("9. a failed job is not silently re-driven by an enqueue", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const first = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    await t.mutation(internal.jobs.claimJob, { tenantId, jobId: first.jobId });
    await t.mutation(internal.jobs.failJob, {
      tenantId, jobId: first.jobId, error: "Shopify 401",
    });

    // Re-driving a failed job is the retry policy's decision, not a
    // side effect of someone asking for the work again. An enqueue in
    // the same window is suppressed; a NEW logical occasion (a later
    // time bucket, below) is not.
    const again = await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId });
    expect(again.created).toBe(false);
    expect(again.status).toBe("failed");
    expect(await scheduledCount(t)).toBe(1);
  });
});

describe("what counts as different work", () => {
  test("5. a different key is a different job", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId, shopifyProductId: "gid://1", discriminator: "2026-08-26T09:00:00Z",
    });
    const laterEdit = await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId, shopifyProductId: "gid://1", discriminator: "2026-08-26T11:00:00Z",
    });

    // A genuine later edit must NOT be suppressed by the earlier one.
    expect(laterEdit.created).toBe(true);
    expect(await jobRows(t)).toHaveLength(2);
    expect(await scheduledCount(t)).toBe(2);
  });

  test("a redelivery of the same edit is suppressed", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const args = {
      tenantId,
      shopifyProductId: "gid://1",
      discriminator: "2026-08-26T09:00:00Z",
    };

    await t.mutation(internal.scheduling.enqueueProductSync, args);
    const redelivery = await t.mutation(internal.scheduling.enqueueProductSync, args);

    // Shopify does not guarantee once-only delivery. This is the case
    // that previously re-embedded the product and billed for it twice.
    expect(redelivery.created).toBe(false);
    expect(await jobRows(t)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("different products are different work", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const stamp = "2026-08-26T09:00:00Z";

    await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId, shopifyProductId: "gid://1", discriminator: stamp,
    });
    await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId, shopifyProductId: "gid://2", discriminator: stamp,
    });

    expect(await jobRows(t)).toHaveLength(2);
  });

  test("6. the same logical key under different tenants is different work", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");
    const args = { shopifyProductId: "gid://1", discriminator: "2026-08-26T09:00:00Z" };

    const a = await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId: acme, ...args,
    });
    const b = await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId: other, ...args,
    });

    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.jobId).not.toBe(b.jobId);

    // And each job belongs to its own tenant — a scheduling path that
    // lost its tenant scope would show up here.
    const rows = await jobRows(t);
    expect(new Set(rows.map((r) => r.tenantId as string)).size).toBe(2);
  });

  test("a catalog sync in a later time window is new work", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // The key carries a five-minute bucket, so the six-hourly cron is
    // never suppressed by this morning's sync. Exercised through the
    // generic enqueue with an explicitly-built key, because the helper
    // reads the clock.
    await t.mutation(internal.scheduling.enqueue, {
      tenantId, type: "catalog_sync", idempotencyKey: "catalog_sync|t|1000",
    });
    const later = await t.mutation(internal.scheduling.enqueue, {
      tenantId, type: "catalog_sync", idempotencyKey: "catalog_sync|t|1072",
    });

    expect(later.created).toBe(true);
    expect(await scheduledCount(t)).toBe(2);
  });
});

/**
 * The migrated call sites, driven through the real HTTP routes.
 *
 * The block below this one exercises the enqueue helpers directly, which
 * proves the primitive but NOT the migration: reverting a route to
 * `scheduler.runAfter` would leave those tests green. These drive the
 * actual routes, so they fail if a call site regresses.
 */
describe("migrated call sites, end to end", () => {
  test("POST /merchant/resync: four clicks, one sync", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const token = await t.mutation(internal.auth.issueSession, { tenantId });
    const auth = { headers: { Authorization: `Bearer ${token}` } };

    // Audit P2-1, through the door a merchant actually uses.
    const responses = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.fetch("/merchant/resync", { method: "POST", ...auth }),
      ),
    );
    for (const res of responses) expect(res.status).toBe(200);

    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies.filter((b) => b.deduplicated === false)).toHaveLength(1);
    expect(bodies.filter((b) => b.deduplicated === true)).toHaveLength(3);

    expect(await jobRows(t)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("POST /merchant/resync is still tenant-scoped", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");

    for (const tenantId of [acme, other]) {
      const token = await t.mutation(internal.auth.issueSession, { tenantId });
      const res = await t.fetch("/merchant/resync", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }

    // Two tenants, two jobs — a scheduling path that lost its tenant
    // scope would collapse these into one.
    const rows = await jobRows(t);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId as string)).size).toBe(2);
  });

  test("POST /merchant/resync without a token schedules nothing", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    const res = await t.fetch("/merchant/resync", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await jobRows(t)).toHaveLength(0);
    expect(await scheduledCount(t)).toBe(0);
  });

  test("products/update webhook: a redelivery does no second sync", async () => {
    const t = convexTest(schema, modules);
    // The id is deliberately unused: the route resolves the tenant from
    // the shop domain header, which is the path a real delivery takes.
    await seedTenant(t, "acme");

    const payload = JSON.stringify({
      id: 998877,
      updated_at: "2026-08-26T09:00:00Z",
    });

    // Two identical deliveries, which Shopify explicitly permits.
    for (let i = 0; i < 2; i++) {
      const res = await t.fetch("/webhooks/shopify/products/update", {
        method: "POST",
        headers: {
          "X-Shopify-Shop-Domain": "acme.myshopify.com",
          "X-Shopify-Hmac-Sha256": await hmac(payload),
        },
        body: payload,
      });
      expect(res.status).toBe(200);
    }

    // Previously: two jobs, two re-embeds, billed twice.
    expect(await jobRows(t)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("products/update webhook: a genuine later edit is not suppressed", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "acme");

    for (const stamp of ["2026-08-26T09:00:00Z", "2026-08-26T11:30:00Z"]) {
      const payload = JSON.stringify({ id: 998877, updated_at: stamp });
      const res = await t.fetch("/webhooks/shopify/products/update", {
        method: "POST",
        headers: {
          "X-Shopify-Shop-Domain": "acme.myshopify.com",
          "X-Shopify-Hmac-Sha256": await hmac(payload),
        },
        body: payload,
      });
      expect(res.status).toBe(200);
    }

    // Dedupe must not swallow real updates — the failure that would be
    // far worse than the duplicate it prevents.
    expect(await jobRows(t)).toHaveLength(2);
  });

  test("a forged webhook schedules nothing", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "acme");

    const res = await t.fetch("/webhooks/shopify/products/update", {
      method: "POST",
      headers: {
        "X-Shopify-Shop-Domain": "acme.myshopify.com",
        "X-Shopify-Hmac-Sha256": "not-a-real-signature",
      },
      body: JSON.stringify({ id: 1, updated_at: "2026-08-26T09:00:00Z" }),
    });

    expect(res.status).toBe(401);
    expect(await jobRows(t)).toHaveLength(0);
    expect(await scheduledCount(t)).toBe(0);
  });
});

describe("migrated call sites, via the enqueue helpers", () => {
  test("the merchant Resync button collapses repeated clicks", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // Audit P2-1: the rate limit permits four resyncs an hour and there
    // was no concurrency guard, so four clicks meant four concurrent
    // full catalog reads and four times the embedding spend.
    const clicks = await Promise.all(
      Array.from({ length: 4 }, () =>
        t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
      ),
    );

    expect(clicks.filter((c) => c.created)).toHaveLength(1);
    expect(clicks.filter((c) => !c.created)).toHaveLength(3);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("the resync cron and a merchant click collapse to one sync", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // `dueForResync` excludes tenants mid-sync, but a merchant pressing
    // Resync in the same window would previously race the sweep.
    const [cron, merchant] = await Promise.all([
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
    ]);

    expect([cron.created, merchant.created].filter(Boolean)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("a reinstall does not start two first ingestions", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const [a, b] = await Promise.all([
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
    ]);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
  });
});

describe("guards", () => {
  test("10. maintenance work is refused rather than forced through this abstraction", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // `data_purge` is a real job type but is not scheduled through this
    // seam. It must throw rather than create a row nothing will run —
    // a queued job with no scheduled execution is exactly the orphan
    // this module exists to prevent.
    await expect(
      t.mutation(internal.scheduling.enqueue, {
        tenantId, type: "data_purge", idempotencyKey: "data_purge|t|1",
      }),
    ).rejects.toThrow(/not schedulable through enqueue yet/);

    expect(await jobRows(t)).toHaveLength(0);
    expect(await scheduledCount(t)).toBe(0);
  });

  test("an unknown job type creates nothing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await expect(
      t.mutation(internal.scheduling.enqueue, {
        tenantId, type: "catalogSync", idempotencyKey: "typo",
      }),
    ).rejects.toThrow(/Unknown job type/);
    expect(await jobRows(t)).toHaveLength(0);
  });

  test("a product sync without a product id creates no orphan row", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // The throw happens after the insert in program order, so this also
    // proves the mutation is transactional: an aborted enqueue must
    // leave neither a row nor a schedule.
    await expect(
      t.mutation(internal.scheduling.enqueue, {
        tenantId, type: "product_embedding", idempotencyKey: "no-product-id",
      }),
    ).rejects.toThrow(/requires a shopifyProductId/);

    expect(await jobRows(t)).toHaveLength(0);
    expect(await scheduledCount(t)).toBe(0);
  });

  test("a job cannot be enqueued for a tenant that does not exist", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await t.run(async (ctx) => ctx.db.delete(tenantId));

    await expect(
      t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId }),
    ).rejects.toThrow(/Unknown tenant/);
  });
});

describe("created implies scheduled", () => {
  test("every created job has exactly one scheduled execution", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");

    await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId: acme });
    await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId: other });
    await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId: acme, shopifyProductId: "gid://1", discriminator: "a",
    });
    // Duplicates of all three.
    await t.mutation(internal.scheduling.enqueueCatalogSync, { tenantId: acme });
    await t.mutation(internal.scheduling.enqueueProductSync, {
      tenantId: acme, shopifyProductId: "gid://1", discriminator: "a",
    });

    const rows = await jobRows(t);
    expect(rows).toHaveLength(3);
    // The invariant stated as an equality: a row that was created has an
    // execution, and nothing else does.
    expect(await scheduledCount(t)).toBe(3);
    expect(rows.every((r) => r.status === "queued")).toBe(true);
    expect(rows.every((r) => r.scheduledAt !== undefined)).toBe(true);
  });
});
