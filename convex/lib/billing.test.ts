import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ACTIVE_STATUSES,
  interpretStripeEvent,
  PLANS,
  planForCatalog,
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
