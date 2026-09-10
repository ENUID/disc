/**
 * Rate limiting (spec §90, §86).
 *
 * The audit found none anywhere, which matters more here than on a
 * typical API: every `/search` embeds a query and every `/outfit` can
 * reach a model. Without a limit, one scripted client on one storefront
 * can spend a merchant's budget and ours.
 *
 * Fixed-window rather than sliding or token-bucket. A sliding window
 * needs per-request timestamps, which is a write per request — on a path
 * whose whole point is to be cheap, the accounting would cost more than
 * the thing being accounted for. A fixed window admits a burst at a
 * boundary; that is an acceptable trade for one row per tenant per
 * window.
 *
 * Limits are per tenant, not per IP. Shoppers sit behind shared NATs and
 * mobile carriers, so per-IP limits punish real customers; the tenant is
 * also the party whose costs are being protected.
 */

export type RateLimitRule = {
  /** Requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

/**
 * Per-operation limits.
 *
 * Search is generous — it is one embedding call and a shopper refining a
 * query legitimately fires several in a row. Outfit building is tighter
 * because it can reach a model. Merchant resync is tightest of all: a
 * full catalog re-read is minutes of work, and nothing legitimate needs
 * it more than a few times an hour.
 */
export const RULES = {
  search: { limit: 120, windowMs: 60_000 },
  outfit: { limit: 40, windowMs: 60_000 },
  resync: { limit: 4, windowMs: 3_600_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RuleName = keyof typeof RULES;

export type RateLimitState = {
  windowStart: number;
  count: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  remaining: number;
  /** Seconds until the window resets. For the Retry-After header. */
  retryAfterSeconds: number;
  next: RateLimitState;
};

/**
 * Decide whether a request is permitted, and return the state to store.
 *
 * Pure, so the arithmetic is testable without a database — the failure
 * modes here are off-by-one and clock handling, both of which are easy
 * to get wrong and invisible in production until someone is wrongly
 * blocked.
 */
export function checkRateLimit(
  rule: RateLimitRule,
  state: RateLimitState | null,
  now: number,
): RateLimitDecision {
  const expired = !state || now - state.windowStart >= rule.windowMs;
  const windowStart = expired ? now : state!.windowStart;
  const count = expired ? 0 : state!.count;

  const allowed = count < rule.limit;
  const nextCount = allowed ? count + 1 : count;

  return {
    allowed,
    remaining: Math.max(0, rule.limit - nextCount),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + rule.windowMs - now) / 1000)),
    // The rejected request is not counted. Counting it would let a
    // client that keeps hammering hold its own window open forever.
    next: { windowStart, count: nextCount },
  };
}

export function rateLimitKey(rule: RuleName, tenantId: string): string {
  return `${rule}:${tenantId}`;
}
