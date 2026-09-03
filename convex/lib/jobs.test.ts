import { test } from "node:test";
import assert from "node:assert/strict";
import {
  allowedFrom,
  boundError,
  boundProgress,
  canTransition,
  CLAIMABLE,
  DEFAULT_MAX_ATTEMPTS,
  idempotencyKey,
  isClaimable,
  isJobStatus,
  isJobType,
  isTerminal,
  JOB_STATUSES,
  JOB_TYPES,
  refusalFor,
  TERMINAL,
  type JobStatus,
} from "./jobs";

/**
 * The state machine, exhausted rather than sampled.
 *
 * A happy-path test proves a job can succeed. It says nothing about
 * whether a succeeded job can be revived, or whether a running job can
 * be claimed twice — and those are the transitions that corrupt data.
 * So the first test below asserts the ENTIRE 6x6 matrix, and every
 * transition not explicitly permitted is asserted to be refused.
 */

/** The permitted set, written out independently of the implementation. */
const EXPECTED: Array<[JobStatus, JobStatus]> = [
  ["queued", "running"],
  ["queued", "cancelled"],
  ["running", "succeeded"],
  ["running", "retrying"],
  ["running", "failed"],
  ["running", "cancelled"],
  ["retrying", "running"],
  ["retrying", "failed"],
  ["retrying", "cancelled"],
];

test("the transition matrix is exactly the permitted set — all 36 pairs", () => {
  const permitted = new Set(EXPECTED.map(([from, to]) => `${from}->${to}`));

  let checked = 0;
  for (const from of JOB_STATUSES) {
    for (const to of JOB_STATUSES) {
      const shouldAllow = permitted.has(`${from}->${to}`);
      assert.equal(
        canTransition(from, to),
        shouldAllow,
        `${from} -> ${to} should be ${shouldAllow ? "allowed" : "refused"}`,
      );
      checked++;
    }
  }
  assert.equal(checked, 36, "every pair must be asserted, not sampled");
});

test("a terminal job can never leave its state", () => {
  // The invariant: "a completed job cannot accidentally become pending
  // again". Enforced by terminal states having an empty transition set,
  // so there is no path back into the machine at all.
  for (const terminal of TERMINAL) {
    assert.deepEqual(
      allowedFrom(terminal),
      [],
      `${terminal} must have no outgoing transitions`,
    );
    for (const to of JOB_STATUSES) {
      assert.equal(canTransition(terminal, to), false, `${terminal} -> ${to}`);
    }
  }
});

test("no state can transition to itself", () => {
  // Self-transition would let a second claim look like a success, and
  // would make `attempt` meaningless.
  for (const status of JOB_STATUSES) {
    assert.equal(canTransition(status, status), false, `${status} -> ${status}`);
  }
});

test("every live state can be cancelled", () => {
  // Cancelling a job that has not started is the ordinary case — an
  // uninstall, a purge, a superseded sync. Requiring it to be claimed
  // first would mean doing the work in order to abandon it.
  for (const live of ["queued", "running", "retrying"] as JobStatus[]) {
    assert.equal(canTransition(live, "cancelled"), true, `${live} -> cancelled`);
  }
});

test("only queued and retrying are claimable", () => {
  assert.equal(isClaimable("queued"), true);
  assert.equal(isClaimable("retrying"), true);
  // THE double-execution guard.
  assert.equal(isClaimable("running"), false);
  assert.equal(isClaimable("succeeded"), false);
  assert.equal(isClaimable("failed"), false);
  assert.equal(isClaimable("cancelled"), false);

  // The claimable set and the "has an inbound edge to running" set must
  // agree, or a job could be claimable without the transition being legal.
  for (const status of JOB_STATUSES) {
    assert.equal(
      CLAIMABLE.has(status),
      canTransition(status, "running"),
      `${status}: claimable and can-transition-to-running must agree`,
    );
  }
});

test("terminal and claimable are disjoint", () => {
  for (const status of JOB_STATUSES) {
    assert.equal(
      isTerminal(status) && isClaimable(status),
      false,
      `${status} cannot be both finished and claimable`,
    );
  }
});

test("a refusal distinguishes contention from completion", () => {
  // "Someone else has it" may be worth observing. "This is over" never
  // is. Collapsing them would make a stuck job look like a busy one.
  assert.equal(refusalFor("running"), "already_running");
  assert.equal(refusalFor("succeeded"), "already_finished");
  assert.equal(refusalFor("failed"), "already_finished");
  assert.equal(refusalFor("cancelled"), "already_finished");
});

// ------------------------------------------------------------ idempotency

test("the idempotency key identifies logical work, not an execution", () => {
  // Two deliveries of one webhook must produce one key.
  const a = idempotencyKey("product_enrichment", ["tenant_1", "prod_9", "hash_abc"]);
  const b = idempotencyKey("product_enrichment", ["tenant_1", "prod_9", "hash_abc"]);
  assert.equal(a, b);

  // Different content is different work.
  assert.notEqual(
    a,
    idempotencyKey("product_enrichment", ["tenant_1", "prod_9", "hash_xyz"]),
  );
  // Different type is different work even with identical parts.
  assert.notEqual(
    a,
    idempotencyKey("product_embedding", ["tenant_1", "prod_9", "hash_abc"]),
  );
});

