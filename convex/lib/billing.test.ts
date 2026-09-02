import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_STATUSES,
  guardStripeTransition,
  interpretStripeEvent,
  isTerminalSubscriptionStatus,
  PLANS,
  planForCatalog,
  SUBSCRIPTION_STATUSES,
  TERMINAL_SUBSCRIPTION_STATUSES,
  TRIAL_DAYS,
} from "./billing";

/**
 * §133 requires four things to work end to end: start a trial,
 * subscribe, upgrade, cancel — and Disc must change access state
 * correctly for each. Three of those happen inside Stripe's own portal
 * and reach us only as webhooks, so this mapping is where they either
 * work or silently do not.
 *
 * Getting it wrong has two failure directions and both are expensive:
 * lock out a merchant who is paying, or keep serving one who cancelled.
 */

function event(type: string, object: Record<string, unknown>) {
  return { type, data: { object } };
}

test("checkout completing starts a trial, not a paid subscription", () => {
  const outcome = interpretStripeEvent(
    event("checkout.session.completed", {
      metadata: { tenantId: "tenant_1", plan: "growth" },
      customer: "cus_123",
      subscription: "sub_456",
    }),
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.tenantId, "tenant_1");
  // Checkout with trial_period_days means Stripe has charged nothing
  // yet. Recording "active" here would be a lie the merchant's invoice
  // eventually contradicts.
  assert.equal(outcome.subscriptionStatus, "trialing");
  assert.ok(ACTIVE_STATUSES.has(outcome.subscriptionStatus), "a trial is entitled");
  assert.equal(outcome.plan, "growth");
  assert.equal(outcome.customerId, "cus_123");
  assert.equal(outcome.subscriptionId, "sub_456");
});

test("a deleted subscription is cancelled regardless of its payload status", () => {
  // Stripe sends the subscription's *last* status on the deleted event,
  // which is usually "active". Trusting the payload here is exactly how
  // a cancelled merchant keeps the product forever.
  const outcome = interpretStripeEvent(
    event("customer.subscription.deleted", {
      id: "sub_456",
      status: "active",
      metadata: { tenantId: "tenant_1", plan: "pilot" },
      customer: "cus_123",
    }),
  );

  assert.equal(outcome.handled, true);
  assert.equal(outcome.subscriptionStatus, "canceled");
  assert.equal(ACTIVE_STATUSES.has(outcome.subscriptionStatus), false);
});

test("subscription updates carry their status through verbatim", () => {
  for (const status of ["active", "past_due", "unpaid", "incomplete_expired"]) {
    const outcome = interpretStripeEvent(
      event("customer.subscription.updated", {
        id: "sub_456",
        status,
        metadata: { tenantId: "tenant_1" },
      }),
    );
    assert.equal(outcome.subscriptionStatus, status, `status ${status}`);
    assert.equal(outcome.handled, true);
  }
});

test("an upgrade is an update carrying the new plan", () => {
  const outcome = interpretStripeEvent(
    event("customer.subscription.updated", {
      id: "sub_456",
      status: "active",
      metadata: { tenantId: "tenant_1", plan: "enterprise" },
    }),
  );
  assert.equal(outcome.plan, "enterprise");
  assert.equal(outcome.subscriptionStatus, "active");
});

test("client_reference_id is accepted when metadata is absent", () => {
  const outcome = interpretStripeEvent(
    event("checkout.session.completed", { client_reference_id: "tenant_9" }),
  );
  assert.equal(outcome.tenantId, "tenant_9");
  assert.equal(outcome.handled, true);
});

test("an event without a tenant is never acted on", () => {
  // Stripe sends plenty of account-level events that belong to no
  // tenant. Guessing one would apply a subscription change to whichever
  // merchant happened to be nearby.
  for (const bad of [
    event("checkout.session.completed", {}),
    event("customer.subscription.updated", { status: "active" }),
    null,
    "not an object",
    {},
  ]) {
    const outcome = interpretStripeEvent(bad);
    assert.equal(outcome.handled, false);
    assert.equal(outcome.tenantId, null);
  }
});

test("unrecognised event types are not interpreted speculatively", () => {
  const outcome = interpretStripeEvent(
    event("invoice.payment_succeeded", {
      metadata: { tenantId: "tenant_1" },
      status: "paid",
    }),
  );
  // The tenant resolves, but nothing is applied — "paid" is not a
  // subscription status and mapping it to one would be invention.
  assert.equal(outcome.tenantId, "tenant_1");
  assert.equal(outcome.handled, false);
});

test("plans tier on catalog size and the top tier has no ceiling", () => {
  assert.equal(planForCatalog(0), "pilot");
  assert.equal(planForCatalog(PLANS.pilot.catalogLimit), "pilot");
  assert.equal(planForCatalog(PLANS.pilot.catalogLimit + 1), "growth");
  assert.equal(planForCatalog(PLANS.growth.catalogLimit), "growth");
  assert.equal(planForCatalog(PLANS.growth.catalogLimit + 1), "enterprise");
  assert.equal(planForCatalog(1_000_000), "enterprise");
  assert.equal(PLANS.enterprise.catalogLimit, null);
});

test("plan prices and limits ascend together", () => {
  assert.ok(PLANS.pilot.price < PLANS.growth.price);
  assert.ok(PLANS.growth.price < PLANS.enterprise.price);
  assert.ok(PLANS.pilot.catalogLimit < PLANS.growth.catalogLimit);
  assert.ok(TRIAL_DAYS > 0);
});

