import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRateLimit, rateLimitKey, RULES } from "./rate-limit";

/**
 * The failure modes here are off-by-one and clock handling. Both are
 * invisible in production until a real shopper is wrongly blocked, or
 * until nobody is blocked at all — which is why the arithmetic is pure
 * and tested rather than only exercised through the database.
 */

const rule = { limit: 3, windowMs: 1000 };

test("a first request opens a window and is allowed", () => {
  const decision = checkRateLimit(rule, null, 5000);
  assert.equal(decision.allowed, true);
  assert.equal(decision.remaining, 2);
  assert.deepEqual(decision.next, { windowStart: 5000, count: 1 });
});

test("the limit is a ceiling, not a fencepost", () => {
  // Exactly `limit` requests get through, the next one does not.
  let state = { windowStart: 5000, count: 0 };
  for (let i = 0; i < rule.limit; i++) {
    const decision = checkRateLimit(rule, state, 5000);
    assert.equal(decision.allowed, true, `request ${i + 1} should be allowed`);
    state = decision.next;
  }
  assert.equal(state.count, 3);

  const rejected = checkRateLimit(rule, state, 5000);
  assert.equal(rejected.allowed, false);
  assert.equal(rejected.remaining, 0);
});

test("a rejected request does not extend its own window", () => {
  // Counting rejections would let a client that keeps hammering hold its
  // window open forever, so a blocked caller could never recover.
  const blocked = { windowStart: 5000, count: 99 };
  const first = checkRateLimit(rule, blocked, 5500);
  assert.equal(first.allowed, false);
  assert.equal(first.next.count, 99, "count must not grow while blocked");
  assert.equal(first.next.windowStart, 5000, "window must not slide forward");

  // ...and the window still expires on schedule.
  const later = checkRateLimit(rule, first.next, 6000);
  assert.equal(later.allowed, true);
});

test("the window expires exactly at windowMs, not after", () => {
  const full = { windowStart: 5000, count: rule.limit };

  // One millisecond short: still inside the window.
  assert.equal(checkRateLimit(rule, full, 5999).allowed, false);
  // Exactly at the boundary: a new window.
  const reset = checkRateLimit(rule, full, 6000);
  assert.equal(reset.allowed, true);
  assert.deepEqual(reset.next, { windowStart: 6000, count: 1 });
});

test("retryAfter counts down within the window and is never zero", () => {
  const state = { windowStart: 5000, count: rule.limit };
  assert.equal(checkRateLimit(rule, state, 5000).retryAfterSeconds, 1);
  assert.equal(checkRateLimit(rule, state, 5500).retryAfterSeconds, 1);
  // A Retry-After of 0 tells a client to retry immediately, which is the
  // one thing a rate limiter must never say.
  assert.ok(checkRateLimit(rule, state, 5999).retryAfterSeconds >= 1);
});

test("a long window reports a proportionate retry delay", () => {
  const hourly = RULES.resync;
  const state = { windowStart: 0, count: hourly.limit };
  const decision = checkRateLimit(hourly, state, 600_000); // 10 min in
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryAfterSeconds, 3000); // 50 minutes left
});

test("clock skew backwards does not unlock the window", () => {
  // Convex clocks are server-side, but `now - windowStart` going negative
  // must still read as "inside the window" rather than "expired".
  const state = { windowStart: 5000, count: rule.limit };
  const decision = checkRateLimit(rule, state, 4000);
  assert.equal(decision.allowed, false);
});

test("configured limits are ordered by what each call actually costs", () => {
  // Search is one embedding; outfit can reach a model; resync re-reads a
  // whole catalog. If this ordering ever inverts, the cheapest path is
  // the most restricted one.
  assert.ok(RULES.search.limit > RULES.outfit.limit);
  assert.ok(RULES.outfit.limit > RULES.resync.limit);
  assert.ok(RULES.resync.windowMs > RULES.search.windowMs);
});

test("keys are namespaced per rule so limits cannot collide", () => {
  assert.notEqual(rateLimitKey("search", "t1"), rateLimitKey("outfit", "t1"));
  assert.notEqual(rateLimitKey("search", "t1"), rateLimitKey("search", "t2"));
  assert.equal(rateLimitKey("search", "t1"), "search:t1");
});
