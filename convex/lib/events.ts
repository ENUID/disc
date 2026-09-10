/**
 * Analytics event vocabulary (spec §80).
 *
 * Closed, like the fashion taxonomy and for the same reason: an event
 * name nothing aggregates on is not data, it is a string in a table.
 * `add_to_cart` and `addToCart` and `cart_add` would be three unrelated
 * metrics.
 *
 * This is pulled ahead of its position in the spec's phase list because
 * events and traces **cannot be backfilled**. Every recommendation that
 * ships before this exists is permanently unexplainable, so the spine
 * goes in before the decision engine that will populate it.
 */

export const EVENT_TYPES = [
  "widget_opened",
  "query_submitted",
  "intent_created",
  "catalog_search",
  "outfit_generated",
  "outfit_viewed",
  "product_viewed",
  "product_clicked",
  "product_saved",
  "outfit_saved",
  "slot_swapped",
  "refinement_requested",
  "comparison_started",
  "add_to_cart",
  "checkout_started",
  "purchase",
  "error",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export function isEventType(value: unknown): value is EventType {
  return typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Events a storefront may report about itself.
 *
 * The widget runs on the merchant's page, so anything it sends is
 * attacker-controllable — the endpoint is public by necessity. This
 * limits what a forged request can write: shopper-observable actions
 * only.
 *
 * `purchase` and `checkout_started` are excluded deliberately. They are
 * the events that would appear in "AI-assisted revenue", and accepting
 * them from the browser would let anyone inflate a merchant's numbers by
 * curling an endpoint. They must be attributed server-side from Shopify
 * order data instead.
 */
export const CLIENT_REPORTABLE_EVENTS: ReadonlySet<string> = new Set<EventType>([
  "widget_opened",
  "query_submitted",
  "outfit_viewed",
  "product_viewed",
  "product_clicked",
  "product_saved",
  "outfit_saved",
  "slot_swapped",
  "refinement_requested",
  "comparison_started",
  "add_to_cart",
  "error",
]);

export function isClientReportable(value: unknown): value is EventType {
  return isEventType(value) && CLIENT_REPORTABLE_EVENTS.has(value);
}

/**
 * Bound an event payload before storing it.
 *
 * The payload comes from a public endpoint, so without a cap a single
 * request can write an arbitrarily large document. Convex caps documents
 * at 1 MiB; this keeps them far below that and keeps one shopper from
 * costing a merchant their storage quota.
 */
export function sanitisePayload(raw: unknown, maxKeys = 20, maxLength = 200): unknown {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "number" || typeof raw === "boolean") return raw;
  if (typeof raw === "string") return raw.slice(0, maxLength);

  if (Array.isArray(raw)) {
    return raw.slice(0, maxKeys).map((v) => sanitisePayload(v, maxKeys, maxLength));
  }

  if (typeof raw === "object") {
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (count >= maxKeys) break;
      // One level of nesting only. Deep structures are how a bounded
      // payload becomes unbounded.
      const cleaned =
        typeof value === "object" && value !== null
          ? undefined
          : sanitisePayload(value, maxKeys, maxLength);
      if (cleaned !== undefined) {
        out[key.slice(0, 40)] = cleaned;
        count++;
      }
    }
    return out;
  }
  return undefined;
}

/**
 * Version stamp recorded on every recommendation trace (spec §117).
 *
 * Nine axes the spec asks to track. Without these a quality regression
 * can be observed but not attributed — you know results got worse, not
 * whether the prompt, the model, the ranker or the brand changed.
 */
export type VersionStamp = {
  app: string;
  schema: string;
  brandBrain: number | null;
  embedding: string;
  reasoningModel: string | null;
  promptVersions: Record<string, string>;
  ranker: string;
  judge: string | null;
};

export const RANKER_VERSION = "ranker_v1";
export const APP_VERSION = "disc_v1";

/**
 * Recommendation id.
 *
 * Generated per result set and returned to the widget, so a later
 * `product_clicked` or `add_to_cart` can be attributed back to the
 * recommendation that produced it (spec §131). Attribution is
 * impossible to reconstruct after the fact, which is why the id is
 * minted at generation time rather than derived later.
 */
export function newRecommendationId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `rec_${hex}`;
}

export function isRecommendationId(value: unknown): value is string {
  return typeof value === "string" && /^rec_[0-9a-f]{24}$/.test(value);
}
