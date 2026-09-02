import { test } from "node:test";
import assert from "node:assert/strict";
import {
  eventTime,
  isStale,
  NOT_APPLIED,
  parseDeliveryHeaders,
  parseTimestamp,
} from "./webhooks";

/**
 * Shopify delivery semantics, without a database.
 *
 * The whole risk in this phase is conflating four signals that look
 * interchangeable and are not. These tests pin each one's meaning.
 */

test("timestamps are parsed, not compared as strings", () => {
  // THE TRAP. Shopify emits offsets rather than always-UTC, so these two
  // sort one way lexicographically and the opposite way in real time.
  const earlier = "2026-08-26T09:00:00-04:00"; // 13:00 UTC
  const later = "2026-08-26T12:00:00+00:00"; // 12:00 UTC — actually EARLIER

  assert.ok(earlier < later, "lexicographically the first looks earlier");
  assert.ok(
    parseTimestamp(earlier)! > parseTimestamp(later)!,
    "in real time it is later — a string comparison would invert this",
  );
});

test("parseTimestamp refuses anything it cannot read", () => {
  assert.equal(parseTimestamp(undefined), undefined);
  assert.equal(parseTimestamp(null), undefined);
  assert.equal(parseTimestamp(""), undefined);
  assert.equal(parseTimestamp("not a date"), undefined);
  assert.equal(parseTimestamp(12345), undefined, "a number is not an ISO string");
  assert.equal(parseTimestamp("2026-08-26T09:00:00Z"), Date.parse("2026-08-26T09:00:00Z"));
});

test("the four delivery signals are read from their own headers", () => {
  const headers = new Headers({
    "X-Shopify-Webhook-Id": "delivery-1",
    "X-Shopify-Event-Id": "event-1",
    "X-Shopify-Topic": "products/update",
    "X-Shopify-API-Version": "2026-01",
    "X-Shopify-Triggered-At": "2026-08-26T09:00:00Z",
  });

  const parsed = parseDeliveryHeaders(headers);
  assert.equal(parsed.webhookId, "delivery-1");
  assert.equal(parsed.eventId, "event-1");
  assert.equal(parsed.topic, "products/update");
  assert.equal(parsed.apiVersion, "2026-01");
  assert.equal(parsed.triggeredAt, Date.parse("2026-08-26T09:00:00Z"));

  // The webhook id and the event id are different things and must never
  // be read from each other's header.
  assert.notEqual(parsed.webhookId, parsed.eventId);
});

test("missing headers are absent rather than invented", () => {
  const parsed = parseDeliveryHeaders(new Headers({}));
  assert.equal(parsed.webhookId, null);
  assert.equal(parsed.eventId, null);
  assert.equal(parsed.triggeredAt, undefined);
});

// -------------------------------------------------------------- eventTime

test("the resource version wins over the trigger time", () => {
  // `updated_at` is a resource VERSION and `triggeredAt` is a wall clock.
  // Freshness compares against `products.sourceUpdatedAt`, which is also
  // an `updated_at` — so using the version keeps the comparison
  // like-for-like instead of comparing a version to a clock.
  const at = eventTime({
    resourceUpdatedAt: "2026-08-26T09:00:00Z",
    triggeredAt: Date.parse("2026-08-26T11:00:00Z"),
    receivedAt: Date.parse("2026-08-26T12:00:00Z"),
  });
  assert.equal(at, Date.parse("2026-08-26T09:00:00Z"));
});

test("the trigger time carries events with no version of their own", () => {
  // In practice: deletes. The payload has no `updated_at`.
  const at = eventTime({
    triggeredAt: Date.parse("2026-08-26T11:00:00Z"),
    receivedAt: Date.parse("2026-08-26T12:00:00Z"),
  });
  assert.equal(at, Date.parse("2026-08-26T11:00:00Z"));
});

test("an event with neither is treated as happening now", () => {
  // It cannot be ordered against anything. Treating it as current means
  // it is applied rather than discarded: losing an ordering guarantee is
  // recoverable, discarding a real update is not.
  const now = Date.parse("2026-08-26T12:00:00Z");
  assert.equal(eventTime({ receivedAt: now }), now);
});

test("an unparseable version falls through rather than poisoning the order", () => {
  const at = eventTime({
    resourceUpdatedAt: "garbage",
    triggeredAt: Date.parse("2026-08-26T11:00:00Z"),
    receivedAt: 0,
  });
  assert.equal(at, Date.parse("2026-08-26T11:00:00Z"));
});

// ---------------------------------------------------------------- isStale

test("an older event is stale", () => {
  const applied = Date.parse("2026-08-26T12:00:00Z");
  assert.equal(isStale(Date.parse("2026-08-26T09:00:00Z"), applied), true);
  assert.equal(isStale(Date.parse("2026-08-26T15:00:00Z"), applied), false);
});

test("an equal timestamp is NOT stale", () => {
  // Strictly older, not older-or-equal, and the difference is load
  // bearing. An equal timestamp with a different delivery id is a second
  // delivery of the same resource version — which one merchant action
  // genuinely produces across subscriptions — not a duplicate delivery.
  // Discarding it would drop work on the strength of a timestamp that
  // only says "same version". Letting it through costs nothing: the
  // job's idempotency key is derived from that version and collapses it.
  const at = Date.parse("2026-08-26T12:00:00Z");
  assert.equal(isStale(at, at), false);
});

test("nothing is stale when nothing has been applied", () => {
  assert.equal(isStale(Date.parse("2026-08-26T09:00:00Z"), NOT_APPLIED), false);
  assert.equal(isStale(0, NOT_APPLIED), false);
});

test("the not-applied sentinel sorts below every real event time", () => {
  // The freshness lookup walks the resource index descending and takes
  // the first row. That is only O(1)-correct if an unapplied row can
  // never outrank an applied one.
  assert.equal(NOT_APPLIED, 0);
  assert.ok(NOT_APPLIED < Date.parse("1970-01-02T00:00:00Z"));
});
