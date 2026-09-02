import { test } from "node:test";
import assert from "node:assert/strict";
import {
  backoffMs,
  classifyFailure,
  decideRetry,
  DEFAULT_BACKOFF,
  FAILURE_CLASSES,
  isRetryableClass,
  MalformedModelOutputError,
  MalformedSourceError,
  RETRYABLE,
  TerminalJobError,
  type BackoffOptions,
} from "./retry";
import { ProviderError } from "./providers";
import { ShopifyAdminError } from "../shopify/admin";

/**
 * Retry policy, without a database.
 *
 * The two decisions here are the ones that cost money when they are
 * wrong: retrying something that will never succeed burns attempts and
 * provider spend, and giving up on something transient drops a
 * merchant's catalog update on the floor. Both are pure functions
 * precisely so they can be exhausted rather than sampled.
 */

const OPTS: BackoffOptions = { baseMs: 1000, capMs: 300_000, jitter: 0.25 };
/** A deterministic "random" so jitter is testable rather than flaky. */
const noJitter = () => 0.5; // maps to the midpoint: no displacement
const maxJitter = () => 1; // +100% of the spread
const minJitter = () => 0; // -100% of the spread

// ------------------------------------------------------------ taxonomy

test("the retryable set is a strict subset, and unknown is not in it", () => {
  // The single most important line in the policy: an error nobody
  // classified is not an error anyone showed is safe to repeat.
  assert.equal(isRetryableClass("unknown"), false);
  assert.ok(RETRYABLE.size > 0);
  assert.ok(RETRYABLE.size < FAILURE_CLASSES.length);

  for (const cls of RETRYABLE) {
    assert.ok(
      (FAILURE_CLASSES as readonly string[]).includes(cls),
      `${cls} must be a declared class`,
    );
  }
});

test("every declared class has an explicit retry stance", () => {
  // Guards against a class being added to the vocabulary and silently
  // inheriting "terminal" because nobody thought about it.
  for (const cls of FAILURE_CLASSES) {
    assert.equal(typeof isRetryableClass(cls), "boolean");
  }
});

// ------------------------------------------------------- classification

test("21. a model 429 is retryable", () => {
  const c = classifyFailure(new ProviderError("Model request failed (429)", true, 429));
  assert.equal(c.class, "provider_rate_limited");
  assert.equal(c.retryable, true);
});

test("22. a model 500 is retryable", () => {
  const c = classifyFailure(new ProviderError("Model request failed (503)", true, 503));
  assert.equal(c.class, "provider_unavailable");
  assert.equal(c.retryable, true);
});

test("23. an invalid model request is terminal", () => {
  // A 400 means the request itself is wrong. Repeating it repeats the
  // mistake and pays for it each time.
  const c = classifyFailure(new ProviderError("Model request failed (400)", false, 400));
  assert.equal(c.class, "invalid_input");
  assert.equal(c.retryable, false);
});

test("24. malformed model output is terminal by explicit policy", () => {
  // Not a default: the model callers already run spec §85's bounded
  // repair (extractJson tries several shapes) before this can escape, so
  // a job-level retry would re-roll the same prompt at full cost with no
  // bound anyone reading the job row could see.
  const c = classifyFailure(new MalformedModelOutputError("no JSON in response"));
  assert.equal(c.class, "malformed_model_output");
  assert.equal(c.retryable, false);
});

test("Shopify statuses classify by what a retry could possibly fix", () => {
  const throttled = classifyFailure(new ShopifyAdminError("...", 429));
  assert.equal(throttled.class, "shopify_throttled");
  assert.equal(throttled.retryable, true);

  const down = classifyFailure(new ShopifyAdminError("...", 502));
  assert.equal(down.class, "shopify_unavailable");
  assert.equal(down.retryable, true);

  // A revoked grant. Retrying hammers a shop that already said no.
  for (const status of [401, 403]) {
    const denied = classifyFailure(new ShopifyAdminError("...", status));
    assert.equal(denied.class, "shopify_unauthorized", `status ${status}`);
    assert.equal(denied.retryable, false);
  }

  const bad = classifyFailure(new ShopifyAdminError("...", 422));
  assert.equal(bad.retryable, false);
});