// ==================================================== the transition guard
//
// Stripe does not deliver events in order, provides no version field on a
// Subscription, and states plainly that `created` must not be used to
// determine order. So this guard is NOT a timestamp comparison — it is a
// state-machine rule derived from what Stripe's semantics make
// impossible, and these tests pin exactly which changes it refuses.

const SUB = "sub_live";

test("a cancelled subscription cannot be revived by a later event", () => {
  // THE CENTREPIECE. Delivered in reverse, this is how a merchant who
  // cancelled gets their access handed back:
  //
  //   customer.subscription.deleted  -> canceled
  //   checkout.session.completed     -> trialing   <- must NOT happen
  //
  // It cannot be true at any point after the cancellation, so the event
  // is stale by construction rather than by timestamp.
  const verdict = guardStripeTransition(
    { subscriptionStatus: "canceled", subscriptionId: SUB },
    { subscriptionStatus: "trialing", subscriptionId: SUB },
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.allow === false && verdict.reason, "revives_terminal");
});

test("every non-terminal status is refused for a cancelled subscription", () => {
  for (const status of SUBSCRIPTION_STATUSES) {
    const verdict = guardStripeTransition(
      { subscriptionStatus: "canceled", subscriptionId: SUB },
      { subscriptionStatus: status, subscriptionId: SUB },
    );
    assert.equal(
      verdict.allow,
      isTerminalSubscriptionStatus(status),
      `canceled -> ${status}`,
    );
  }
});

test("a cancellation still lands on a live subscription", () => {
  // The guard must not become a reason that real cancellations are lost.
  for (const from of ["trialing", "active", "past_due", "unpaid"]) {
    const verdict = guardStripeTransition(
      { subscriptionStatus: from, subscriptionId: SUB },
      { subscriptionStatus: "canceled", subscriptionId: SUB },
    );
    assert.equal(verdict.allow, true, `${from} -> canceled`);
  }
});

test("an old cancellation cannot end a subscription the tenant now holds", () => {
  // Subscription A was cancelled and B took over. A's `deleted` event
  // arrives late. Acting on it would remove access from a merchant who
  // is paying — and whatever the delivery order, cancelling A says
  // nothing about B.
  const verdict = guardStripeTransition(
    { subscriptionStatus: "active", subscriptionId: "sub_B" },
    { subscriptionStatus: "canceled", subscriptionId: "sub_A" },
  );
  assert.equal(verdict.allow, false);
  assert.equal(verdict.allow === false && verdict.reason, "cancels_superseded");
});

test("resubscribing after a cancellation is allowed", () => {
  // The deliberate asymmetry. A non-terminal event for a DIFFERENT
  // subscription is allowed, because a merchant genuinely resubscribing
  // must not be locked out by a rule written to protect them.
  const verdict = guardStripeTransition(
    { subscriptionStatus: "canceled", subscriptionId: "sub_A" },
    { subscriptionStatus: "trialing", subscriptionId: "sub_B" },
  );
  assert.equal(verdict.allow, true);
});

test("a new subscription may take over from a live one", () => {
  // An upgrade that creates a new subscription rather than editing the
  // old one must not be refused: the failure would be a paying merchant
  // with no access, which is worse than the ambiguity it resolves.
  const verdict = guardStripeTransition(
    { subscriptionStatus: "active", subscriptionId: "sub_A" },
    { subscriptionStatus: "active", subscriptionId: "sub_B" },
  );
  assert.equal(verdict.allow, true);
});

test("a first subscription is never blocked", () => {
  // Nothing recorded yet means no entitlement to protect.
  assert.equal(
    guardStripeTransition(
      { subscriptionStatus: "none", subscriptionId: null },
      { subscriptionStatus: "trialing", subscriptionId: SUB },
    ).allow,
    true,
  );
  // And an event naming no subscription has no identity to compare.
  assert.equal(
    guardStripeTransition(
      { subscriptionStatus: "canceled", subscriptionId: SUB },
      { subscriptionStatus: "active", subscriptionId: null },
    ).allow,
    true,
  );
});

test("ordinary lifecycle movement is untouched", () => {
  // The guard exists to refuse changes no ordering could justify, not to
  // police the lifecycle. Payment failing and recovering is legitimate.
  for (const [from, to] of [
    ["trialing", "active"],
    ["active", "past_due"],
    ["past_due", "active"],
    ["active", "unpaid"],
    ["incomplete", "active"],
  ]) {
    assert.equal(
      guardStripeTransition(
        { subscriptionStatus: from, subscriptionId: SUB },
        { subscriptionStatus: to, subscriptionId: SUB },
      ).allow,
      true,
      `${from} -> ${to}`,
    );
  }
});

test("the terminal set is exactly what Stripe cannot walk back", () => {
  assert.equal(isTerminalSubscriptionStatus("canceled"), true);
  assert.equal(isTerminalSubscriptionStatus("incomplete_expired"), true);
  // `past_due` and `unpaid` are recoverable — a merchant can fix a card.
  // Treating them as terminal would permanently lock out a paying
  // customer whose payment briefly failed.
  assert.equal(isTerminalSubscriptionStatus("past_due"), false);
  assert.equal(isTerminalSubscriptionStatus("unpaid"), false);
  assert.equal(isTerminalSubscriptionStatus("paused"), false);

  for (const status of TERMINAL_SUBSCRIPTION_STATUSES) {
    assert.ok(
      (SUBSCRIPTION_STATUSES as readonly string[]).includes(status),
      `${status} must be a declared status`,
    );
    // A terminal status must never grant access.
    assert.equal(ACTIVE_STATUSES.has(status), false, `${status} must not entitle`);
  }
});
