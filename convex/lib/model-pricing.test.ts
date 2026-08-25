import { test } from "node:test";
import assert from "node:assert/strict";
import {
  estimateCostUsd,
  formatUsd,
  isPriced,
  isShopperDriven,
  MODEL_PRICES,
  OPERATIONS,
  rateFor,
  resetPriceCache,
  UNKNOWN_MODEL_RATE,
} from "./model-pricing";

/**
 * The arithmetic that every price tier will eventually rest on.
 *
 * Two failure modes matter here and neither announces itself: costing an
 * unknown model at zero (spend silently vanishes from every report), and
 * rounding at the point of accumulation (a call costs fractions of a
 * cent, so rounding floors it to zero and the monthly bill reads as
 * nothing).
 */

test("cost is tokens times rate, per million", () => {
  // 1M input at $3 + 1M output at $15.
  assert.equal(estimateCostUsd("claude-sonnet-4-5", 1_000_000, 1_000_000), 18);
  assert.equal(estimateCostUsd("claude-sonnet-4-5", 500_000, 0), 1.5);
  assert.equal(estimateCostUsd("claude-sonnet-4-5", 0, 0), 0);
});

test("a realistic call is not rounded away", () => {
  // A judge call: ~2,000 in, ~600 out on Sonnet. Fractions of a cent.
  const cost = estimateCostUsd("claude-sonnet-4-5", 2000, 600);
  assert.ok(cost > 0, "a real call must not cost zero");
  // 2000/1e6*3 + 600/1e6*15 = 0.006 + 0.009
  assert.ok(Math.abs(cost - 0.015) < 1e-9, `expected ~0.015, got ${cost}`);

  // The thing this guards: accumulate a thousand of them and the total
  // must be a real number, not a thousand roundings to zero.
  let total = 0;
  for (let i = 0; i < 1000; i++) total += cost;
  assert.ok(Math.abs(total - 15) < 1e-6, `expected ~15, got ${total}`);
});

test("an unpriced model costs the unknown rate, never zero", () => {
  // Pricing an unknown model at zero would make a whole deployment's
  // spend disappear the moment someone points DISC_MODEL_STRONG at
  // something not in the table.
  const cost = estimateCostUsd("some-model-nobody-priced", 1_000_000, 1_000_000);
  assert.equal(cost, UNKNOWN_MODEL_RATE.input + UNKNOWN_MODEL_RATE.output);
  assert.ok(cost > 0);
  assert.equal(isPriced("some-model-nobody-priced"), false);
  assert.equal(isPriced("claude-sonnet-4-5"), true);
});

test("the unknown rate is at least as expensive as anything known", () => {
  // It has to over-estimate. An unpriced model that costs less than a
  // real one would understate spend, which is the direction that hurts.
  for (const [model, rate] of Object.entries(MODEL_PRICES)) {
    assert.ok(
      UNKNOWN_MODEL_RATE.input >= rate.input,
      `unknown input rate below ${model}`,
    );
    assert.ok(
      UNKNOWN_MODEL_RATE.output >= rate.output,
      `unknown output rate below ${model}`,
    );
  }
});

test("negative token counts cannot create a credit", () => {
  // A provider returning nonsense must not reduce the running total.
  assert.equal(estimateCostUsd("claude-sonnet-4-5", -1_000_000, -1_000_000), 0);
});

test("the stand-in provider is free", () => {
  // Tests and keyless deployments must not accumulate phantom spend.
  assert.equal(estimateCostUsd("null-provider", 999_999, 999_999), 0);
});

test("embeddings are priced on input only", () => {
  const rate = rateFor("text-embedding-3-small");
  assert.equal(rate.output, 0);
  assert.ok(rate.input > 0);
  // Output tokens are meaningless for an embedding; charging for them
  // would inflate the one cost that scales with search traffic.
  assert.equal(
    estimateCostUsd("text-embedding-3-small", 1_000_000, 5_000_000),
    rate.input,
  );
});

