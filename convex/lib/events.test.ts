import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_REPORTABLE_EVENTS,
  EVENT_TYPES,
  isClientReportable,
  isEventType,
  isRecommendationId,
  newRecommendationId,
  sanitisePayload,
} from "./events";

test("the event vocabulary is closed", () => {
  assert.equal(isEventType("add_to_cart"), true);
  assert.equal(isEventType("purchase"), true);
  // Near-misses must not be admitted, or one metric becomes three.
  assert.equal(isEventType("addToCart"), false);
  assert.equal(isEventType("cart_add"), false);
  assert.equal(isEventType(""), false);
  assert.equal(isEventType(null), false);
});

test("spec §80's 16 event types are all present", () => {
  for (const required of [
    "widget_opened", "query_submitted", "intent_created", "catalog_search",
    "outfit_generated", "outfit_viewed", "product_viewed", "product_clicked",
    "product_saved", "outfit_saved", "slot_swapped", "refinement_requested",
    "comparison_started", "add_to_cart", "checkout_started", "purchase", "error",
  ]) {
    assert.ok(
      (EVENT_TYPES as readonly string[]).includes(required),
      `missing event type: ${required}`,
    );
  }
});

test("a storefront cannot report revenue events", () => {
  // The endpoint is public by necessity — the widget runs on the
  // merchant's page. Accepting these from the browser would let anyone
  // inflate a merchant's revenue metric with a curl.
  assert.equal(isClientReportable("purchase"), false);
  assert.equal(isClientReportable("checkout_started"), false);
  // Internal-only decisions are also not the client's to claim.
  assert.equal(isClientReportable("intent_created"), false);
  assert.equal(isClientReportable("outfit_generated"), false);
  assert.equal(isClientReportable("catalog_search"), false);
});

test("a storefront can report what a shopper actually did", () => {
  for (const allowed of [
    "widget_opened", "query_submitted", "product_viewed", "product_clicked",
    "product_saved", "add_to_cart", "error",
  ]) {
    assert.equal(isClientReportable(allowed), true, allowed);
  }
});

test("every client-reportable event is a real event type", () => {
  for (const type of CLIENT_REPORTABLE_EVENTS) {
    assert.equal(isEventType(type), true, `${type} is not in EVENT_TYPES`);
  }
});

test("sanitisePayload bounds strings, keys and arrays", () => {
  const long = "x".repeat(1000);
  assert.equal((sanitisePayload(long) as string).length, 200);

  const wide: Record<string, string> = {};
  for (let i = 0; i < 100; i++) wide[`k${i}`] = "v";
  assert.equal(Object.keys(sanitisePayload(wide) as object).length, 20);

  const long_array = Array.from({ length: 100 }, (_, i) => i);
  assert.equal((sanitisePayload(long_array) as unknown[]).length, 20);
});

test("sanitisePayload refuses deep nesting", () => {
  // Unbounded depth is how a bounded payload becomes unbounded — and the
  // endpoint that writes it is public.
  const deep = { a: { b: { c: { d: "value" } } } };
  const clean = sanitisePayload(deep) as Record<string, unknown>;
  assert.equal(clean.a, undefined, "nested objects are dropped, not walked");
});

test("sanitisePayload keeps scalars intact", () => {
  assert.equal(sanitisePayload(42), 42);
  assert.equal(sanitisePayload(true), true);
  assert.equal(sanitisePayload("short"), "short");
  assert.equal(sanitisePayload(null), undefined);
  assert.equal(sanitisePayload(undefined), undefined);
});

test("sanitisePayload truncates long keys", () => {
  const payload = { ["k".repeat(200)]: "v" };
  const clean = sanitisePayload(payload) as Record<string, unknown>;
  assert.equal(Object.keys(clean)[0].length, 40);
});

test("recommendation ids are unique and recognisable", () => {
  const a = newRecommendationId();
  const b = newRecommendationId();
  assert.notEqual(a, b);
  assert.match(a, /^rec_[0-9a-f]{24}$/);
  assert.equal(isRecommendationId(a), true);
});

test("recommendation id validation rejects forgeries", () => {
  // Ids arrive back from the storefront on click and add-to-cart events,
  // so the format is checked before it is used for attribution.
  assert.equal(isRecommendationId("rec_short"), false);
  assert.equal(isRecommendationId("nope"), false);
  assert.equal(isRecommendationId(""), false);
  assert.equal(isRecommendationId(null), false);
  assert.equal(isRecommendationId("rec_" + "g".repeat(24)), false, "non-hex");
  assert.equal(isRecommendationId("rec_" + "a".repeat(25)), false, "wrong length");
});

test("recommendation ids do not collide across many draws", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 2000; i++) seen.add(newRecommendationId());
  assert.equal(seen.size, 2000);
});
