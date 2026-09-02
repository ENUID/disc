import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";

/**
 * Shopify webhook delivery handling (P1.4), against the real routes.
 *
 * Every test below drives a genuine HMAC-signed request through
 * `http.ts`, because the thing being tested is the behaviour of the
 * endpoint Shopify actually calls — including its status code, which is
 * what decides whether Shopify retries.
 *
 * The two questions this phase separates, and which these tests keep
 * separate:
 *
 *   have we already processed THIS DELIVERY?   -> webhook id
 *   is this event newer than what we applied?  -> resource timestamp
 */

const modules = import.meta.glob("./**/*.ts");

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

/** Shopify's scheme: base64 HMAC-SHA256 over the raw body. */
async function hmac(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
  );
  let binary = "";
  for (const byte of signature) binary += String.fromCharCode(byte);
  return btoa(binary);
}

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

type Delivery = {
  topic?: string;
  path?: string;
  slug?: string;
  webhookId?: string | null;
  eventId?: string;
  triggeredAt?: string;
  payload: Record<string, unknown>;
};

/** Post a signed delivery exactly as Shopify would. */
async function deliver(t: ReturnType<typeof convexTest>, d: Delivery) {
  const body = JSON.stringify(d.payload);
  const headers: Record<string, string> = {
    "X-Shopify-Shop-Domain": `${d.slug ?? "acme"}.myshopify.com`,
    "X-Shopify-Hmac-Sha256": await hmac(body),
    "X-Shopify-Topic": d.topic ?? "products/update",
  };
  // `null` means "Shopify omitted the header", which is distinct from
  // "the test did not say", hence the explicit null.
  if (d.webhookId !== null) headers["X-Shopify-Webhook-Id"] = d.webhookId ?? "wh-1";
  if (d.eventId) headers["X-Shopify-Event-Id"] = d.eventId;
  if (d.triggeredAt) headers["X-Shopify-Triggered-At"] = d.triggeredAt;

  return await t.fetch(d.path ?? "/webhooks/shopify/products/update", {
    method: "POST",
    headers,
    body,
  });
}

async function jobRows(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("jobs").collect());
}
async function deliveries(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("webhookDeliveries").collect());
}
async function scheduledCount(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) =>
    (await ctx.db.system.query("_scheduled_functions").collect()).length,
  );
}

// =====================================================================

describe("delivery deduplication — the webhook id", () => {
  test("the same delivery twice is processed once", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);
    const delivery = {
      webhookId: "wh-abc",
      payload: { id: 111, updated_at: "2026-08-26T09:00:00Z" },
    };

    const first = await deliver(t, delivery);
    const second = await deliver(t, delivery);

    // Both acknowledged. A non-2xx would make Shopify retry a delivery
    // whose only correct outcome is to be ignored.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    expect(await jobRows(t)).toHaveLength(1);
    // The redelivery writes NO row — the existing one is the record of
    // it. Storing one per redelivery would grow the table under a retry
    // storm without adding information.
    expect(await deliveries(t)).toHaveLength(1);
  });

  test("a retry storm of one delivery stays one job and one row", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);
    const delivery = {
      webhookId: "wh-storm",
      payload: { id: 222, updated_at: "2026-08-26T09:00:00Z" },
    };

    await Promise.all(Array.from({ length: 6 }, () => deliver(t, delivery)));

    expect(await jobRows(t)).toHaveLength(1);
    expect(await deliveries(t)).toHaveLength(1);
    expect(await scheduledCount(t)).toBe(1);
  });

  test("a delivery with no webhook id is still processed", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    // Shopify always sends the header; this is the defensive branch.
    // Losing deduplication is recoverable — the job key and the freshness
    // check both still apply — while dropping a real update is not.
    const res = await deliver(t, {
      webhookId: null,
      payload: { id: 333, updated_at: "2026-08-26T09:00:00Z" },
    });

    expect(res.status).toBe(200);
    expect(await jobRows(t)).toHaveLength(1);
  });
});

