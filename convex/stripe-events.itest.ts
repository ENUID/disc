import { convexTest } from "convex-test";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";

/**
 * Stripe event ledger and ordering (P1.5), against the real route.
 *
 * The audit finding: nothing recorded which Stripe events had been
 * applied, so a replay re-granted access. Re-sending an event from the
 * Stripe dashboard is one click, and `checkout.session.completed` is
 * exactly the event that entitles a merchant.
 *
 * Every test signs a genuine `Stripe-Signature` and posts it to
 * `/webhooks/stripe`, because the status code is part of the contract:
 * Stripe retries a non-2xx, so a duplicate or a refused event must still
 * answer 200 or it is retried forever.
 */

const modules = import.meta.glob("./**/*.ts");

const WEBHOOK_SECRET = "whsec_test_secret";
let previousSecret: string | undefined;

beforeAll(() => {
  previousSecret = process.env.STRIPE_WEBHOOK_SECRET;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});
afterAll(() => {
  if (previousSecret === undefined) delete process.env.STRIPE_WEBHOOK_SECRET;
  else process.env.STRIPE_WEBHOOK_SECRET = previousSecret;
});

/** Stripe's scheme: hex HMAC-SHA256 over `{timestamp}.{raw body}`. */
async function stripeSignature(body: string): Promise<string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)),
  );
  const hex = Array.from(mac)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `t=${timestamp},v1=${hex}`;
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
      subscriptionStatus: "none",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }),
  );
}

/** Post a signed Stripe event exactly as Stripe would. */
async function send(
  t: ReturnType<typeof convexTest>,
  event: Record<string, unknown>,
) {
  const body = JSON.stringify(event);
  return await t.fetch("/webhooks/stripe", {
    method: "POST",
    headers: { "Stripe-Signature": await stripeSignature(body) },
    body,
  });
}

function checkoutCompleted(
  id: string,
  tenantId: string,
  subscription: string,
  plan = "growth",
) {
  return {
    id,
    type: "checkout.session.completed",
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        metadata: { tenantId, plan },
        customer: "cus_1",
        subscription,
      },
    },
  };
}

function subscriptionEvent(
  id: string,
  type: string,
  tenantId: string,
  subscription: string,
  status: string,
) {
  return {
    id,
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      object: {
        id: subscription,
        status,
        metadata: { tenantId, plan: "growth" },
        customer: "cus_1",
      },
    },
  };
}

async function tenantState(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return await t.run(async (ctx) => {
    const tenant = await ctx.db.get(tenantId);
    return {
      status: tenant!.subscriptionStatus,
      subscriptionId: tenant!.stripeSubscriptionId ?? null,
      plan: tenant!.plan ?? null,
    };
  });
}

async function ledger(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("stripeEvents").collect());
}

// =====================================================================

