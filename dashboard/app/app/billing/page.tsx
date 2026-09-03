import { apiGet } from "@/lib/api";
import type { Billing } from "@/lib/types";
import { Card, Empty, PageHead, SubscriptionPill } from "@/components/ui";
import { ManageBillingButton } from "@/components/actions";
import { PlanPicker } from "./picker";

/**
 * Billing (spec §76, §133).
 *
 * Priced on catalog size, because that is the only thing about a shop
 * that costs anything real: enrichment is per-product and one-time, and
 * queries are effectively free. §79 — token pricing is never shown to a
 * merchant, and nothing on this page mentions a model or a call.
 *
 * Upgrades, downgrades, card changes and cancellation all happen in
 * Stripe's own portal rather than being rebuilt here. Those are exactly
 * the flows that are fiddly to get right, and Stripe already emits the
 * webhooks that make them take effect.
 */

export const dynamic = "force-dynamic";

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const params = await searchParams;
  const billing = await apiGet<Billing>("/merchant/billing");
  const state = billing.state;

  if (!billing.enabled) {
    return (
      <>
        <PageHead title="Billing" />
        <Empty>
          Billing is not switched on for this deployment. Disc is running with
          no subscription required.
        </Empty>
      </>
    );
  }

  if (!state) {
    return (
      <>
        <PageHead title="Billing" />
        <Empty>This store is no longer connected.</Empty>
      </>
    );
  }

  const entitled =
    state.subscriptionStatus === "active" || state.subscriptionStatus === "trialing";
  const current = billing.plans.find((plan) => plan.key === state.plan);

  /**
   * Whether a subscription exists to be *changed* rather than started.
   *
   * Not the same as being entitled: a merchant whose card just failed is
   * `past_due` — not entitled, but they very much have a subscription,
   * and sending them through checkout again would open a second one
   * alongside the one they need to fix. `canceled` and `none` are the
   * cases where checkout is genuinely the right door.
   */
  const hasLiveSubscription =
    state.hasCustomer &&
    ["active", "trialing", "past_due", "unpaid", "pending"].includes(
      state.subscriptionStatus,
    );

  return (
    <>
      <PageHead title="Billing">
        Priced on how big your catalog is — the only part of running Disc that
        costs anything real.
      </PageHead>

      {params.checkout === "success" && (
        <div className="note ok">
          Checkout complete. Your subscription activates as soon as Stripe
          confirms it, usually within a few seconds.
        </div>
      )}
      {params.checkout === "cancelled" && (
        <div className="note">
          Checkout cancelled. Nothing was charged.
        </div>
      )}

      {!entitled && (
        <div className="note warn">
          <strong>Disc is not serving shoppers.</strong> Your storefront keeps
          its own search box while a subscription is inactive — Disc steps aside
          rather than leaving your store with no way to search.
        </div>
      )}

      {state.subscriptionStatus === "past_due" && (
        <div className="note bad">
          <strong>Your last payment failed.</strong> Update your card below
          before access lapses.
        </div>
      )}

      <Card
        title="Current plan"
        hint={
          current
            ? `${current.name} · $${current.price}/month`
            : "No plan selected yet"
        }
        aside={
          <SubscriptionPill status={state.subscriptionStatus} enabled={state.enabled} />
        }
      >
        <dl className="kv">
          <dt>Products in catalog</dt>
          <dd>{state.productCount.toLocaleString()}</dd>
          <dt>Plan for your size</dt>
          <dd>
            {billing.plans.find((p) => p.key === state.suggestedPlan)?.name ??
              state.suggestedPlan}
          </dd>
        </dl>

        {state.overCatalogLimit && (
          <div className="note warn" style={{ marginTop: 14, marginBottom: 0 }}>
            <strong>Your catalog outgrew your plan.</strong> Disc keeps working —
            nobody gets cut off mid-month — but the next tier is the honest one
            for a catalog this size.
          </div>
        )}

        {state.hasCustomer && (
          <div className="actions" style={{ marginTop: 14 }}>
            <ManageBillingButton />
            <span style={{ fontSize: 12.5, color: "var(--ink-faint)" }}>
              Change plan, update your card, or cancel — all in Stripe.
            </span>
          </div>
        )}
      </Card>

      <h2 className="section">Plans</h2>
      <PlanPicker
        plans={billing.plans}
        currentPlan={state.plan}
        suggested={state.suggestedPlan}
        trialDays={billing.trialDays}
        hasSubscription={hasLiveSubscription}
      />

      <p style={{ fontSize: 12.5, color: "var(--ink-faint)", marginTop: 16 }}>
        Every plan includes the whole product — search, styling, outfit building
        and the merchant dashboard. Tiers differ only by catalog size.
      </p>
    </>
  );
}