test("env overrides replace built-in rates", () => {
  const previous = process.env.DISC_MODEL_PRICES;
  try {
    process.env.DISC_MODEL_PRICES = JSON.stringify({
      "claude-sonnet-4-5": { input: 1, output: 2 },
    });
    resetPriceCache();

    assert.deepEqual(rateFor("claude-sonnet-4-5"), { input: 1, output: 2 });
    assert.equal(estimateCostUsd("claude-sonnet-4-5", 1_000_000, 1_000_000), 3);
    // Unmentioned models keep the built-in rate.
    assert.deepEqual(rateFor("claude-haiku-4-5-20251001"), {
      input: 1,
      output: 5,
    });
  } finally {
    if (previous === undefined) delete process.env.DISC_MODEL_PRICES;
    else process.env.DISC_MODEL_PRICES = previous;
    resetPriceCache();
  }
});

test("a malformed override degrades to built-in rates rather than throwing", () => {
  const previous = process.env.DISC_MODEL_PRICES;
  try {
    process.env.DISC_MODEL_PRICES = "{not json";
    resetPriceCache();
    // A typo in an env var must not take down every model call in the
    // deployment.
    assert.deepEqual(rateFor("claude-sonnet-4-5"), MODEL_PRICES["claude-sonnet-4-5"]);
  } finally {
    if (previous === undefined) delete process.env.DISC_MODEL_PRICES;
    else process.env.DISC_MODEL_PRICES = previous;
    resetPriceCache();
  }
});

test("partial override entries are ignored, not half-applied", () => {
  const previous = process.env.DISC_MODEL_PRICES;
  try {
    process.env.DISC_MODEL_PRICES = JSON.stringify({
      "claude-sonnet-4-5": { input: 1 }, // no output rate
    });
    resetPriceCache();
    // Half an override would mean output silently priced at undefined,
    // which arithmetic turns into NaN and NaN poisons every total.
    const cost = estimateCostUsd("claude-sonnet-4-5", 1_000_000, 1_000_000);
    assert.ok(Number.isFinite(cost), "cost must never be NaN");
    assert.equal(cost, 18);
  } finally {
    if (previous === undefined) delete process.env.DISC_MODEL_PRICES;
    else process.env.DISC_MODEL_PRICES = previous;
    resetPriceCache();
  }
});

test("shopper-driven and catalog-driven operations are correctly split", () => {
  // This split decides whether a catalog-size price tier is adequate.
  // Catalog spend is one-time per product and a size tier covers it;
  // shopper spend scales with traffic and a size tier does not.
  for (const op of ["intent", "judge", "explanation", "refine", "query_embedding"]) {
    assert.equal(isShopperDriven(op), true, `${op} should be shopper-driven`);
  }
  for (const op of ["enrichment", "vision", "embedding", "brand"]) {
    assert.equal(isShopperDriven(op), false, `${op} should be catalog-driven`);
  }
});

test("query embedding is separate from catalog embedding", () => {
  // /search calls no reasoning model, which makes it easy to describe as
  // free. It is not — it embeds the query every time, and that is the
  // only cost on that path that scales with traffic. Merged into
  // "embedding" it would hide underneath ingestion.
  assert.ok((OPERATIONS as readonly string[]).includes("query_embedding"));
  assert.ok((OPERATIONS as readonly string[]).includes("embedding"));
  assert.notEqual(isShopperDriven("embedding"), isShopperDriven("query_embedding"));
});

test("small amounts format with enough precision to be visible", () => {
  // "$0.00" for a real cost is how a bill appears to be nothing.
  assert.equal(formatUsd(0), "$0");
  assert.ok(formatUsd(0.000015) !== "$0.00");
  assert.equal(formatUsd(0.000015), "$0.00002");
  assert.equal(formatUsd(0.5), "$0.5000");
  assert.equal(formatUsd(12.3456), "$12.35");
});