describe("replay and duplicate delivery", () => {
  test("the same event twice applies one transition", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const event = checkoutCompleted("evt_1", tenantId, "sub_A");

    const first = await send(t, event);
    const second = await send(t, event);

    expect(first.status).toBe(200);
    // 200, not an error: Stripe retries a non-2xx, and a duplicate stays
    // a duplicate on redelivery.
    expect(second.status).toBe(200);

    // One row, not two — the existing row is the record of the replay.
    expect(await ledger(t)).toHaveLength(1);
    expect((await tenantState(t, tenantId)).status).toBe("trialing");
  });

  test("ten replays of one event apply one transition", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const event = checkoutCompleted("evt_storm", tenantId, "sub_A");

    for (let i = 0; i < 10; i++) expect((await send(t, event)).status).toBe(200);

    expect(await ledger(t)).toHaveLength(1);
    expect((await ledger(t))[0].outcome).toBe("applied");
  });

  test("a replay cannot re-grant access after a cancellation", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const checkout = checkoutCompleted("evt_checkout", tenantId, "sub_A");
    await send(t, checkout);
    await send(
      t,
      subscriptionEvent("evt_cancel", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );
    expect((await tenantState(t, tenantId)).status).toBe("canceled");

    // THE AUDIT FINDING. Re-sending the original checkout event from the
    // Stripe dashboard is one click, and before P1.5 it handed the
    // merchant their subscription back.
    const replay = await send(t, checkout);
    expect(replay.status).toBe(200);
    expect((await tenantState(t, tenantId)).status).toBe("canceled");
  });

  test("a replay of an ignored event stays ignored", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const event = {
      id: "evt_invoice",
      type: "invoice.payment_succeeded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { metadata: { tenantId }, status: "paid" } },
    };

    await send(t, event);
    await send(t, event);

    const rows = await ledger(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe("ignored_unhandled");
    expect((await tenantState(t, tenantId)).status).toBe("none");
  });

  test("concurrent deliveries of one event produce one row and one transition", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    const event = checkoutCompleted("evt_race", tenantId, "sub_A");

    await Promise.all(Array.from({ length: 5 }, () => send(t, event)));

    // What this proves: the read-then-insert guard is correct. What it
    // does NOT prove is Convex's isolation — as recorded in
    // PRODUCTION_JOB_STATE.md, convex-test cannot be made to distinguish
    // interleaving from end-to-end serialisation from outside. Exactly
    // one row under real concurrency rests on Convex's documented
    // serializable isolation of mutations.
    expect(await ledger(t)).toHaveLength(1);
    expect((await tenantState(t, tenantId)).status).toBe("trialing");
  });
});

describe("out-of-order delivery", () => {
  test("A. cancellation after activation, delivered in order", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await send(t, checkoutCompleted("evt_1", tenantId, "sub_A"));
    await send(
      t,
      subscriptionEvent("evt_2", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );

    expect((await tenantState(t, tenantId)).status).toBe("canceled");
  });

  test("B. the same pair delivered in reverse ends in the same place", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // Cancellation first, activation second. The final state must
    // reflect the authoritative Stripe state, not the arrival order.
    await send(
      t,
      subscriptionEvent("evt_2", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );
    await send(t, checkoutCompleted("evt_1", tenantId, "sub_A"));

    expect((await tenantState(t, tenantId)).status).toBe("canceled");
  });

  test("C. a stale activation cannot roll a cancelled subscription forward", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await send(
      t,
      subscriptionEvent("evt_cancel", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );
    const late = await send(
      t,
      subscriptionEvent("evt_active", "customer.subscription.updated", tenantId, "sub_A", "active"),
    );

    expect(late.status).toBe(200);
    expect((await tenantState(t, tenantId)).status).toBe("canceled");

    const refused = (await ledger(t)).find((r) => r.eventId === "evt_active");
    expect(refused?.outcome).toBe("ignored_stale");
    expect(refused?.reason).toBe("revives_terminal");
  });

  test("D. checkout completion arriving after a newer cancellation", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // The regression this phase exists to prevent, stated as the user
    // did: canceled -> checkout.session.completed must NOT become
    // trialing.
    await send(
      t,
      subscriptionEvent("evt_cancel", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );
    await send(t, checkoutCompleted("evt_checkout", tenantId, "sub_A"));

    const state = await tenantState(t, tenantId);
    expect(state.status).toBe("canceled");
    expect((await ledger(t)).find((r) => r.eventId === "evt_checkout")?.reason).toBe(
      "revives_terminal",
    );
  });

  test("E. an old cancellation cannot end the subscription now held", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    // sub_A is cancelled, the merchant resubscribes as sub_B, and only
    // then does sub_A's deleted event arrive.
    await send(
      t,
      subscriptionEvent("evt_a_cancel", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );
    await send(t, checkoutCompleted("evt_b_checkout", tenantId, "sub_B"));
    expect((await tenantState(t, tenantId)).status).toBe("trialing");

    const late = await send(
      t,
      subscriptionEvent("evt_a_late", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );

    // Acting on it would take access from a merchant who is paying.
    expect(late.status).toBe(200);
    expect((await tenantState(t, tenantId)).status).toBe("trialing");
    expect((await ledger(t)).find((r) => r.eventId === "evt_a_late")?.reason).toBe(
      "cancels_superseded",
    );
  });

  test("F. resubscribing after a cancellation restores access", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await send(
      t,
      subscriptionEvent("evt_cancel", "customer.subscription.deleted", tenantId, "sub_A", "active"),
    );
    await send(t, checkoutCompleted("evt_new", tenantId, "sub_B"));

    // The deliberate asymmetry: a merchant genuinely coming back must not
    // be locked out by a rule written to protect them.
    const state = await tenantState(t, tenantId);
    expect(state.status).toBe("trialing");
    expect(state.subscriptionId).toBe("sub_B");
  });

  test("different event ids describing the same subscription each apply once", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await send(t, checkoutCompleted("evt_1", tenantId, "sub_A"));
    await send(
      t,
      subscriptionEvent("evt_2", "customer.subscription.updated", tenantId, "sub_A", "active"),
    );
    await send(
      t,
      subscriptionEvent("evt_3", "customer.subscription.updated", tenantId, "sub_A", "past_due"),
    );

    // Distinct events, so no deduplication — each is real news about the
    // same subscription.
    expect(await ledger(t)).toHaveLength(3);
    expect((await tenantState(t, tenantId)).status).toBe("past_due");
  });

  test("payment failing and recovering is not blocked by the guard", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    await send(t, checkoutCompleted("evt_1", tenantId, "sub_A"));
    await send(
      t,
      subscriptionEvent("evt_2", "customer.subscription.updated", tenantId, "sub_A", "past_due"),
    );
    expect((await tenantState(t, tenantId)).status).toBe("past_due");

    await send(
      t,
      subscriptionEvent("evt_3", "customer.subscription.updated", tenantId, "sub_A", "active"),
    );
    // past_due is recoverable — a merchant can fix a card. Treating it as
    // terminal would permanently lock out a paying customer.
    expect((await tenantState(t, tenantId)).status).toBe("active");
  });
});

