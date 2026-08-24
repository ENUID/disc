import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import {
  createCheckoutSession,
  createPortalSession,
  PLANS,
  planForCatalog,
  TRIAL_DAYS,
  type PlanKey,
  type StripeConfig,
} from "./lib/billing";
import { billingEnabled, env } from "./lib/env";
import { checkRateLimit, rateLimitKey, RULES, type RuleName } from "./lib/rate-limit";

/**
 * Billing and rate limiting.
 *
 * §133 requires four things to work: start a trial, subscribe, upgrade,
 * cancel — and Disc must change access state correctly for each. Three
 * of those happen inside Stripe's own portal; all four arrive back here
 * as webhooks, which is why the webhook is the load-bearing part rather
 * than the checkout call.
 */

function stripeConfig(): StripeConfig {
  return {
    secretKey: env("STRIPE_SECRET_KEY"),
    priceIds: {
      pilot: env("STRIPE_PRICE_PILOT"),
      growth: env("STRIPE_PRICE_GROWTH"),
      enterprise: env("STRIPE_PRICE_ENTERPRISE"),
    },
  };
}

/** Plans, for the merchant billing page. Never exposes price ids. */
export const plans = internalQuery({
  args: {},
  handler: async () => ({
    plans: Object.values(PLANS).map((p) => ({
      key: p.key,
      name: p.name,
      price: p.price,
      catalogLimit: p.catalogLimit,
    })),
    trialDays: TRIAL_DAYS,
    enabled: billingEnabled(),
  }),
});

export const billingState = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;

    const suggested = planForCatalog(tenant.productCount);
    return {
      enabled: billingEnabled(),
      subscriptionStatus: tenant.subscriptionStatus,
      plan: tenant.plan ?? null,
      // Suggested rather than enforced: a merchant who outgrows a tier
      // should be asked to upgrade, not cut off mid-month.
      suggestedPlan: suggested,
      productCount: tenant.productCount,
      overCatalogLimit: isOverLimit(tenant),
      hasCustomer: Boolean(tenant.stripeCustomerId),
      trialDays: TRIAL_DAYS,
    };
  },
});

function isOverLimit(tenant: Doc<"tenants">): boolean {
  const plan = tenant.plan ? PLANS[tenant.plan as PlanKey] : undefined;
  if (!plan || plan.catalogLimit === null) return false;
  return tenant.productCount > plan.catalogLimit;
}

/**
 * Internal, not public. A public action is callable by anyone holding the
 * deployment URL, and this one takes a tenant id as an argument — which
 * would let a stranger open a checkout session against another
 * merchant's account. The only caller is the authenticated HTTP route.
 */
