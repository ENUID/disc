import { test } from "node:test";
import assert from "node:assert/strict";
import {
  accumulate,
  applyDelta,
  countsDrift,
  countsFrom,
  COUNT_FIELDS,
  hasNoImages,
  hasRejectedFields,
  isEmbedded,
  isLowConfidence,
  isNoOpDelta,
  isUnavailable,
  LOW_CONFIDENCE_THRESHOLD,
  mergeDelta,
  productDelta,
  profileDelta,
  ZERO_COUNTS,
  type CountableProduct,
  type CountableProfile,
} from "./catalog-counts";

/**
 * The counter arithmetic, without a database.
 *
 * These functions are shared by the live counter and the reconciliation
 * rebuild precisely so the two cannot disagree about what "enriched" or
 * "low confidence" means. Exhausting them here is what makes that
 * sharing worth anything.
 */

const product = (over: Partial<CountableProduct> = {}): CountableProduct => ({
  anyVariantAvailable: true,
  images: ["https://cdn/a.jpg"],
  ...over,
});

const profile = (over: Partial<CountableProfile> = {}): CountableProfile => ({
  completeness: 0.9,
  ...over,
});

// ------------------------------------------------------------ predicates

test("the predicates match the semantics catalogHealth reported before", () => {
  assert.equal(isUnavailable(product({ anyVariantAvailable: false })), true);
  assert.equal(isUnavailable(product()), false);

  assert.equal(hasNoImages(product({ images: [] })), true);
  assert.equal(hasNoImages(product()), false);

  assert.equal(isLowConfidence(profile({ completeness: 0.2 })), true);
  assert.equal(isLowConfidence(profile({ completeness: 0.9 })), false);
  // The boundary is exclusive: exactly at the threshold is NOT low.
  assert.equal(isLowConfidence(profile({ completeness: LOW_CONFIDENCE_THRESHOLD })), false);

  assert.equal(hasRejectedFields(profile({ rejectedFields: ["garment"] })), true);
  assert.equal(hasRejectedFields(profile({ rejectedFields: [] })), false);
  assert.equal(hasRejectedFields(profile()), false);
});

test("indexed is read from the product, never from an embedding row", () => {
  // The whole point of `embeddedAt`. Answering "is this product indexed"
  // by reading `productEmbeddings` means materialising a 1,536-dimension
  // vector to compute a boolean.
  assert.equal(isEmbedded(product({ embeddedAt: 1 })), true);
  assert.equal(isEmbedded(product()), false);
  // Epoch zero is a real timestamp, not "absent".
  assert.equal(isEmbedded(product({ embeddedAt: 0 })), true);
});

// ----------------------------------------------------------- transitions

test("a product appearing counts everything it contributes", () => {
  const delta = productDelta(null, product({ anyVariantAvailable: false, images: [] }));
  assert.equal(delta.productCount, 1);
  assert.equal(delta.unavailableCount, 1);
  assert.equal(delta.missingImagesCount, 1);
  assert.equal(delta.embeddedCount, 0);
});

test("a product disappearing undoes exactly what it contributed", () => {
  const p = product({ anyVariantAvailable: false, images: [], embeddedAt: 1 });
  const delta = productDelta(p, null);
  assert.equal(delta.productCount, -1);
  assert.equal(delta.unavailableCount, -1);
  assert.equal(delta.missingImagesCount, -1);
  assert.equal(delta.embeddedCount, -1);
});

test("re-applying an unchanged product is a no-op", () => {
  // THE RETRY CASE. A job that runs twice must not increment twice, and
  // this is where that is guaranteed: identical before and after produce
  // a zero delta rather than a second count.
  const p = product({ embeddedAt: 1 });
  assert.equal(isNoOpDelta(productDelta(p, { ...p })), true);
});

test("a product going out of stock moves only that counter", () => {
  const delta = productDelta(product(), product({ anyVariantAvailable: false }));
  assert.equal(delta.productCount, 0);
  assert.equal(delta.unavailableCount, 1);
  assert.equal(delta.missingImagesCount, 0);
});

test("a product coming back into stock reverses it", () => {
  const delta = productDelta(product({ anyVariantAvailable: false }), product());
  assert.equal(delta.unavailableCount, -1);
});

test("an update to an indexed product keeps it indexed", () => {
  // `db.patch` merges, so `embeddedAt` survives an update. Losing it
  // here would decrement `indexed` on every catalog resync.
  const delta = productDelta(
    product({ embeddedAt: 5 }),
    product({ embeddedAt: 5, images: [] }),
  );
  assert.equal(delta.embeddedCount, 0);
  assert.equal(delta.missingImagesCount, 1);
});