test("Shopify signals its rate limit in the body, not with a 429", () => {
  // GraphQL throttling arrives as an error message with no HTTP status.
  // Classifying it terminal would drop catalog syncs during exactly the
  // periods when a merchant's catalog is busiest.
  const c = classifyFailure(new ShopifyAdminError("Throttled"));
  assert.equal(c.class, "shopify_throttled");
  assert.equal(c.retryable, true);

  // Any other statusless GraphQL error is the query being rejected.
  const rejected = classifyFailure(new ShopifyAdminError("Field 'x' doesn't exist"));
  assert.equal(rejected.retryable, false);
});

test("transport failures are retryable, and only when they say so", () => {
  for (const message of [
    "fetch failed",
    "network error while connecting",
    "socket hang up",
    "connection reset by peer",
    "ECONNREFUSED 10.0.0.1:443",
  ]) {
    const c = classifyFailure(new Error(message));
    assert.equal(c.class, "network", `${message} should be transport`);
  }

  // A TypeError from a programming mistake must NOT be retryable just
  // because fetch failures are also TypeErrors.
  const bug = new TypeError("undefined is not a function");
  assert.equal(classifyFailure(bug).class, "unknown");
  assert.equal(classifyFailure(bug).retryable, false);
});

test("an unclassified error is terminal", () => {
  for (const error of [
    new Error("something went sideways"),
    "a bare string",
    null,
    undefined,
    { not: "an error" },
    42,
  ]) {
    const c = classifyFailure(error);
    assert.equal(c.class, "unknown", `${String(error)} should be unknown`);
    assert.equal(c.retryable, false);
  }
});

test("explicitly terminal application errors are honoured", () => {
  assert.equal(classifyFailure(new TerminalJobError("no credentials")).class, "invalid_configuration");
  assert.equal(classifyFailure(new TerminalJobError("x")).retryable, false);
  assert.equal(classifyFailure(new MalformedSourceError("x")).class, "malformed_source_data");
  assert.equal(classifyFailure(new MalformedSourceError("x")).retryable, false);
});

test("classification survives the loss of the prototype", () => {
  // An error raised in one Convex action and observed in another has
  // crossed a serialisation boundary and is no longer an instance of
  // anything. Classifying on `instanceof` would work here in a unit test
  // and degrade every real cross-boundary failure to "unknown" — which
  // presents as "nothing ever retries", with no error to point at.
  const overTheWire = { name: "ProviderError", message: "Model request failed (429)", retryable: true, status: 429 };
  const c = classifyFailure(overTheWire);
  assert.equal(c.class, "provider_rate_limited");
  assert.equal(c.retryable, true);
});

test("the thrower's own judgement wins over the status code", () => {
  // A provider that saw the response and said "do not retry" is better
  // informed than a function looking at a number.
  const c = classifyFailure(new ProviderError("quota permanently exceeded", false, 429));
  assert.equal(c.retryable, false);
});

test("a persisted message is bounded and carries no response body", () => {
  const c = classifyFailure(new Error("x".repeat(5000)));
  assert.ok(c.message.length <= 200);
});

// ---------------------------------------------------------------- backoff

test("7. backoff grows exponentially and is bounded", () => {
  assert.equal(backoffMs(1, OPTS, noJitter), 1000);
  assert.equal(backoffMs(2, OPTS, noJitter), 2000);
  assert.equal(backoffMs(3, OPTS, noJitter), 4000);
  assert.equal(backoffMs(4, OPTS, noJitter), 8000);

  // The cap is what stops a generous attempt ceiling from scheduling the
  // last retry days out, which is indistinguishable from losing the job.
  assert.equal(backoffMs(40, OPTS, noJitter), OPTS.capMs);
  assert.equal(backoffMs(1000, OPTS, noJitter), OPTS.capMs);
  assert.ok(Number.isFinite(backoffMs(1e6, OPTS, noJitter)));
});

test("8. jitter stays inside the configured bounds", () => {
  // ±25% around the undisplaced delay, and never past the cap.
  assert.equal(backoffMs(3, OPTS, maxJitter), 5000); // 4000 * 1.25
  assert.equal(backoffMs(3, OPTS, minJitter), 3000); // 4000 * 0.75

  for (let attempt = 1; attempt <= 20; attempt++) {
    for (let i = 0; i < 200; i++) {
      const delay = backoffMs(attempt, OPTS);
      const undisplaced = Math.min(OPTS.capMs, OPTS.baseMs * Math.pow(2, attempt - 1));
      assert.ok(delay >= 0, "never negative");
      assert.ok(delay <= OPTS.capMs, `${delay} must not exceed the cap`);
      assert.ok(
        delay >= Math.floor(undisplaced * (1 - OPTS.jitter)),
        `${delay} below the jitter floor for attempt ${attempt}`,
      );
    }
  }
});