describe("events Disc does not act on", () => {
  test("an unknown event type is recorded and changes nothing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const res = await send(t, {
      id: "evt_unknown",
      type: "payment_intent.succeeded",
      created: Math.floor(Date.now() / 1000),
      data: { object: { metadata: { tenantId } } },
    });

    // Never retried forever merely because Disc does not care about it.
    expect(res.status).toBe(200);
    expect((await ledger(t))[0].outcome).toBe("ignored_unhandled");
    expect((await tenantState(t, tenantId)).status).toBe("none");
  });

  test("an event naming no tenant is recorded as unresolved", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    const res = await send(t, {
      id: "evt_no_tenant",
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "sub_X", status: "active" } },
    });

    expect(res.status).toBe(200);
    expect((await ledger(t))[0].outcome).toBe("ignored_unhandled");
  });

  test("a malformed tenant id is a quiet no-op, not durable corruption", async () => {
    const t = convexTest(schema, modules);
    await seedTenant(t);

    const res = await send(t, {
      id: "evt_junk_tenant",
      type: "customer.subscription.updated",
      created: Math.floor(Date.now() / 1000),
      data: {
        object: { id: "sub_X", status: "active", metadata: { tenantId: "not-an-id" } },
      },
    });

    // A v.id validator would throw here, turning junk metadata into a
    // 500 that Stripe then retries forever.
    expect(res.status).toBe(200);
    const row = (await ledger(t))[0];
    expect(row.outcome).toBe("ignored_unresolved");
    expect(row.claimedTenantId).toBe("not-an-id");
    expect(row.tenantId).toBeUndefined();
  });

  test("the tenant is never guessed from a customer id", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await t.run(async (ctx) => ctx.db.patch(tenantId, { stripeCustomerId: "cus_known" }));

    // A customer id Disc has seen, but no tenant in the metadata. Using
    // the customer mapping would let a stray event move a tenant that
    // never named itself.
    await send(t, {
      id: "evt_customer_only",
      type: "customer.subscription.deleted",
      created: Math.floor(Date.now() / 1000),
      data: { object: { id: "sub_X", status: "active", customer: "cus_known" } },
    });

    expect((await tenantState(t, tenantId)).status).toBe("none");
    expect((await ledger(t))[0].outcome).toBe("ignored_unhandled");
  });
});