test("key parts cannot be reassembled into a collision", () => {
  // ["a", "b|c"] and ["a|b", "c"] must not produce the same key, or two
  // unrelated pieces of work would deduplicate into one and one webhook
  // would silently suppress another.
  //
  // This test failed on the first implementation, which joined parts on
  // "|" without escaping them. Kept as written rather than softened.
  assert.notEqual(
    idempotencyKey("catalog_sync", ["a", "b|c"]),
    idempotencyKey("catalog_sync", ["a|b", "c"]),
  );

  // The escape must itself be injective: a literal "%7C" in an input
  // must not collide with an escaped separator.
  assert.notEqual(
    idempotencyKey("catalog_sync", ["a", "b%7Cc"]),
    idempotencyKey("catalog_sync", ["a", "b|c"]),
  );
  assert.notEqual(
    idempotencyKey("catalog_sync", ["a%25b"]),
    idempotencyKey("catalog_sync", ["a%b"]),
  );
});

test("numeric key parts are stable", () => {
  assert.equal(
    idempotencyKey("analytics_rollup", ["t1", 20260826]),
    idempotencyKey("analytics_rollup", ["t1", "20260826"]),
  );
});

// ------------------------------------------------------------- vocabulary

test("job types are a closed set that excludes the shopper path", () => {
  assert.equal(isJobType("catalog_sync"), true);
  assert.equal(isJobType("product_enrichment"), true);
  // A typo must be a rejected type, not a job nobody is watching.
  assert.equal(isJobType("catalogSync"), false);
  assert.equal(isJobType(""), false);
  assert.equal(isJobType(null), false);

  // A search or an outfit build is a user-facing deterministic
  // computation and runs inline. Making it a durable job would put a
  // state machine between a shopper and an answer they asked for half a
  // second ago.
  for (const inline of ["search", "outfit", "intent", "explanation"]) {
    assert.equal(isJobType(inline), false, `${inline} must not be a job type`);
  }
});

test("every declared job type is recognised, and the set is background-only", () => {
  // Guards the vocabulary against drift in both directions: a type in
  // the list that the guard rejects, and a guard that accepts anything.
  for (const type of JOB_TYPES) {
    assert.equal(isJobType(type), true, `${type} should be a valid job type`);
  }
  assert.ok(JOB_TYPES.length > 0);
  // Every one of them is work that is expensive, long-running or
  // externally triggered — never anything on a shopper's request path.
  for (const type of JOB_TYPES) {
    assert.match(
      type,
      /catalog|product|brand|look|analytics|data/,
      `${type} does not look like background work`,
    );
  }
});

test("status vocabulary is closed", () => {
  assert.equal(isJobStatus("queued"), true);
  assert.equal(isJobStatus("Running"), false);
  assert.equal(isJobStatus("pending"), false);
  assert.equal(isJobStatus(undefined), false);
});

test("the default attempt ceiling is recorded but bounded", () => {
  // Recorded now, enforced by the retry phase. A ceiling of 1 would make
  // the field pointless; an unbounded one would be a crash loop.
  assert.ok(DEFAULT_MAX_ATTEMPTS > 1);
  assert.ok(DEFAULT_MAX_ATTEMPTS <= 10);
});

// ----------------------------------------------------------------- bounds

test("progress is bounded so a job row cannot outgrow a document", () => {
  const huge: Record<string, unknown> = {};
  for (let i = 0; i < 500; i++) huge[`key_${i}`] = "x".repeat(5000);

  const bounded = boundProgress(huge) as Record<string, unknown>;
  assert.ok(Object.keys(bounded).length <= 12);
  for (const value of Object.values(bounded)) {
    assert.ok(String(value).length <= 200);
  }
});

test("progress nesting is dropped, not walked", () => {
  // One level deep. Nesting is how a bounded blob becomes unbounded.
  const bounded = boundProgress({
    done: 12,
    total: 400,
    nested: { a: { b: { c: "deep" } } },
  }) as Record<string, unknown>;

  assert.equal(bounded.done, 12);
  assert.equal(bounded.total, 400);
  assert.equal("nested" in bounded, false);
});

test("progress accepts the scalar shapes a job actually reports", () => {
  assert.equal(boundProgress(42), 42);
  assert.equal(boundProgress(true), true);
  assert.equal(boundProgress("embedding page 3"), "embedding page 3");
  assert.equal(boundProgress(null), undefined);
  assert.equal(boundProgress(undefined), undefined);
});

test("errors are truncated and never throw on odd input", () => {
  assert.equal(boundError(new Error("boom")), "boom");
  assert.equal(boundError("plain string"), "plain string");
  assert.equal(boundError(null), "Unknown error");
  assert.equal(boundError({ weird: true }), "Unknown error");
  assert.ok(boundError(new Error("x".repeat(9000))).length <= 500);
});