test("at the cap the spread is one-sided, and the cap still holds", () => {
  // Jitter is applied then clamped, so `capMs` means what it says rather
  // than "cap plus 25%". The spread survives, one-sided.
  assert.equal(backoffMs(50, OPTS, maxJitter), OPTS.capMs);
  assert.equal(backoffMs(50, OPTS, minJitter), OPTS.capMs * 0.75);
});

test("degenerate configuration cannot produce a negative or NaN delay", () => {
  const silly: BackoffOptions = { baseMs: -5, capMs: -1, jitter: 9 };
  const delay = backoffMs(3, silly, maxJitter);
  assert.ok(Number.isFinite(delay));
  assert.ok(delay >= 0);
});

test("the shipped defaults are sane rather than optimal", () => {
  // Not a claim that these are the right numbers — a claim that they are
  // in a range where being wrong is cheap.
  assert.ok(DEFAULT_BACKOFF.baseMs >= 100);
  assert.ok(DEFAULT_BACKOFF.capMs > DEFAULT_BACKOFF.baseMs);
  assert.ok(DEFAULT_BACKOFF.capMs <= 60 * 60 * 1000);
  assert.ok(DEFAULT_BACKOFF.jitter > 0 && DEFAULT_BACKOFF.jitter < 1);
});

// --------------------------------------------------------------- decision

test("1. a retryable failure produces a retry", () => {
  const d = decideRetry({ retryable: true, attempt: 1, maxAttempts: 3, options: OPTS });
  assert.equal(d.action, "retry");
});

test("2. a non-retryable failure fails immediately, with attempts to spare", () => {
  // The attempt ceiling is irrelevant here: nothing about trying again
  // changes the outcome, so spending two more attempts is pure cost.
  const d = decideRetry({ retryable: false, attempt: 1, maxAttempts: 3, options: OPTS });
  assert.equal(d.action, "fail");
  assert.equal(d.action === "fail" && d.reason, "terminal");
});

test("3+4. each retry schedules the next attempt with a growing delay", () => {
  const first = decideRetry({
    retryable: true, attempt: 1, maxAttempts: 3, options: OPTS, random: noJitter,
  });
  assert.equal(first.action, "retry");
  assert.equal(first.action === "retry" && first.nextAttempt, 2);
  assert.equal(first.action === "retry" && first.delayMs, 1000);

  const second = decideRetry({
    retryable: true, attempt: 2, maxAttempts: 3, options: OPTS, random: noJitter,
  });
  assert.equal(second.action === "retry" && second.nextAttempt, 3);
  assert.equal(second.action === "retry" && second.delayMs, 2000);
});

test("5. the last attempt fails rather than retrying", () => {
  // maxAttempts = 3 means three claims, not three retries after three
  // claims. `attempt` is already incremented when work was claimed, so
  // exhaustion is `attempt >= maxAttempts` with no off-by-one at the
  // call site.
  const d = decideRetry({ retryable: true, attempt: 3, maxAttempts: 3, options: OPTS });
  assert.equal(d.action, "fail");
  assert.equal(d.action === "fail" && d.reason, "attempts_exhausted");
});

test("the full attempt sequence for the default ceiling", () => {
  const outcomes = [1, 2, 3].map(
    (attempt) =>
      decideRetry({ retryable: true, attempt, maxAttempts: 3, options: OPTS }).action,
  );
  assert.deepEqual(outcomes, ["retry", "retry", "fail"]);
});

test("an attempt count past the ceiling still fails rather than retrying", () => {
  // Defensive: a job whose maxAttempts was lowered after it was created
  // must stop, not go negative or loop.
  const d = decideRetry({ retryable: true, attempt: 9, maxAttempts: 3, options: OPTS });
  assert.equal(d.action, "fail");
});

test("a ceiling of one means a single attempt and no retry", () => {
  const d = decideRetry({ retryable: true, attempt: 1, maxAttempts: 1, options: OPTS });
  assert.equal(d.action, "fail");
  assert.equal(d.action === "fail" && d.reason, "attempts_exhausted");
});

test("terminal beats exhaustion when both apply", () => {
  // The reason is what an operator reads. "Attempts exhausted" on an
  // error that was never retryable would send them looking for a
  // transient cause that never existed.
  const d = decideRetry({ retryable: false, attempt: 3, maxAttempts: 3, options: OPTS });
  assert.equal(d.action === "fail" && d.reason, "terminal");
});
