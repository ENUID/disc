/**
 * Retry policy (P1.3) — the classification and the arithmetic.
 *
 * Pure and database-free, so the two decisions that matter can be
 * exhausted by tests: *is this failure worth trying again*, and *how long
 * should we wait*. The stateful half — reading the attempt count, writing
 * the transition, scheduling the next attempt — lives in
 * `convex/scheduling.ts`, because it needs the row and a transaction.
 *
 * THE ARCHITECTURAL RULE THIS MODULE EXISTS TO SERVE:
 *
 *   Retry belongs to the durable job executor, not to callers.
 *
 * No HTTP handler, webhook handler or cron caller retries anything. They
 * enqueue logical work exactly once; the executor decides how many times
 * that work is attempted. A caller that retried on its own would either
 * duplicate the executor's attempts or race them, and neither shows up in
 * the job row — which is the record that is supposed to answer "why did
 * this run three times".
 *
 *   one logical operation
 *     -> one idempotency key
 *       -> one durable job
 *         -> multiple bounded attempts
 */

import { RETRY_BASE_MS, RETRY_CAP_MS, RETRY_JITTER } from "./env";

/**
 * How a failure is classified.
 *
 * The taxonomy is closed, and the split is not cosmetic: a retryable
 * class costs another attempt and another provider call, a terminal one
 * stops immediately. Getting it backwards is expensive in one direction
 * (retrying a 400 burns money and never succeeds) and lossy in the other
 * (giving up on a 429 drops work that would have gone through).
 */
export const FAILURE_CLASSES = [
  // --- retryable: the same request may succeed later, unchanged
  "provider_rate_limited",
  "provider_unavailable",
  "shopify_throttled",
  "shopify_unavailable",
  "network",
  "stalled",

  // --- terminal: the same request will fail the same way forever
  "shopify_unauthorized",
  "invalid_input",
  "invalid_configuration",
  "malformed_source_data",
  "malformed_model_output",
  "unknown",
] as const;

export type FailureClass = (typeof FAILURE_CLASSES)[number];

/**
 * The retryable set, written out rather than derived.
 *
 * Every class not in here is terminal, including `unknown`. That default
 * is deliberate and is the single most important line in this file: an
 * error nobody has classified is an error nobody has shown to be safe to
 * repeat. Treating unknown failures as retryable would turn every new bug
 * into a paid retry loop, and the failure mode of guessing wrong that way
 * is a bill rather than an error message.
 */
export const RETRYABLE: ReadonlySet<FailureClass> = new Set<FailureClass>([
  "provider_rate_limited",
  "provider_unavailable",
  "shopify_throttled",
  "shopify_unavailable",
  "network",
  "stalled",
]);

export function isRetryableClass(cls: FailureClass): boolean {
  return RETRYABLE.has(cls);
}

export function isFailureClass(value: unknown): value is FailureClass {
  return (
    typeof value === "string" && (FAILURE_CLASSES as readonly string[]).includes(value)
  );
}

export type Classification = {
  class: FailureClass;
  retryable: boolean;
  /** Normalised, safe to persist and to log. Never the raw provider body. */
  message: string;
};

/** Persisted and logged, so it is capped well below the document limit. */
const MAX_MESSAGE = 200;

/**
 * Patterns that identify a transient transport failure.
 *
 * Message matching is a last resort and is scoped as tightly as possible:
 * it applies only after the typed paths below have been tried, and only
 * to errors whose text actually names a transport condition. A broad
 * match here would quietly re-admit "unknown is retryable" through the
 * back door.
 */
const NETWORK_PATTERNS =
  /\b(fetch failed|failed to fetch|network|socket hang up|connection (reset|refused|closed)|econnreset|econnrefused|etimedout|enotfound|dns|tls handshake|error sending request)\b/i;

const TIMEOUT_PATTERNS = /\b(timed? ?out|timeout|deadline exceeded|aborted)\b/i;

function safeMessage(raw: unknown): string {
  const text =
    raw instanceof Error
      ? raw.message
      : typeof raw === "string"
        ? raw
        : "Unknown error";
  return text.slice(0, MAX_MESSAGE);
}

/**
 * Read the fields we care about without `instanceof`.
 *
 * Deliberate: an error raised inside one Convex action and observed by
 * another has crossed a serialisation boundary, and its prototype does
 * not survive that. `error.name` does. Classifying on the prototype would
 * work in a unit test and silently degrade every cross-boundary failure
 * to `unknown` in production — the exact kind of bug that only shows up
 * as "nothing ever retries".
 */
