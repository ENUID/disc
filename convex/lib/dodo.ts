/**
 * Dodo Payments — the $400 Disc Initial Setup fee.
 *
 * A second, independent payment provider alongside Stripe, by design:
 * the setup fee is one-time and not a subscription, and the spec is
 * explicit that it must never be collapsed into `subscriptionStatus` or
 * charged at the same moment as the recurring plan. This file is the
 * Dodo equivalent of lib/billing.ts, one concern narrower — there is no
 * portal, no upgrade/downgrade, and (see the ledger in setupFee.ts) no
 * ordering guard to speak of, because "unpaid -> paid" is the only
 * transition a one-time fee ever makes.
 *
 * Called over `fetch` rather than the `dodopayments` SDK, matching
 * lib/billing.ts's own reasoning: the integration surface here is one
 * endpoint, and pulling in a whole SDK for it would be a much larger
 * change than the feature needs. Signature verification is the one
 * genuinely non-obvious part, and it lives in lib/crypto.ts instead of
 * being trusted blindly — see `verifyDodoWebhookHmac`.
 *
 * Every fact below (base URLs, path, request/response shape, event
 * envelope) is sourced from Dodo's own published API reference rather
 * than guessed; see the implementation plan for citations. The one
 * inferred (not directly quoted) detail is where checkout metadata lands
 * in the webhook body — `data.metadata`, by structural analogy with the
 * confirmed flat `data.<field>` envelope Dodo's docs show for
 * `payment.failed`. Worth confirming against one real test-mode delivery
 * before this goes anywhere near production.
 */

/** Test mode only this phase — deliberately not env-switchable to live. */
export const DODO_API_BASE = "https://test.dodopayments.com";

export const SETUP_FEE_PRODUCT_NAME = "Disc Initial Setup";
export const SETUP_FEE_USD = 400;

export type DodoConfig = {
  apiKey: string;
  /** The pre-created Dodo product id for the $400 one-time fee. */
  productId: string;
};

/**
 * Start a one-time checkout for the setup fee.
 *
 * `tenantId` rides in metadata, the same mechanism Stripe checkout uses
 * via `metadata[tenantId]` — Dodo confirms metadata set here flows
 * through verbatim to the webhook payload. This is what lets the webhook
 * attach a payment to the right tenant without trusting anything the
 * browser says on return.
 */
export async function createSetupFeeCheckoutSession(
  config: DodoConfig,
  args: { tenantId: string; shopDomain: string; returnUrl: string },
): Promise<string> {
  const response = await fetch(`${DODO_API_BASE}/checkouts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      product_cart: [{ product_id: config.productId, quantity: 1 }],
      return_url: args.returnUrl,
      metadata: {
        tenantId: args.tenantId,
        shopDomain: args.shopDomain,
        kind: "disc_setup_fee",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    // Truncated: avoid an oversized or sensitive body reaching logs.
    throw new Error(`Dodo ${response.status}: ${body.slice(0, 200)}`);
  }

  const session = (await response.json()) as { checkout_url?: string };
  if (!session.checkout_url) throw new Error("Dodo did not return a checkout_url");
  return session.checkout_url;
}

export type DodoEventOutcome = {
  tenantId: string | null;
  paymentId: string | null;
  /** succeeded | failed | unhandled */
  kind: "succeeded" | "failed" | "unhandled";
  handled: boolean;
};

/**
 * Interpret a verified Dodo event. Pure, like `interpretStripeEvent` —
 * testable without a Dodo account, which matters because getting this
 * wrong either strands a merchant who paid or marks one paid who did
 * not.
 *
 * Deliberately narrow: only `payment.succeeded` and `payment.failed` are
 * confirmed, corroborated event names. Anything else, including a
 * plausible-looking one this code was not told about, returns
 * `handled: false` rather than being interpreted speculatively.
 */
export function interpretDodoEvent(event: unknown): DodoEventOutcome {
  const none: DodoEventOutcome = {
    tenantId: null,
    paymentId: null,
    kind: "unhandled",
    handled: false,
  };

  if (!event || typeof event !== "object") return none;
  const e = event as Record<string, unknown>;
  const type = typeof e.type === "string" ? e.type : "";
  const data = (e.data ?? {}) as Record<string, unknown>;
  const metadata = (data.metadata ?? {}) as Record<string, unknown>;

  const tenantId = typeof metadata.tenantId === "string" ? metadata.tenantId : null;
  const paymentId = typeof data.payment_id === "string" ? data.payment_id : null;

  if (type === "payment.succeeded") {
    return { tenantId, paymentId, kind: "succeeded", handled: true };
  }
  if (type === "payment.failed") {
    return { tenantId, paymentId, kind: "failed", handled: true };
  }
  return none;
}