describe("the event id is correlation, never deduplication", () => {
  test("two subscriptions firing for one merchant action both apply", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    // One merchant action, two subscribed topics: same event id, DIFFERENT
    // webhook ids. Deduplicating on the event id would silently drop a
    // topic — which is exactly why it is stored and never compared.
    await deliver(t, {
      path: "/webhooks/shopify/products/create",
      topic: "products/create",
      webhookId: "wh-create",
      eventId: "evt-shared",
      payload: { id: 444, updated_at: "2026-08-26T09:00:00Z" },
    });
    await deliver(t, {
      path: "/webhooks/shopify/products/update",
      topic: "products/update",
      webhookId: "wh-update",
      eventId: "evt-shared",
      payload: { id: 444, updated_at: "2026-08-26T09:00:00Z" },
    });

    const rows = await deliveries(t);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.eventId === "evt-shared")).toBe(true);
    expect(rows.map((r) => r.topic).sort()).toEqual([
      "products/create",
      "products/update",
    ]);

    // Both were applied — and the JOB key collapses them, because they
    // describe the same resource version. Each layer catches what it
    // should: the ledger the same delivery, the job key the same version.
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("the event id is recorded for correlation", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);
    await deliver(t, {
      webhookId: "wh-1",
      eventId: "evt-42",
      payload: { id: 555, updated_at: "2026-08-26T09:00:00Z" },
    });

    const row = (await deliveries(t))[0];
    expect(row.eventId).toBe("evt-42");
    expect(row.webhookId).toBe("wh-1");
  });
});

describe("resource freshness — ordering is not guaranteed", () => {
  test("an out-of-order update does not overwrite newer state", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    await deliver(t, {
      webhookId: "wh-new",
      payload: { id: 666, updated_at: "2026-08-26T12:00:00Z" },
    });
    const late = await deliver(t, {
      webhookId: "wh-old",
      payload: { id: 666, updated_at: "2026-08-26T09:00:00Z" },
    });

    // Acknowledged, recorded, not applied. Shopify retries a non-2xx,
    // and a stale event stays stale, so refusing it would retry forever.
    expect(late.status).toBe(200);

    const rows = await deliveries(t);
    expect(rows.map((r) => r.outcome).sort()).toEqual(["applied", "stale"]);
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("timezone offsets are compared as instants, not as strings", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    // 13:00 UTC, written with an offset. Sorts BEFORE the next one
    // lexicographically while actually being an hour later.
    await deliver(t, {
      webhookId: "wh-a",
      payload: { id: 777, updated_at: "2026-08-26T09:00:00-04:00" },
    });
    await deliver(t, {
      webhookId: "wh-b",
      payload: { id: 777, updated_at: "2026-08-26T12:00:00+00:00" },
    });

    const rows = await deliveries(t);
    const stale = rows.find((r) => r.webhookId === "wh-b");
    expect(stale?.outcome).toBe("stale");
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("a genuine later edit is never suppressed", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    for (const [webhookId, stamp] of [
      ["wh-1", "2026-08-26T09:00:00Z"],
      ["wh-2", "2026-08-26T11:00:00Z"],
      ["wh-3", "2026-08-26T13:00:00Z"],
    ]) {
      await deliver(t, { webhookId, payload: { id: 888, updated_at: stamp } });
    }

    // Suppressing a real update is far worse than the duplicate the
    // check exists to prevent, so this is the direction that matters.
    const rows = await deliveries(t);
    expect(rows.every((r) => r.outcome === "applied")).toBe(true);
    expect(await jobRows(t)).toHaveLength(3);
  });

  test("the same version by two routes is applied, and collapses at the job", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);
    const stamp = "2026-08-26T09:00:00Z";

    await deliver(t, { webhookId: "wh-1", payload: { id: 999, updated_at: stamp } });
    await deliver(t, { webhookId: "wh-2", payload: { id: 999, updated_at: stamp } });

    // Equal is NOT stale: an equal timestamp with a different delivery id
    // is a second delivery of the same version, not a duplicate delivery.
    const rows = await deliveries(t);
    expect(rows.every((r) => r.outcome === "applied")).toBe(true);
    expect(await jobRows(t)).toHaveLength(1);
  });

  test("a webhook older than a catalog-synced product is stale", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // The common case on a fresh install: every product arrived by
    // catalog sync, so the ledger knows nothing about it. Without the
    // fallback to `products.sourceUpdatedAt`, the first webhook for such
    // a product would always look fresh.
    await t.run(async (ctx) =>
      ctx.db.insert("products", {
        tenantId,
        shopifyProductId: "1234",
        title: "Linen Overshirt",
        description: "",
        handle: "linen-overshirt",
        productType: "Shirts",
        tags: [],
        price: 180,
        currency: "GBP",
        imageUrl: "",
        images: [],
        colour: "olive",
        variants: [],
        anyVariantAvailable: true,
        sourceUpdatedAt: "2026-08-26T12:00:00Z",
        ingestedAt: Date.now(),
      }),
    );

    await deliver(t, {
      webhookId: "wh-late",
      payload: { id: 1234, updated_at: "2026-08-26T09:00:00Z" },
    });

    expect((await deliveries(t))[0].outcome).toBe("stale");
    expect(await jobRows(t)).toHaveLength(0);
  });

  test("a webhook newer than a catalog-synced product applies", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await t.run(async (ctx) =>
      ctx.db.insert("products", {
        tenantId,
        shopifyProductId: "1234",
        title: "Linen Overshirt",
        description: "",
        handle: "linen-overshirt",
        productType: "Shirts",
        tags: [],
        price: 180,
        currency: "GBP",
        imageUrl: "",
        images: [],
        colour: "olive",
        variants: [],
        anyVariantAvailable: true,
        sourceUpdatedAt: "2026-08-26T09:00:00Z",
        ingestedAt: Date.now(),
      }),
    );

    await deliver(t, {
      webhookId: "wh-fresh",
      payload: { id: 1234, updated_at: "2026-08-26T12:00:00Z" },
    });

    expect((await deliveries(t))[0].outcome).toBe("applied");
    expect(await jobRows(t)).toHaveLength(1);
  });
});

