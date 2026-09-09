import { v } from "convex/values";
import { internalAction, internalMutation } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  createSetupFeeCheckoutSession,
  interpretDodoEvent,
  type DodoConfig,
} from "./lib/dodo";
import { DODO_PAYMENTS_API_KEY, DODO_SETUP_FEE_PRODUCT_ID, setupFeeEnabled } from "./lib/env";

/**
 * The $400 Disc Initial Setup fee — Dodo Payments, one-time.
 *
 * Structured exactly like billing.ts's Stripe flow, one concern
 * narrower: start a checkout (grants nothing), apply a verified payment
 * (the only place `setupFeeStatus` becomes "paid"), record-and-dedupe an
 * event so a replayed webhook cannot apply a payment twice.
 */

function dodoConfig(): DodoConfig {
  return { apiKey: DODO_PAYMENTS_API_KEY(), productId: DODO_SETUP_FEE_PRODUCT_ID() };
}

/**
 * Internal, not public — same reasoning as `billing.startCheckout`: a
 * public action taking a tenant id would let a stranger open a checkout
 * against another merchant's account. The only caller is the
 * authenticated `/merchant/setup-fee/checkout` route.
 */
export const startCheckout = internalAction({
  args: { tenantId: v.id("tenants"), returnUrl: v.string() },
  handler: async (ctx, args): Promise<{ url: string } | { error: string }> => {
    if (!setupFeeEnabled()) return { error: "Setup fee billing is not configured" };

    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.getById, {
      tenantId: args.tenantId,
    });
    if (!tenant) return { error: "Unknown tenant" };
    if (!tenant.invitationId) {
      // INVITED != PAID != ACTIVE, but also: only an invited tenant has
      // a $400 fee to pay at all. A self-serve tenant asking for this
      // checkout is not a state this product has.
      return { error: "This store has no setup fee to pay" };
    }
    if (tenant.setupFeeStatus === "paid") {
      return { error: "The setup fee is already paid" };
    }

    try {
      const url = await createSetupFeeCheckoutSession(dodoConfig(), {
        tenantId: args.tenantId,
        shopDomain: tenant.shopDomain,
        returnUrl: args.returnUrl,
      });
      // No state change here. Exactly like Stripe checkout: nothing is
      // paid until the webhook says so, and a merchant who opens this
      // page and abandons it must not be treated any differently than
      // one who never opened it.
      return { url };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

/**
 * Apply a verified, resolved Dodo payment. The ONLY place
 * `setupFeeStatus` is ever set to "paid" — never a browser redirect,
 * never a checkout return url, only this, and only called from
 * `recordDodoEvent` after the event has been verified, deduplicated and
 * resolved to a real tenant.
 */
export const applySetupFeePayment = internalMutation({
  args: { tenantId: v.string(), dodoPaymentId: v.optional(v.string()) },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const tenantId = ctx.db.normalizeId("tenants", args.tenantId);
    if (!tenantId) return false;
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return false;

    await ctx.db.patch(tenantId, {
      setupFeeStatus: "paid",
      setupFeePaidAt: Date.now(),
      dodoPaymentId: args.dodoPaymentId ?? tenant.dodoPaymentId,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Record a verified Dodo event and act on it exactly once.
 *
 * Same shape as `billing.recordStripeEvent`: dedupe -> interpret ->
 * resolve tenant -> apply -> record, all in one Convex transaction, so a
 * ledger entry and the tenant's paid state can never disagree.
 *
 * Simpler than the Stripe version by construction: there is no
 * subscription lifecycle to reorder against, so there is no transition
 * guard. "Already paid" is handled by treating it as a no-op outcome
 * rather than by comparing versions — applying "paid" twice is already
 * idempotent, so all that is needed is to say so in the ledger.
 */
export const recordDodoEvent = internalMutation({
  args: {
    eventId: v.string(),
    event: v.any(),
  },
  returns: v.object({ outcome: v.string(), duplicate: v.boolean() }),
  handler: async (ctx, args) => {
    const seen = await ctx.db
      .query("dodoEvents")
      .withIndex("by_event_id", (q) => q.eq("eventId", args.eventId))
      .unique();
    if (seen) {
      return { outcome: seen.outcome, duplicate: true };
    }

    const receivedAt = Date.now();
    const rawEvent = args.event as Record<string, unknown>;
    const eventType = typeof rawEvent?.type === "string" ? rawEvent.type : "unknown";
    const outcome = interpretDodoEvent(args.event);

    const base = {
      eventId: args.eventId,
      eventType,
      claimedTenantId: outcome.tenantId ?? undefined,
      dodoPaymentId: outcome.paymentId ?? undefined,
      receivedAt,
    };

    if (!outcome.handled || outcome.kind === "failed") {
      // A failed payment is recorded and changes nothing — the fee
      // stays unpaid, which is already its state. Recording it (rather
      // than dropping it silently) is what makes "why hasn't this
      // merchant paid" answerable from the ledger alone.
      await ctx.db.insert("dodoEvents", { ...base, outcome: "ignored_unhandled" });
      return { outcome: "ignored_unhandled", duplicate: false };
    }

    const tenantId = outcome.tenantId ? ctx.db.normalizeId("tenants", outcome.tenantId) : null;
    const tenant = tenantId ? await ctx.db.get(tenantId) : null;

    if (!tenant || !tenantId) {
      await ctx.db.insert("dodoEvents", { ...base, outcome: "ignored_unresolved" });
      return { outcome: "ignored_unresolved", duplicate: false };
    }

    if (tenant.setupFeeStatus === "paid") {
      await ctx.db.insert("dodoEvents", { ...base, tenantId, outcome: "ignored_already_paid" });
      return { outcome: "ignored_already_paid", duplicate: false };
    }

    await ctx.runMutation(internal.setupFee.applySetupFeePayment, {
      tenantId: outcome.tenantId!,
      dodoPaymentId: outcome.paymentId ?? undefined,
    });

    await ctx.db.insert("dodoEvents", { ...base, tenantId, outcome: "applied" });
    return { outcome: "applied", duplicate: false };
  },
});

/** Age out the Dodo event ledger. */
export const purgeExpiredDodoEvents = internalMutation({
  args: { olderThan: v.number(), limit: v.optional(v.number()) },
  returns: v.number(),
  handler: async (ctx, args) => {
    const stale = await ctx.db
      .query("dodoEvents")
      .withIndex("by_received", (q) => q.lt("receivedAt", args.olderThan))
      .take(Math.min(args.limit ?? 200, 1000));
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
