import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import schema from "./schema";
import { internal } from "./_generated/api";
import { Id } from "./_generated/dataModel";
import { sha256Hex } from "./lib/crypto";
import { SETUP_FEE_USD } from "./lib/dodo";

/**
 * The $400 Disc Initial Setup fee against the real runtime.
 *
 * Mirrors stripe-events.itest.ts's discipline: every webhook test signs
 * a genuine Standard Webhooks signature and posts it to `/webhooks/dodo`,
 * because the status code is part of the contract — a rejected or
 * duplicate event must still answer 200 or a real Dodo delivery would
 * retry it forever.
 *
 * Checkout creation is the one call this suite cannot make for real —
 * no live Dodo credentials are used or available here, by the phase's
 * own constraint — so `fetch` is stubbed for exactly that one boundary,
 * the same way this repo already keeps Stripe's live network call out
 * of billing.itest.ts. Everything on this side of that boundary (the
 * guards in `startCheckout`, and the entire webhook path) runs for real.
 */

const modules = import.meta.glob("./**/*.ts");
const WEBHOOK_SECRET = "whsec_" + btoa("0123456789abcdef0123456789abcdef");

async function seedTenant(
  t: ReturnType<typeof convexTest>,
  slug: string,
  over: Partial<{ invitationId: Id<"invitations">; setupFeeStatus: "unpaid" | "paid" }> = {},
) {
  return await t.run(async (ctx) =>
    ctx.db.insert("tenants", {
      shopDomain: `${slug}.myshopify.com`,
      publicKey: `disc_${slug}`,
      source: "shopify_oauth",
      catalogStatus: "ready",
      brandBrainStatus: "ready",
      widgetStatus: "live",
      subscriptionStatus: "none",
      productCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      invitationId: over.invitationId,
      setupFeeStatus: over.setupFeeStatus,
    }),
  );
}

async function seedInvitedTenant(t: ReturnType<typeof convexTest>, slug: string) {
  const invitationId = await t.run(async (ctx) =>
    ctx.db.insert("invitations", {
      tokenHash: await sha256Hex(`${slug}-token`),
      referenceCode: slug.toUpperCase(),
      status: "pending",
      expiresAt: Date.now() + 60_000,
      createdAt: Date.now(),
    }),
  );
  const tenantId = await seedTenant(t, slug, { invitationId, setupFeeStatus: "unpaid" });
  await t.run(async (ctx) => ctx.db.patch(invitationId, { status: "redeemed", tenantId }));
  return tenantId;
}

/** The Standard Webhooks algorithm, computed independently of lib/crypto.ts. */
async function dodoSignature(id: string, timestamp: string, body: string): Promise<string> {
  const secretB64 = WEBHOOK_SECRET.slice("whsec_".length);
  const keyBytes = Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)),
  );
  let binary = "";
  for (const b of mac) binary += String.fromCharCode(b);
  return `v1,${btoa(binary)}`;
}

function paymentEvent(type: "payment.succeeded" | "payment.failed", tenantId: string, paymentId: string) {
  return {
    business_id: "bus_test",
    type,
    timestamp: new Date().toISOString(),
    data: {
      payment_id: paymentId,
      status: type === "payment.succeeded" ? "succeeded" : "failed",
      metadata: { tenantId },
    },
  };
}

async function send(
  t: ReturnType<typeof convexTest>,
  webhookId: string,
  event: Record<string, unknown>,
) {
  const body = JSON.stringify(event);
  const timestamp = String(Math.floor(Date.now() / 1000));
  return await t.fetch("/webhooks/dodo", {
    method: "POST",
    headers: {
      "webhook-id": webhookId,
      "webhook-timestamp": timestamp,
      "webhook-signature": await dodoSignature(webhookId, timestamp, body),
    },
    body,
  });
}

async function tenantState(t: ReturnType<typeof convexTest>, tenantId: Id<"tenants">) {
  return await t.run(async (ctx) => {
    const tenant = await ctx.db.get(tenantId);
    return { setupFeeStatus: tenant!.setupFeeStatus, setupFeePaidAt: tenant!.setupFeePaidAt };
  });
}

async function ledger(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => ctx.db.query("dodoEvents").collect());
}

beforeEach(() => {
  process.env.DODO_PAYMENTS_WEBHOOK_KEY = WEBHOOK_SECRET;
});
afterEach(() => {
  delete process.env.DODO_PAYMENTS_WEBHOOK_KEY;
});