function shapeOf(error: unknown): {
  name: string;
  message: string;
  status?: number;
  retryable?: boolean;
} {
  if (error === null || typeof error !== "object") {
    return { name: "", message: safeMessage(error) };
  }
  const e = error as { name?: unknown; message?: unknown; status?: unknown; retryable?: unknown };
  return {
    name: typeof e.name === "string" ? e.name : "",
    message: safeMessage(error),
    status: typeof e.status === "number" ? e.status : undefined,
    retryable: typeof e.retryable === "boolean" ? e.retryable : undefined,
  };
}

/**
 * Map an HTTP status to a class, given which service produced it.
 *
 * 401/403 are singled out for Shopify because they mean the merchant's
 * grant is gone — an uninstall, a revoked token, a rotated secret. No
 * number of retries fixes that, and retrying hammers a shop that has
 * already said no.
 */
function classifyStatus(
  status: number,
  service: "provider" | "shopify",
): FailureClass {
  if (status === 429) {
    return service === "shopify" ? "shopify_throttled" : "provider_rate_limited";
  }
  if (status >= 500) {
    return service === "shopify" ? "shopify_unavailable" : "provider_unavailable";
  }
  if (service === "shopify" && (status === 401 || status === 403)) {
    return "shopify_unauthorized";
  }
  // Every other 4xx is the request itself being wrong. Repeating it
  // repeats the mistake.
  return "invalid_input";
}

/**
 * Classify a failure.
 *
 * Order matters. Typed evidence first (an explicit `retryable` flag, then
 * a status code), transport patterns second, and `unknown` — terminal —
 * for everything that produced no evidence at all.
 */
export function classifyFailure(error: unknown): Classification {
  const { name, message, status, retryable } = shapeOf(error);

  const done = (cls: FailureClass): Classification => ({
    class: cls,
    retryable: isRetryableClass(cls),
    message,
  });

  // --- Explicitly classified application errors. These are assertions by
  // code that knows what it threw, and they win over everything else.
  if (name === "TerminalJobError") return done("invalid_configuration");
  if (name === "MalformedSourceError") return done("malformed_source_data");
  if (name === "MalformedModelOutputError") return done("malformed_model_output");

  // --- ShopifyAdminError carries a status when the transport failed and
  // none when the GraphQL body reported errors. Shopify signals its own
  // rate limiting in that body rather than with a 429, so the throttle
  // check has to look at the text — narrowly, on one word.
  if (name === "ShopifyAdminError") {
    if (status !== undefined) return done(classifyStatus(status, "shopify"));
    if (/throttl/i.test(message)) return done("shopify_throttled");
    // A GraphQL error with no status is a malformed or rejected query.
    // Repeating it produces the same rejection.
    return done("invalid_input");
  }

  // --- ProviderError decided for itself at the call site, where the
  // response was in hand. `status` refines the class; the flag decides.
  if (name === "ProviderError") {
    if (status !== undefined) {
      const cls = classifyStatus(status, "provider");
      // Trust the flag over the derived class when they disagree: the
      // thrower saw the response, this function only sees a number.
      if (retryable === false && isRetryableClass(cls)) return done("invalid_input");
      return done(cls);
    }
    if (retryable === true) return done("provider_unavailable");
    return done("invalid_input");
  }

  // --- Transport. Scoped to errors whose text names a transport
  // condition; a bare TypeError from a programming mistake must not
  // qualify, which is why the name alone is never enough.
  if (NETWORK_PATTERNS.test(message)) return done("network");
  if (
    (name === "AbortError" || name === "TimeoutError" || name === "TypeError") &&
    TIMEOUT_PATTERNS.test(message)
  ) {
    return done("network");
  }

  // --- No evidence. Terminal, on purpose.
  return done("unknown");
}

/**
 * A failure a worker raises when it knows retrying cannot help.
 *
 * The escape hatch from the "unknown is terminal" default working in the
 * other direction: some failures are terminal for a domain reason no
 * status code expresses — a tenant with no credentials, a configuration
 * a merchant has to change. Saying so explicitly is better than relying
 * on the default, because the default is also what an unclassified bug
 * lands in, and these two should not be indistinguishable in a job row.
 */
export class TerminalJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminalJobError";
  }
}

/**
 * Source data that exists and cannot be interpreted.
 *
 * Terminal by construction: the record is immutable from Disc's side, so
 * re-reading it produces the same bytes and the same failure. This is a
 * different thing from a transport failure that happened to occur while
 * reading it, which is why it is not left to `unknown`.
 */