describe("deletes", () => {
  test("a delete is ordered by its trigger time, having no version", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    const res = await deliver(t, {
      path: "/webhooks/shopify/products/delete",
      topic: "products/delete",
      webhookId: "wh-del",
      triggeredAt: "2026-08-26T12:00:00Z",
      payload: { id: 4242 },
    });

    expect(res.status).toBe(200);
    const row = (await deliveries(t))[0];
    expect(row.outcome).toBe("applied");
    expect(row.eventAt).toBe(Date.parse("2026-08-26T12:00:00Z"));
  });

  test("an update that predates a delete does not resurrect the product", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    await deliver(t, {
      path: "/webhooks/shopify/products/delete",
      topic: "products/delete",
      webhookId: "wh-del",
      triggeredAt: "2026-08-26T12:00:00Z",
      payload: { id: 4242 },
    });

    // THE CASE `products.sourceUpdatedAt` CANNOT COVER. The delete
    // removed the product row, so there is no product left to compare
    // against — a late update would look like a brand-new product and be
    // re-created. The ledger is what remembers the delete.
    await deliver(t, {
      webhookId: "wh-late-update",
      payload: { id: 4242, updated_at: "2026-08-26T09:00:00Z" },
    });

    const rows = await deliveries(t);
    expect(rows.find((r) => r.webhookId === "wh-late-update")?.outcome).toBe("stale");
    expect(await jobRows(t)).toHaveLength(0);
  });

  test("an update genuinely after a delete is applied", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    await deliver(t, {
      path: "/webhooks/shopify/products/delete",
      topic: "products/delete",
      webhookId: "wh-del",
      triggeredAt: "2026-08-26T09:00:00Z",
      payload: { id: 4242 },
    });
    // A merchant deleting and re-creating a product is legitimate.
    await deliver(t, {
      webhookId: "wh-recreate",
      payload: { id: 4242, updated_at: "2026-08-26T12:00:00Z" },
    });

    expect(await jobRows(t)).toHaveLength(1);
  });
});

describe("non-product topics", () => {
  test("a GDPR acknowledgement is recorded but advances nothing", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    const res = await deliver(t, {
      path: "/webhooks/shopify/customers/redact",
      topic: "customers/redact",
      webhookId: "wh-gdpr",
      triggeredAt: "2026-08-26T12:00:00Z",
      payload: { customer: { id: 1 } },
    });

    expect(res.status).toBe(200);
    const row = (await deliveries(t))[0];
    expect(row.outcome).toBe("acknowledged");
    // An acknowledgement must never become a freshness watermark, or a
    // GDPR no-op would start suppressing real product updates.
    expect(row.appliedEventAt).toBe(0);
  });

  test("an uninstall purges the tenant, ledger included", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);
    await deliver(t, {
      webhookId: "wh-1",
      payload: { id: 1, updated_at: "2026-08-26T09:00:00Z" },
    });
    expect(await deliveries(t)).toHaveLength(1);

    const res = await deliver(t, {
      path: "/webhooks/shopify/app/uninstalled",
      topic: "app/uninstalled",
      webhookId: "wh-uninstall",
      payload: {},
    });

    expect(res.status).toBe(200);
    // Deduplication state for a shop that no longer exists protects
    // nothing, and shop/redact promises nothing is left behind.
    expect(await deliveries(t)).toHaveLength(0);
    expect(await jobRows(t)).toHaveLength(0);
  });

  test("a redelivered uninstall is a harmless no-op", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);
    const uninstall = {
      path: "/webhooks/shopify/app/uninstalled",
      topic: "app/uninstalled",
      webhookId: "wh-uninstall",
      payload: {},
    };

    await deliver(t, uninstall);
    // The purge deleted the ledger row that would have deduplicated
    // this, so it runs again — against a tenant that no longer exists,
    // which the route answers 200 to without doing anything.
    const second = await deliver(t, uninstall);
    expect(second.status).toBe(200);
  });
});

