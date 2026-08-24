/**
 * Billing (spec §76, §111-§113).
 *
 * Stripe, not Shopify Billing — and that is forced rather than chosen.
 * Disc uses custom distribution so it can install on a merchant's store
 * without App Store review, and Shopify's documented constraint is that
 * custom apps cannot use the Billing API. If Disc is ever listed
 * publicly this must move to Shopify Billing, and §111 is explicit that
 * two active billing sources without reconciliation is not acceptable.
 *
 * Called over `fetch` rather than the Stripe SDK: the whole integration
 * is three endpoints, and the only non-obvious part is webhook signature
 * verification, which is implemented and tested in `crypto.ts` rather
 * than trusted blindly.
 */

export const STRIPE_API = "https://api.stripe.com/v1";

/**
 * Pricing (spec §77, §112).
 *
 * These are the spec's own hypothesis, and §112 says to test them with
 * real merchants rather than treat them as settled. §113 states what a
 * merchant at this tier must actually receive, which is the bar these
 * numbers have to justify.
 *
 * Tiered on catalog size because that is the only thing about a shop
 * that costs anything real — enrichment is per-product and one-time,
 * queries are effectively free. §79: do not expose token pricing to
 * merchants.
 */
export const PLANS = {
  pilot: {
    key: "pilot",
    name: "Disc Pilot",
    price: 199,
    catalogLimit: 500,
    priceIdEnv: "STRIPE_PRICE_PILOT",
  },
  growth: {
    key: "growth",
    name: "Disc Growth",
    price: 599,
    catalogLimit: 5000,
    priceIdEnv: "STRIPE_PRICE_GROWTH",
  },
  enterprise: {
    key: "enterprise",
    name: "Disc Enterprise",
    price: 1500,
    catalogLimit: null,
    priceIdEnv: "STRIPE_PRICE_ENTERPRISE",
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export const TRIAL_DAYS = 14;

/** Stripe statuses that mean the merchant is entitled to the product. */
export const ACTIVE_STATUSES = new Set(["active", "trialing"]);

/** The cheapest plan whose ceiling covers this catalog. */
export function planForCatalog(productCount: number): PlanKey {
  if (productCount <= PLANS.pilot.catalogLimit) return "pilot";
  if (productCount <= PLANS.growth.catalogLimit) return "growth";
  return "enterprise";
}

export type StripeConfig = {
  secretKey: string;
  priceIds: Partial<Record<PlanKey, string>>;
};

async function stripePost(
  config: StripeConfig,
  path: string,
  form: Array<[string, string]>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${STRIPE_API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secretKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(form).toString(),
  });

  if (!response.ok) {
    const body = await response.text();
    // Truncated: Stripe echoes request context in errors and this string
    // reaches logs.
    throw new Error(`Stripe ${response.status}: ${body.slice(0, 200)}`);
  }
  return await response.json();
}

/**
 * Start a subscription and return the Stripe-hosted page to pay on.
 *
 * The tenant id rides along as `client_reference_id` and in metadata,
 * because the webhook that confirms payment arrives with no other way to
 * know which tenant it belongs to.
 */
export async function createCheckoutSession(
  config: StripeConfig,
  args: {
    tenantId: string;
    shopDomain: string;
    plan: PlanKey;
    successUrl: string;
    cancelUrl: string;
  },
): Promise<string> {
  const priceId = config.priceIds[args.plan];
  if (!priceId) {
    throw new Error(
      `No Stripe price configured for ${args.plan} — set ${PLANS[args.plan].priceIdEnv}`,
    );
  }

  const session = await stripePost(config, "/checkout/sessions", [
    ["mode", "subscription"],
    ["line_items[0][price]", priceId],
    ["line_items[0][quantity]", "1"],
    ["success_url", args.successUrl],
    ["cancel_url", args.cancelUrl],
    ["client_reference_id", args.tenantId],
    ["metadata[tenantId]", args.tenantId],
    ["metadata[plan]", args.plan],
    ["metadata[shopDomain]", args.shopDomain],
    ["subscription_data[metadata][tenantId]", args.tenantId],
    ["subscription_data[metadata][plan]", args.plan],
    ["subscription_data[trial_period_days]", String(TRIAL_DAYS)],
  ]);

  return String(session.url);
}

/**
 * Stripe's own page for changing card, switching plan or cancelling.
 *
 * Worth using rather than building: upgrade, downgrade and cancellation
 * are exactly the flows that are fiddly to get right, and Stripe already
 * handles them along with the resulting webhooks. §133 requires all four
 * to work; this is three of them for free.
 */
export async function createPortalSession(
  config: StripeConfig,
  customerId: string,
  returnUrl: string,
): Promise<string> {
  const session = await stripePost(config, "/billing_portal/sessions", [
    ["customer", customerId],
    ["return_url", returnUrl],
  ]);
  return String(session.url);
}

export type StripeEventOutcome = {
  tenantId: string | null;
  subscriptionStatus: string;
  plan: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  handled: boolean;
};

/**
 * Interpret a verified Stripe event.
 *
 * Pure, so the mapping from Stripe's vocabulary to ours is testable
 * without a Stripe account — which matters because getting it wrong
 * either locks out a paying merchant or serves one who cancelled.
 *
 * Deliberately narrow: events we do not act on return `handled: false`
 * rather than being interpreted speculatively.
 */
export function interpretStripeEvent(event: unknown): StripeEventOutcome {
  const none: StripeEventOutcome = {
    tenantId: null,
    subscriptionStatus: "none",
    plan: null,
    customerId: null,
    subscriptionId: null,
    handled: false,
  };

  if (!event || typeof event !== "object") return none;
  const e = event as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  const object = ((e.data as Record<string, unknown>)?.object ?? {}) as Record<string, unknown>;
  const metadata = (object.metadata ?? {}) as Record<string, unknown>;

  const tenantId =
    (typeof metadata.tenantId === "string" ? metadata.tenantId : null) ??
    (typeof object.client_reference_id === "string" ? object.client_reference_id : null);
  if (!tenantId) return none;

  const plan = typeof metadata.plan === "string" ? metadata.plan : null;
  const customerId = typeof object.customer === "string" ? object.customer : null;

  if (type === "checkout.session.completed") {
    return {
      tenantId,
      // Checkout completing with a trial means trialing, not active —
      // and either way the merchant is entitled to the product.
      subscriptionStatus: "trialing",
      plan,
      customerId,
      subscriptionId: typeof object.subscription === "string" ? object.subscription : null,
      handled: true,
    };
  }

  if (type.startsWith("customer.subscription.")) {
    // `deleted` carries the subscription's last status rather than a
    // cancelled one, so the event type is authoritative here, not the
    // payload's status field.
    const status = type.endsWith("deleted")
      ? "canceled"
      : typeof object.status === "string"
        ? object.status
        : "none";
    return {
      tenantId,
      subscriptionStatus: status,
      plan,
      customerId,
      subscriptionId: typeof object.id === "string" ? object.id : null,
      handled: true,
    };
  }

  return { ...none, tenantId };
}