test("a profile appearing counts as enriched", () => {
  const delta = profileDelta(null, profile({ completeness: 0.2, rejectedFields: ["fit"] }));
  assert.equal(delta.enrichedCount, 1);
  assert.equal(delta.lowConfidenceCount, 1);
  assert.equal(delta.rejectedFieldsCount, 1);
});

test("a profile REPLACEMENT is not a no-op", () => {
  // The case most easily got wrong: enrichedCount is unchanged because
  // the product was already enriched, but completeness can cross the
  // threshold and rejectedFields can clear. Treating replacement as
  // "nothing changed" would drift on every re-enrichment.
  const delta = profileDelta(
    profile({ completeness: 0.2, rejectedFields: ["fit"] }),
    profile({ completeness: 0.9, rejectedFields: [] }),
  );
  assert.equal(delta.enrichedCount, 0);
  assert.equal(delta.lowConfidenceCount, -1);
  assert.equal(delta.rejectedFieldsCount, -1);
});

test("re-saving an identical profile is a no-op", () => {
  const p = profile({ completeness: 0.4, rejectedFields: ["fit"] });
  assert.equal(isNoOpDelta(profileDelta(p, { ...p })), true);
});

test("a profile disappearing undoes its contributions", () => {
  const delta = profileDelta(profile({ completeness: 0.2, rejectedFields: ["x"] }), null);
  assert.equal(delta.enrichedCount, -1);
  assert.equal(delta.lowConfidenceCount, -1);
  assert.equal(delta.rejectedFieldsCount, -1);
});

// ------------------------------------------------------------ arithmetic

test("deltas merge additively", () => {
  const merged = mergeDelta(
    { productCount: 1, embeddedCount: 1 },
    { productCount: 1, unavailableCount: -1 },
  );
  assert.equal(merged.productCount, 2);
  assert.equal(merged.embeddedCount, 1);
  assert.equal(merged.unavailableCount, -1);
});

test("counters never go negative", () => {
  // A negative count is never correct and would render as nonsense on a
  // merchant's dashboard. The clamp hides the sign of drift, which is
  // why reconciliation rebuilds rather than trusting the running total.
  const next = applyDelta(ZERO_COUNTS, { productCount: -5, enrichedCount: -1 });
  assert.equal(next.productCount, 0);
  assert.equal(next.enrichedCount, 0);
});

test("an absent counter reads as zero", () => {
  // Tenant rows written before this phase have none of these fields.
  const counts = countsFrom({});
  for (const field of COUNT_FIELDS) assert.equal(counts[field], 0, field);
});

test("accumulate and the deltas agree on the same catalog", () => {
  // THE PROPERTY THAT MATTERS: the live counter and the reconciliation
  // rebuild must produce the same numbers, or reconciliation would
  // "correct" a correct counter every night.
  const catalog: Array<[CountableProduct, CountableProfile | null]> = [
    [product({ embeddedAt: 1 }), profile({ completeness: 0.9 })],
    [product({ embeddedAt: 1 }), profile({ completeness: 0.2 })],
    [product({ anyVariantAvailable: false }), null],
    [product({ images: [], embeddedAt: 1 }), profile({ rejectedFields: ["fit"] })],
    [product(), null],
  ];

  let rebuilt = ZERO_COUNTS;
  for (const [p, pr] of catalog) rebuilt = accumulate(rebuilt, p, pr);

  let maintained = ZERO_COUNTS;
  for (const [p, pr] of catalog) {
    maintained = applyDelta(maintained, productDelta(null, p));
    if (pr) maintained = applyDelta(maintained, profileDelta(null, pr));
  }

  assert.deepEqual(maintained, rebuilt);
  assert.equal(rebuilt.productCount, 5);
  assert.equal(rebuilt.embeddedCount, 3);
  assert.equal(rebuilt.enrichedCount, 3);
  assert.equal(rebuilt.lowConfidenceCount, 1);
  assert.equal(rebuilt.rejectedFieldsCount, 1);
  assert.equal(rebuilt.unavailableCount, 1);
  assert.equal(rebuilt.missingImagesCount, 1);
});

test("drift is reported per field, not as a boolean", () => {
  // An operator needs to know WHICH counter was wrong; "something
  // drifted" is not actionable.
  const drift = countsDrift(
    { ...ZERO_COUNTS, productCount: 10, enrichedCount: 4 },
    { ...ZERO_COUNTS, productCount: 10, enrichedCount: 7 },
  );
  assert.equal(drift.length, 1);
  assert.deepEqual(drift[0], { field: "enrichedCount", from: 4, to: 7 });
  assert.deepEqual(countsDrift(ZERO_COUNTS, ZERO_COUNTS), []);
});