describe("security and isolation", () => {
  test("a forged delivery is rejected and recorded nowhere", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    const res = await t.fetch("/webhooks/shopify/products/update", {
      method: "POST",
      headers: {
        "X-Shopify-Shop-Domain": "acme.myshopify.com",
        "X-Shopify-Hmac-Sha256": "not-a-real-signature",
        "X-Shopify-Webhook-Id": "wh-forged",
      },
      body: JSON.stringify({ id: 1, updated_at: "2026-08-26T09:00:00Z" }),
    });

    expect(res.status).toBe(401);
    expect(await deliveries(t)).toHaveLength(0);
    expect(await jobRows(t)).toHaveLength(0);
  });

  test("one tenant's delivery id cannot suppress another's", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "acme");
    await seedTenant(t, "other");

    // Shopify's ids are unique per shop, not globally — and even if they
    // were, a shared namespace would let one merchant's traffic silence
    // another's. The dedupe index leads with the tenant for this reason.
    for (const slug of ["acme", "other"]) {
      await deliver(t, {
        slug,
        webhookId: "wh-collide",
        payload: { id: 1, updated_at: "2026-08-26T09:00:00Z" },
      });
    }

    const rows = await deliveries(t);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.tenantId as string)).size).toBe(2);
    expect(await jobRows(t)).toHaveLength(2);
  });

  test("one tenant's freshness cannot make another's event look stale", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "acme");
    await seedTenant(t, "other");

    await deliver(t, {
      slug: "acme",
      webhookId: "wh-acme",
      payload: { id: 55, updated_at: "2026-08-26T12:00:00Z" },
    });
    await deliver(t, {
      slug: "other",
      webhookId: "wh-other",
      payload: { id: 55, updated_at: "2026-08-26T09:00:00Z" },
    });

    // Same Shopify product id, different shops. The second is older in
    // absolute terms and must still apply.
    const rows = await deliveries(t);
    expect(rows.every((r) => r.outcome === "applied")).toBe(true);
    expect(await jobRows(t)).toHaveLength(2);
  });

  test("a delivery for an unknown shop is acknowledged and stored nowhere", async () => {
    const t = convexTest(schema, modules);
    // No tenant seeded.
    const res = await deliver(t, {
      webhookId: "wh-1",
      payload: { id: 1, updated_at: "2026-08-26T09:00:00Z" },
    });

    // 200 because Shopify retries a non-2xx, and a webhook for a shop we
    // do not have will never succeed.
    expect(res.status).toBe(200);
    expect(await deliveries(t)).toHaveLength(0);
  });
});

describe("retention", () => {
  test("old deliveries are swept and recent ones are kept", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    await deliver(t, {
      webhookId: "wh-old",
      payload: { id: 1, updated_at: "2026-08-26T09:00:00Z" },
    });
    await deliver(t, {
      webhookId: "wh-new",
      payload: { id: 2, updated_at: "2026-08-26T09:00:00Z" },
    });
    const rows = await deliveries(t);
    const oldRow = rows.find((r) => r.webhookId === "wh-old")!;
    await t.run(async (ctx) =>
      ctx.db.patch(oldRow._id, { receivedAt: Date.now() - 90 * 24 * 3600 * 1000 }),
    );

    const deleted = await t.mutation(internal.webhooks.purgeExpiredDeliveries, {
      olderThan: Date.now() - 14 * 24 * 3600 * 1000,
    });

    expect(deleted).toBe(1);
    const remaining = await deliveries(t);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].webhookId).toBe("wh-new");
  });
});