describe("verification and auditability", () => {
  test("an unsigned event is refused and recorded nowhere", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const res = await t.fetch("/webhooks/stripe", {
      method: "POST",
      headers: { "Stripe-Signature": "t=1,v1=deadbeef" },
      body: JSON.stringify(checkoutCompleted("evt_forged", tenantId, "sub_A")),
    });

    expect(res.status).toBe(401);
    expect(await ledger(t)).toHaveLength(0);
    expect((await tenantState(t, tenantId)).status).toBe("none");
  });

  test("a signed event with no id is refused rather than applied", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);

    const res = await send(t, {
      type: "checkout.session.completed",
      data: { object: { metadata: { tenantId }, subscription: "sub_A" } },
    });

    // An event that cannot be identified cannot be deduplicated, and an
    // undeduplicable event is one that can be replayed to re-grant
    // access. Refusing is the safe direction here — unlike a Shopify
    // delivery, where losing dedupe costs a duplicate read.
    expect(res.status).toBe(400);
    expect(await ledger(t)).toHaveLength(0);
    expect((await tenantState(t, tenantId)).status).toBe("none");
  });

  test("the ledger answers what an operator needs to ask", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await send(t, checkoutCompleted("evt_audit", tenantId, "sub_A", "enterprise"));

    const row = (await ledger(t))[0];
    expect(row.eventId).toBe("evt_audit");            // was it received?
    expect(row.outcome).toBe("applied");              // was it processed?
    expect(row.tenantId).toBe(tenantId);              // which tenant?
    expect(row.eventType).toBe("checkout.session.completed");
    expect(row.appliedStatus).toBe("trialing");       // what did it do?
    expect(row.receivedAt).toBeGreaterThan(0);        // when?
    expect(row.stripeSubscriptionId).toBe("sub_A");

    // `created` is stored for audit and never used to order anything —
    // Stripe records it in whole seconds and says so explicitly.
    expect(typeof row.eventCreated).toBe("number");
  });

  test("no authorization material reaches the ledger", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await send(t, checkoutCompleted("evt_secret", tenantId, "sub_A"));

    const serialised = JSON.stringify(await ledger(t));
    expect(serialised).not.toContain(WEBHOOK_SECRET);
    expect(serialised.toLowerCase()).not.toContain("whsec");
    expect(serialised.toLowerCase()).not.toContain("authorization");
  });
});

describe("isolation and retention", () => {
  test("one tenant's event cannot move another's subscription", async () => {
    const t = convexTest(schema, modules);
    const acme = await seedTenant(t, "acme");
    const other = await seedTenant(t, "other");

    await send(t, checkoutCompleted("evt_acme", acme, "sub_A"));

    expect((await tenantState(t, acme)).status).toBe("trialing");
    expect((await tenantState(t, other)).status).toBe("none");
  });

  test("purging a tenant removes its billing events", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await send(t, checkoutCompleted("evt_1", tenantId, "sub_A"));
    expect(await ledger(t)).toHaveLength(1);

    await t.mutation(internal.tenants.purgeTenant, { tenantId });
    expect(await ledger(t)).toHaveLength(0);
  });

  test("old events are swept and recent ones are kept", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t);
    await send(t, checkoutCompleted("evt_old", tenantId, "sub_A"));
    await send(
      t,
      subscriptionEvent("evt_new", "customer.subscription.updated", tenantId, "sub_A", "active"),
    );

    const old = (await ledger(t)).find((r) => r.eventId === "evt_old")!;
    await t.run(async (ctx) =>
      ctx.db.patch(old._id, { receivedAt: Date.now() - 200 * 24 * 3600 * 1000 }),
    );

    const deleted = await t.mutation(internal.billing.purgeExpiredStripeEvents, {
      olderThan: Date.now() - 45 * 24 * 3600 * 1000,
    });

    expect(deleted).toBe(1);
    const remaining = await ledger(t);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].eventId).toBe("evt_new");
  });
});
