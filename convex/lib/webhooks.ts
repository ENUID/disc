/**
 * Shopify webhook delivery semantics (P1.4) — the pure half.
 *
 * Shopify's delivery contract has four distinct signals, and the entire
 * point of this module is that they are NOT interchangeable:
 *
 *   X-Shopify-Webhook-Id    unique per DELIVERY
 *                           -> delivery deduplication
 *
 *   X-Shopify-Event-Id      shared across deliveries caused by the same
 *                           merchant action, including across different
 *                           subscriptions
 *                           -> correlation ONLY, never deduplication
 *
 *   X-Shopify-Triggered-At  when the event was triggered
 *                           -> ordering signal where the resource has no
 *                              version of its own (a delete)
 *
 *   payload.updated_at      the resource's own version
 *                           -> resource freshness
 *
 * Deduplicating on the EVENT id would be wrong: one merchant action can
 * legitimately produce deliveries to several subscriptions, and treating
 * the second as a duplicate would silently drop a topic. Ordering by it
 * would also be wrong — it is an identity, not a clock.
 *
 * Shopify states plainly that ordering is not guaranteed, within a topic
 * or across topics for the same resource: a `products/update` can arrive
 * before the `products/create` it followed. So "have we seen this
 * delivery" and "is this event newer than the state we already applied"
 * are two questions with two different answers, and this phase keeps them
 * apart.
 *
 * Shopify also states delivery itself is not guaranteed. Nothing here
 * replaces the periodic catalog reconciliation — that remains the
 * backstop for events that never arrive at all, which is exactly what
 * Shopify recommends.
 */

export type DeliveryHeaders = {
  /** Unique per delivery. The deduplication key. */
  webhookId: string | null;
  /** Shared across one merchant action. Correlation only. */
  eventId: string | null;
  topic: string | null;
  apiVersion: string | null;
  /** Epoch ms, when parseable. */
  triggeredAt: number | undefined;
};

/**
 * Parse an ISO 8601 timestamp to epoch milliseconds.
 *
 * `Date.parse` rather than a string comparison, and this is not a
 * stylistic choice: Shopify emits offsets rather than always-UTC
 * (`2026-08-26T09:00:00-04:00`), so two timestamps for the same resource
 * can compare in the wrong order lexicographically while being minutes
 * apart in reality. A string comparison here would present as "a real
 * update was discarded as stale", which is the worst outcome this phase
 * can produce.
 */
export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function parseDeliveryHeaders(headers: Headers): DeliveryHeaders {
  return {
    webhookId: headers.get("X-Shopify-Webhook-Id"),
    eventId: headers.get("X-Shopify-Event-Id"),
    topic: headers.get("X-Shopify-Topic"),
    apiVersion: headers.get("X-Shopify-API-Version"),
    triggeredAt: parseTimestamp(headers.get("X-Shopify-Triggered-At")),
  };
}

/**
 * The one comparable quantity per event.
 *
 * Freshness needs a single scale, and the two available timestamps are
 * not the same quantity: `updated_at` is a resource VERSION, while
 * `triggeredAt` is a wall clock. Mixing them per-comparison would mean
 * comparing a version against a clock and calling the result an order.
 *
 * So the resource version wins wherever it exists — it is what
 * `products.sourceUpdatedAt` also holds, making the comparison
 * like-for-like — and `triggeredAt` is the fallback for events that carry
 * no version, which in practice means deletes.
 *
 * `receivedAt` is the last resort. An event with neither a version nor a
 * trigger time cannot be ordered against anything, and treating it as
 * happening now means it is applied rather than discarded. Losing an
 * ordering guarantee is recoverable; discarding a real update is not.
 */
export function eventTime(input: {
  resourceUpdatedAt?: string;
  triggeredAt?: number;
  receivedAt: number;
}): number {
  return (
    parseTimestamp(input.resourceUpdatedAt) ?? input.triggeredAt ?? input.receivedAt
  );
}

/**
 * Is this event older than the state already applied for its resource?
 *
 * Strictly older, not older-or-equal, and the difference matters.
 *
 * An equal timestamp with a DIFFERENT delivery id is not a duplicate
 * delivery — it is a second delivery of the same resource version, which
 * one merchant action can genuinely produce across subscriptions.
 * Discarding it here would be discarding work on the strength of a
 * timestamp that only says "same version". Letting it through costs
 * nothing, because the job's idempotency key is derived from that same
 * version and collapses the two into one job.
 *
 * Each layer therefore catches exactly what it should:
 *
 *   webhook id  ->  the same delivery, twice
 *   timestamp   ->  an older version, arriving late
 *   job key     ->  the same version, by a different route
 */
export function isStale(eventAt: number, lastAppliedAt: number): boolean {
  if (lastAppliedAt <= 0) return false; // nothing applied yet
  return eventAt < lastAppliedAt;
}

/** Outcomes recorded on the ledger. `duplicate` is never stored — see below. */
export const DELIVERY_OUTCOMES = ["applied", "stale", "acknowledged"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/**
 * Sentinel for "this delivery changed nothing".
 *
 * The freshness lookup reads the highest `appliedEventAt` for a resource
 * by walking its index descending and taking the first row. Rows that
 * were not applied carry 0, which sorts below every real event time, so
 * they can never be mistaken for the last applied state. That is what
 * keeps the lookup O(1) — no scan, no filter, no "take the last N and
 * hope" constant.
 */
export const NOT_APPLIED = 0;