describe("checkout", () => {
  beforeEach(() => {
    process.env.DODO_PAYMENTS_API_KEY = "test_api_key";
    process.env.DODO_SETUP_FEE_PRODUCT_ID = "prod_setup_fee";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ session_id: "cks_test", checkout_url: "https://test.dodopayments.com/checkout/abc" }),
          { status: 200 },
        ),
      ),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.DODO_PAYMENTS_API_KEY;
    delete process.env.DODO_SETUP_FEE_PRODUCT_ID;
  });

  test("invited-can-checkout: an invited, unpaid tenant can start a checkout", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "invited");

    const result = await t.action(internal.setupFee.startCheckout, {
      tenantId,
      returnUrl: "https://dashboard.example.com/app/overview?setup_fee=success",
    });
    expect(result).toEqual({ url: "https://test.dodopayments.com/checkout/abc" });
  });

  test("non-invited-cannot: a self-serve tenant has no fee to pay", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedTenant(t, "selfserve");

    const result = await t.action(internal.setupFee.startCheckout, {
      tenantId,
      returnUrl: "https://dashboard.example.com/app/overview",
    });
    expect(result).toEqual({ error: "This store has no setup fee to pay" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("an already-paid tenant cannot check out again", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "alreadypaid");
    await t.run(async (ctx) => ctx.db.patch(tenantId, { setupFeeStatus: "paid" }));

    const result = await t.action(internal.setupFee.startCheckout, {
      tenantId,
      returnUrl: "https://dashboard.example.com/app/overview",
    });
    expect(result).toEqual({ error: "The setup fee is already paid" });
    expect(fetch).not.toHaveBeenCalled();
  });

  test("exactly $400, one-time: the request carries one unit of the configured product and no recurring fields", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "amountcheck");

    await t.action(internal.setupFee.startCheckout, {
      tenantId,
      returnUrl: "https://dashboard.example.com/app/overview?setup_fee=success",
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://test.dodopayments.com/checkouts");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.product_cart).toEqual([{ product_id: "prod_setup_fee", quantity: 1 }]);
    // No Stripe-style recurring vocabulary anywhere in the request — the
    // $400 fee has no subscription/mode/trial concept at all.
    expect(body).not.toHaveProperty("mode");
    expect(body).not.toHaveProperty("subscription_data");
    expect(SETUP_FEE_USD).toBe(400);
  });

  test("checkout starting or being cancelled never marks anything paid", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "browserreturn");

    await t.action(internal.setupFee.startCheckout, {
      tenantId,
      returnUrl: "https://dashboard.example.com/app/overview?setup_fee=success",
    });
    // Simulates the merchant's browser landing back on ?setup_fee=success
    // or =cancelled — there is no code path from that redirect to
    // tenant state, only the webhook below has one.
    expect((await tenantState(t, tenantId)).setupFeeStatus).toBe("unpaid");
  });

  test("checkout is unavailable rather than half-working when Dodo is unconfigured", async () => {
    delete process.env.DODO_PAYMENTS_API_KEY;
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "unconfigured");

    const result = await t.action(internal.setupFee.startCheckout, {
      tenantId,
      returnUrl: "https://dashboard.example.com/app/overview",
    });
    expect(result).toEqual({ error: "Setup fee billing is not configured" });
  });
});