export class MalformedSourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSourceError";
  }
}

/**
 * A model returned something that could not be parsed.
 *
 * POLICY, stated once here because "retry the model" is the most
 * tempting and most expensive wrong answer in this file: this is
 * TERMINAL. Disc's model callers already implement spec §85's
 * repair-then-fallback inside the call — `extractJson` tries several
 * shapes and the caller keeps its deterministic result when none parse —
 * so by the time an unparseable response escapes as an error, the bounded
 * repair strategy has already run and failed. Retrying at the job level
 * would re-run a whole job to re-roll the same prompt at full cost, with
 * no bound that anyone reading the job row could see.
 */
export class MalformedModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedModelOutputError";
  }
}

// ---------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------

export type BackoffOptions = {
  baseMs: number;
  capMs: number;
  /** Fraction of the delay, applied either side. 0.25 = ±25%. */
  jitter: number;
};

/**
 * Defaults.
 *
 * THESE ARE NOT CLAIMED TO BE PRODUCTION-OPTIMAL. They are a starting
 * point chosen so that the first retry is fast enough to ride out a
 * one-second blip and the last is slow enough not to hammer a provider
 * that is genuinely down. Tune them against real failure data; that is
 * why they are environment-configurable rather than literals.
 */
export const DEFAULT_BACKOFF: BackoffOptions = {
  baseMs: RETRY_BASE_MS,
  capMs: RETRY_CAP_MS,
  jitter: RETRY_JITTER,
};

/**
 * Delay before the attempt following `attempt`.
 *
 *   delay = min(capMs, baseMs * 2^(attempt - 1)), then jittered
 *
 * Doubling is capped rather than unbounded: without the cap, a job with a
 * generous attempt ceiling schedules its last retry days out, which is
 * indistinguishable from losing it.
 *
 * Jitter is applied and then clamped back into `[0, capMs]`, so the cap
 * is a real ceiling rather than a ceiling plus 25%. The consequence is
 * that at the cap the spread becomes one-sided (`[0.75 * cap, cap]`),
 * which is fine — the purpose of jitter is to stop a fleet of jobs that
 * failed together from retrying in lockstep, and a one-sided spread does
 * that just as well.
 */
export function backoffMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const n = Math.max(1, Math.floor(attempt));
  const capMs = Math.max(0, options.capMs);
  const baseMs = Math.max(0, options.baseMs);
  const jitter = Math.min(1, Math.max(0, options.jitter));

  // 2^(n-1) overflows into Infinity for large n; min() handles it, but
  // capping the exponent keeps the arithmetic finite and inspectable.
  const growth = Math.pow(2, Math.min(n - 1, 32));
  const raw = Math.min(capMs, baseMs * growth);

  const spread = raw * jitter;
  const jittered = raw + (random() * 2 - 1) * spread;
  return Math.round(Math.min(capMs, Math.max(0, jittered)));
}

// ---------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------

export type RetryDecision =
  | { action: "retry"; delayMs: number; nextAttempt: number }
  | { action: "fail"; reason: "terminal" | "attempts_exhausted" };

/**
 * Decide what happens after one attempt failed.
 *
 * `attempt` is the attempt that just failed, and it has already been
 * incremented — `claimJob` does that when work is taken, not when it
 * fails. So "attempts are exhausted" is `attempt >= maxAttempts`, with no
 * off-by-one to reason about at the call site.
 *
 * With maxAttempts = 3:
 *
 *   claim -> attempt 1 -> retryable failure -> retrying (delay ~1s)
 *   claim -> attempt 2 -> retryable failure -> retrying (delay ~2s)
 *   claim -> attempt 3 -> retryable failure -> failed
 *
 * A process that crashes after claiming and never reports anything has
 * still consumed its attempt, which is what stops a crash loop from
 * retrying forever.
 */
export function decideRetry(input: {
  retryable: boolean;
  attempt: number;
  maxAttempts: number;
  options?: BackoffOptions;
  random?: () => number;
}): RetryDecision {
  if (!input.retryable) return { action: "fail", reason: "terminal" };
  if (input.attempt >= input.maxAttempts) {
    return { action: "fail", reason: "attempts_exhausted" };
  }
  return {
    action: "retry",
    delayMs: backoffMs(input.attempt, input.options ?? DEFAULT_BACKOFF, input.random),
    nextAttempt: input.attempt + 1,
  };
}
