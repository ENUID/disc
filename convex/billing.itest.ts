import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import schema from "./schema";
import { api, internal } from "./_generated/api";
import { RULES } from "./lib/rate-limit";

/**
 * Billing and rate limiting against the real runtime.
 *
 * §133 names four flows that must work: start a trial, subscribe,
 * upgrade, cancel — and Disc must change access state correctly for
 * each. Three of them happen inside Stripe's own portal and reach us
 * only as webhooks, so what is actually being tested here is that a
 * verified event moves the tenant's entitlement, and that the storefront
 * sees the change.
 *
 * Stripe itself is never called: `interpretStripeEvent` is pure and
 * tested separately, so these drive `applyStripeEvent` with the payload
 * shapes Stripe documents.
 */

const modules = import.meta.glob("./**/*.ts");

async function seedTenant(t: ReturnType<typeof convexTest>, subscriptionStatus = "none") {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("tenants", {
      shopDomain: "acme.myshopify.com",
      publicKey: "disc_acme",
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus,
      productCount: 120,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

/**
 * Billing only gates anything when Stripe is configured — a deployment
 * that cannot take money must not lock out the merchants it already
 * has. These tests need it on, so the key is set for their duration.
 */
describe("with billing enabled", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  test("§133: trial, subscribe, upgrade, cancel each move access state", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const active = async () =>
      (await t.query(api.tenants.storefrontConfig, { publicKey: "disc_acme" }))?.active;
    const stored = async () => await t.run(async (ctx) => await ctx.db.get(tenantId));

    // Before anything is paid, the storefront stays dormant.
    expect(await active()).toBe(false);

    // 1. Start a trial — checkout completed.
    await t.mutation(internal.billing.applyStripeEvent, {
      tenantId,
      subscriptionStatus: "trialing",
      plan: "pilot",
      customerId: "cus_1",
      subscriptionId: "sub_1",
    });
    expect(await active()).toBe(true);
    expect((await stored())?.plan).toBe("pilot");
    expect((await stored())?.stripeCustomerId).toBe("cus_1");

    // 2. Trial converts to a paid subscription.
    await t.mutation(internal.billing.applyStripeEvent, {
      tenantId,
      subscriptionStatus: "active",
      plan: "pilot",
    });
    expect(await active()).toBe(true);
    // Identifiers set by an earlier event survive a later one that omits
    // them — Stripe does not resend every field on every event.
    expect((await stored())?.stripeCustomerId).toBe("cus_1");
    expect((await stored())?.stripeSubscriptionId).toBe("sub_1");

    // 3. Upgrade. Still entitled, now on a different plan.
    await t.mutation(internal.billing.applyStripeEvent, {
      tenantId,
      subscriptionStatus: "active",
      plan: "growth",
    });
    expect(await active()).toBe(true);
    expect((await stored())?.plan).toBe("growth");

    // 4. Cancel. This is the one that has to work, because /search reads
    // the cached status rather than asking Stripe per query.
    await t.mutation(internal.billing.applyStripeEvent, {
      tenantId,
      subscriptionStatus: "canceled",
    });
    expect(await active()).toBe(false);
    // The plan is remembered through cancellation: it is what the
    // merchant resubscribes to, and what their history says they had.
    expect((await stored())?.plan).toBe("growth");
  });

  test("a failed payment withdraws access", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "active");

    await t.mutation(internal.billing.applyStripeEvent, {
      tenantId,
      subscriptionStatus: "past_due",
    });

    const config = await t.query(api.tenants.storefrontConfig, { publicKey: "disc_acme" });
    expect(config?.active).toBe(false);
  });

  test("the storefront never learns the subscription vocabulary", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t, "past_due");

    const config = await t.query(api.tenants.storefrontConfig, { publicKey: "disc_acme" });
    // One boolean to branch on. No plan, no Stripe status, no customer
    // id — a storefront's page source is public.
    expect(Object.keys(config ?? {}).sort()).toEqual([
      "active",
      "brandTokens",
      "catalogStatus",
      "publicKey",
      "widgetConfig",
      "widgetStatus",
    ]);
  });
});

test("with billing unconfigured, every existing merchant keeps working", async () => {
  const t = convexTest(schema, modules);
  // Deliberately the worst status there is.
  await seedTenant(t, "canceled");

  const config = await t.query(api.tenants.storefrontConfig, { publicKey: "disc_acme" });
  expect(config?.active).toBe(true);
});

test("checkout is unavailable rather than half-working without Stripe", async () => {
  const t = convexTest(schema, modules);
  const tenantId = await seedTenant(t);

  const result = await t.action(internal.billing.startCheckout, {
    tenantId,
    successUrl: "https://example.com/ok",
    cancelUrl: "https://example.com/no",
  });
  expect(result).toEqual({ error: "Billing is not configured" });

  // And nothing was recorded — a merchant must not end up marked
  // "pending" by a call that never reached Stripe.
  const tenant = await t.run(async (ctx) => await ctx.db.get(tenantId));
  expect(tenant?.subscriptionStatus).toBe("none");
});