describe("webhook", () => {
  test("valid-webhook-marks-paid", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "willpay");

    const res = await send(t, "wh_1", paymentEvent("payment.succeeded", tenantId, "pay_1"));
    expect(res.status).toBe(200);

    const state = await tenantState(t, tenantId);
    expect(state.setupFeeStatus).toBe("paid");
    expect(state.setupFeePaidAt).toBeGreaterThan(0);
  });

  test("invalid-webhook-rejected: a bad signature is refused and recorded nowhere", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "forged");

    const body = JSON.stringify(paymentEvent("payment.succeeded", tenantId, "pay_evil"));
    const res = await t.fetch("/webhooks/dodo", {
      method: "POST",
      headers: {
        "webhook-id": "wh_forged",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-signature": "v1,deadbeef==",
      },
      body,
    });

    expect(res.status).toBe(401);
    expect(await ledger(t)).toHaveLength(0);
    expect((await tenantState(t, tenantId)).setupFeeStatus).toBe("unpaid");
  });

  test("duplicate-webhook-safe: the same delivery twice applies one payment", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "replay");
    const event = paymentEvent("payment.succeeded", tenantId, "pay_dup");

    const first = await send(t, "wh_dup", event);
    const second = await send(t, "wh_dup", event);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await ledger(t)).toHaveLength(1);
    expect((await tenantState(t, tenantId)).setupFeeStatus).toBe("paid");
  });

  test("ten replays of one delivery still apply exactly once", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "tenreplays");
    const event = paymentEvent("payment.succeeded", tenantId, "pay_storm");

    for (let i = 0; i < 10; i++) expect((await send(t, "wh_storm", event)).status).toBe(200);

    expect(await ledger(t)).toHaveLength(1);
    expect((await ledger(t))[0].outcome).toBe("applied");
  });

  test("failed-doesnt-mark-paid: a payment.failed event changes nothing", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "declined");

    const res = await send(t, "wh_failed", paymentEvent("payment.failed", tenantId, "pay_declined"));
    expect(res.status).toBe(200);

    expect((await tenantState(t, tenantId)).setupFeeStatus).toBe("unpaid");
    expect((await ledger(t))[0].outcome).toBe("ignored_unhandled");
  });

  test("cancelled/abandoned checkout: no event ever arrives, so the fee simply stays unpaid", async () => {
    // There is no Dodo "checkout cancelled" webhook in the confirmed
    // event vocabulary (only payment.succeeded / payment.failed) — an
    // abandoned checkout produces no delivery at all. The default state
    // already covers this; nothing to trigger, nothing to assert beyond
    // the tenant never having left "unpaid".
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "abandoned");
    expect((await tenantState(t, tenantId)).setupFeeStatus).toBe("unpaid");
  });

  test("attaches-to-correct-tenant: one tenant's payment cannot mark another's fee paid", async () => {
    const t = convexTest(schema, modules);
    // B pays, not A — deliberately the second tenant created, so a bug
    // that resolves "any unpaid invited tenant" instead of the one the
    // event actually names would land on A (created first) and this
    // test would catch it, rather than passing by coincidence.
    const tenantA = await seedInvitedTenant(t, "correct-a");
    const tenantB = await seedInvitedTenant(t, "correct-b");

    await send(t, "wh_b", paymentEvent("payment.succeeded", tenantB, "pay_b"));

    expect((await tenantState(t, tenantB)).setupFeeStatus).toBe("paid");
    expect((await tenantState(t, tenantA)).setupFeeStatus).toBe("unpaid");
  });

  test("an event naming no resolvable tenant is recorded as unresolved, not applied to anyone", async () => {
    const t = convexTest(schema, modules);
    const res = await send(t, "wh_unresolved", paymentEvent("payment.succeeded", "not-a-real-id", "pay_x"));
    expect(res.status).toBe(200);
    expect((await ledger(t))[0].outcome).toBe("ignored_unresolved");
  });

  test("a request with no webhook-id is refused rather than applied", async () => {
    // Missing `webhook-id` is caught by signature verification itself —
    // the Standard Webhooks signed content requires it, so there is no
    // way to produce a valid signature without one. That is a stronger
    // guarantee than a separate later check would be: this case never
    // reaches the "missing eventId" branch in http.ts at all.
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "noid");
    const body = JSON.stringify(paymentEvent("payment.succeeded", tenantId, "pay_noid"));
    const timestamp = String(Math.floor(Date.now() / 1000));

    const res = await t.fetch("/webhooks/dodo", {
      method: "POST",
      headers: {
        "webhook-timestamp": timestamp,
        "webhook-signature": await dodoSignature("", timestamp, body),
      },
      body,
    });
    expect(res.status).toBe(401);
    expect(await ledger(t)).toHaveLength(0);
  });

  test("replaying a payment after the fee is already paid is a safe no-op", async () => {
    const t = convexTest(schema, modules);
    const tenantId = await seedInvitedTenant(t, "alreadyapplied");
    await t.run(async (ctx) => ctx.db.patch(tenantId, { setupFeeStatus: "paid" }));

    const res = await send(t, "wh_late", paymentEvent("payment.succeeded", tenantId, "pay_late"));
    expect(res.status).toBe(200);
    expect((await ledger(t))[0].outcome).toBe("ignored_already_paid");
    expect((await tenantState(t, tenantId)).setupFeeStatus).toBe("paid");
  });

  test("Stripe subscription code is unaffected by Dodo events", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_fake";
    try {
      const t = convexTest(schema, modules);
      const tenantId = await seedInvitedTenant(t, "bothsystems");
      await t.mutation(internal.billing.applyStripeEvent, {
        tenantId,
        subscriptionStatus: "trialing",
        plan: "pilot",
        customerId: "cus_1",
        subscriptionId: "sub_1",
      });

      await send(t, "wh_both", paymentEvent("payment.succeeded", tenantId, "pay_both"));

      const tenant = await t.run(async (ctx) => await ctx.db.get(tenantId));
      expect(tenant?.subscriptionStatus).toBe("trialing");
      expect(tenant?.plan).toBe("pilot");
      expect(tenant?.setupFeeStatus).toBe("paid");
      // The two systems never touch each other's fields.
      expect(tenant?.stripeCustomerId).toBe("cus_1");
      expect(tenant?.dodoPaymentId).toBe("pay_both");
    } finally {
      delete process.env.STRIPE_SECRET_KEY;
    }
  });
});