export const startCheckout = internalAction({
  args: {
    tenantId: v.id("tenants"),
    plan: v.optional(v.string()),
    successUrl: v.string(),
    cancelUrl: v.string(),
  },
  handler: async (ctx, args): Promise<{ url: string } | { error: string }> => {
    if (!billingEnabled()) return { error: "Billing is not configured" };

    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.getById, {
      tenantId: args.tenantId,
    });
    if (!tenant) return { error: "Unknown tenant" };

    // Defaults to the cheapest tier covering the catalog, so a merchant
    // with 80 products is never quoted the price of a 5,000-product one.
    const plan = (args.plan as PlanKey) ?? planForCatalog(tenant.productCount);
    if (!PLANS[plan]) return { error: `Unknown plan: ${plan}` };

    try {
      const url = await createCheckoutSession(stripeConfig(), {
        tenantId: args.tenantId,
        shopDomain: tenant.shopDomain,
        plan,
        successUrl: args.successUrl,
        cancelUrl: args.cancelUrl,
      });
      // Recorded as pending, not active. Nothing is paid until Stripe
      // says so through the webhook — marking it here would entitle a
      // merchant who abandoned the checkout page.
      await ctx.runMutation(internal.tenants.setSubscription, {
        tenantId: args.tenantId,
        subscriptionStatus: "pending",
        plan,
      });
      return { url };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

/** Upgrade, downgrade, change card, cancel — all of §133 bar the first. */
export const openPortal = internalAction({
  args: { tenantId: v.id("tenants"), returnUrl: v.string() },
  handler: async (ctx, args): Promise<{ url: string } | { error: string }> => {
    if (!billingEnabled()) return { error: "Billing is not configured" };

    const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.getById, {
      tenantId: args.tenantId,
    });
    if (!tenant?.stripeCustomerId) {
      return { error: "No subscription to manage yet" };
    }

    try {
      return {
        url: await createPortalSession(
          stripeConfig(),
          tenant.stripeCustomerId,
          args.returnUrl,
        ),
      };
    } catch (error) {
      return { error: (error as Error).message };
    }
  },
});

/**
 * Apply a verified Stripe event.
 *
 * The signature was checked against the raw body before this runs (see
 * http.ts). This is where access state actually changes, so it is the
 * single place a cancellation takes effect — `/search` reads the cached
 * status rather than calling Stripe per query.
 */
export const applyStripeEvent = internalMutation({
  args: {
    // A string, not v.id: this value comes back from Stripe's metadata,
    // and a v.id validator would throw on anything malformed — turning a
    // junk id into a 500 that Stripe then retries forever. Normalised
    // below instead, so an unknown tenant is a quiet no-op.
    tenantId: v.string(),
    subscriptionStatus: v.string(),
    plan: v.optional(v.string()),
    customerId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const tenantId = ctx.db.normalizeId("tenants", args.tenantId);
    if (!tenantId) return false;

    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return false;

    await ctx.db.patch(tenantId, {
      subscriptionStatus: args.subscriptionStatus,
      plan: args.plan ?? tenant.plan,
      stripeCustomerId: args.customerId ?? tenant.stripeCustomerId,
      stripeSubscriptionId: args.subscriptionId ?? tenant.stripeSubscriptionId,
      updatedAt: Date.now(),
    });
    return true;
  },
});

/**
 * Rate limiting (spec §90).
 *
 * A mutation because it must read-then-write atomically; two concurrent
 * requests reading the same count would otherwise both be admitted.
 */
export const consumeRateLimit = internalMutation({
  args: { rule: v.string(), tenantId: v.string() },
  returns: v.object({
    allowed: v.boolean(),
    remaining: v.number(),
    retryAfterSeconds: v.number(),
  }),
  handler: async (ctx, { rule, tenantId }) => {
    const ruleConfig = RULES[rule as RuleName];
    if (!ruleConfig) {
      // An unknown rule must not silently disable limiting; fail open
      // but visibly, since blocking real shoppers over a typo is worse.
      console.warn(`unknown rate limit rule: ${rule}`);
      return { allowed: true, remaining: 0, retryAfterSeconds: 0 };
    }

    const key = rateLimitKey(rule as RuleName, tenantId);
    const existing = await ctx.db
      .query("rateLimits")
      .withIndex("by_key", (q) => q.eq("key", key))
      .unique();

    const decision = checkRateLimit(
      ruleConfig,
      existing ? { windowStart: existing.windowStart, count: existing.count } : null,
      Date.now(),
    );

    if (existing) await ctx.db.patch(existing._id, decision.next);
    else await ctx.db.insert("rateLimits", { key, ...decision.next });

    return {
      allowed: decision.allowed,
      remaining: decision.remaining,
      retryAfterSeconds: decision.retryAfterSeconds,
    };
  },
});

/** Sweep expired windows so the table does not grow without bound. */
export const purgeRateLimits = internalMutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const cutoff = Date.now() - 24 * 3_600_000;
    const stale = await ctx.db
      .query("rateLimits")
      .filter((q) => q.lt(q.field("windowStart"), cutoff))
      .take(500);
    for (const row of stale) await ctx.db.delete(row._id);
    return stale.length;
  },
});