test("the portal refuses before there is a customer to manage", async () => {
  process.env.STRIPE_SECRET_KEY = "sk_test_fake";
  try {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const result = await t.action(internal.billing.openPortal, {
      tenantId,
      returnUrl: "https://example.com/app/billing",
    });
    expect(result).toEqual({ error: "No subscription to manage yet" });
  } finally {
    delete process.env.STRIPE_SECRET_KEY;
  }
});

test("an event naming an unknown tenant is a no-op, not a crash", async () => {
  const t = convexTest(schema, modules);
  // Stripe retries non-2xx forever. A malformed tenant id arriving in
  // metadata must not become an error the webhook route reports, or one
  // junk event is retried until it is manually purged.
  const applied = await t.mutation(internal.billing.applyStripeEvent, {
    tenantId: "not-a-convex-id",
    subscriptionStatus: "active",
  });
  expect(applied).toBe(false);
});

test("billing state suggests a plan that covers the catalog", async () => {
  const t = convexTest(schema, modules);
  const tenantId = await seedTenant(t);

  const state = await t.query(internal.billing.billingState, { tenantId });
  expect(state?.suggestedPlan).toBe("pilot"); // 120 products
  expect(state?.overCatalogLimit).toBe(false);

  // A merchant who outgrows their tier is flagged, not cut off.
  await t.run(async (ctx) => {
    await ctx.db.patch(tenantId, { plan: "pilot", productCount: 4000 });
  });
  const grown = await t.query(internal.billing.billingState, { tenantId });
  expect(grown?.suggestedPlan).toBe("growth");
  expect(grown?.overCatalogLimit).toBe(true);
});

// ---------------------------------------------------------------------

describe("rate limiting", () => {
  test("admits exactly the configured number, then blocks", async () => {
    const t = convexTest(schema, modules);

    let allowed = 0;
    for (let i = 0; i < RULES.resync.limit + 3; i++) {
      const decision = await t.mutation(internal.billing.consumeRateLimit, {
        rule: "resync",
        tenantId: "tenant_a",
      });
      if (decision.allowed) allowed++;
      else expect(decision.retryAfterSeconds).toBeGreaterThan(0);
    }
    expect(allowed).toBe(RULES.resync.limit);
  });

  test("one tenant cannot exhaust another's budget", async () => {
    const t = convexTest(schema, modules);

    for (let i = 0; i < RULES.resync.limit; i++) {
      await t.mutation(internal.billing.consumeRateLimit, {
        rule: "resync",
        tenantId: "noisy",
      });
    }
    const noisy = await t.mutation(internal.billing.consumeRateLimit, {
      rule: "resync",
      tenantId: "noisy",
    });
    expect(noisy.allowed).toBe(false);

    const quiet = await t.mutation(internal.billing.consumeRateLimit, {
      rule: "resync",
      tenantId: "quiet",
    });
    expect(quiet.allowed).toBe(true);
  });

  test("rules hold separate budgets for the same tenant", async () => {
    const t = convexTest(schema, modules);

    for (let i = 0; i < RULES.resync.limit; i++) {
      await t.mutation(internal.billing.consumeRateLimit, {
        rule: "resync",
        tenantId: "tenant_a",
      });
    }
    expect(
      (await t.mutation(internal.billing.consumeRateLimit, {
        rule: "resync",
        tenantId: "tenant_a",
      })).allowed,
    ).toBe(false);

    // Exhausting resync must not stop that shop's shoppers searching.
    expect(
      (await t.mutation(internal.billing.consumeRateLimit, {
        rule: "search",
        tenantId: "tenant_a",
      })).allowed,
    ).toBe(true);
  });

  test("one row per tenant per rule, not one per request", async () => {
    const t = convexTest(schema, modules);
    for (let i = 0; i < 10; i++) {
      await t.mutation(internal.billing.consumeRateLimit, {
        rule: "search",
        tenantId: "tenant_a",
      });
    }
    const rows = await t.run(async (ctx) => await ctx.db.query("rateLimits").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(10);
  });

  test("an unknown rule fails open, loudly", async () => {
    const t = convexTest(schema, modules);
    // Blocking real shoppers because of a typo in a rule name is worse
    // than not limiting that one path.
    const decision = await t.mutation(internal.billing.consumeRateLimit, {
      rule: "typo",
      tenantId: "tenant_a",
    });
    expect(decision.allowed).toBe(true);
    const rows = await t.run(async (ctx) => await ctx.db.query("rateLimits").collect());
    expect(rows).toHaveLength(0);
  });

  test("the sweep drops expired windows and keeps live ones", async () => {
    const t = convexTest(schema, modules);
    const now = Date.now();

    await t.run(async (ctx) => {
      await ctx.db.insert("rateLimits", {
        key: "search:old",
        windowStart: now - 48 * 3_600_000,
        count: 5,
      });
      await ctx.db.insert("rateLimits", {
        key: "search:fresh",
        windowStart: now,
        count: 1,
      });
    });

    const purged = await t.mutation(internal.billing.purgeRateLimits, {});
    expect(purged).toBe(1);

    const rows = await t.run(async (ctx) => await ctx.db.query("rateLimits").collect());
    expect(rows.map((r) => r.key)).toEqual(["search:fresh"]);
  });
});
