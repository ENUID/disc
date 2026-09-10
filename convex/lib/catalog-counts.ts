/**
 * Catalog health aggregates (P1.6) — the pure half.
 *
 * THE FAILURE THIS EXISTS TO REMOVE. `catalogHealth` computed eight
 * numbers by `.collect()`-ing every product, every profile and every
 * embedding for a tenant. The third is the fatal one: an embedding row
 * carries 1,536 float64 values, roughly 12 KB, so a 5,000-product
 * catalog meant reading ~60 MB to produce a count — past Convex's
 * per-query read limit, and therefore broken for exactly the merchants
 * paying the most, presenting as a dashboard error with no hint that
 * catalog size was the cause.
 *
 * The rule that replaces it: **no query whose output is a number may
 * read a vector.**
 *
 * These are the predicates and the arithmetic. They are pure so the
 * definition of each metric lives in one place and can be exhausted by
 * tests — and, more importantly, so the *maintained counter* and the
 * *reconciliation rebuild* are guaranteed to agree, because both call
 * these same functions rather than each re-implementing "what counts as
 * low confidence".
 */

/** The eight numbers `catalogHealth` reports, as maintained counters. */
export type CatalogCounts = {
  productCount: number;
  unavailableCount: number;
  missingImagesCount: number;
  embeddedCount: number;
  enrichedCount: number;
  lowConfidenceCount: number;
  rejectedFieldsCount: number;
};

export const ZERO_COUNTS: CatalogCounts = {
  productCount: 0,
  unavailableCount: 0,
  missingImagesCount: 0,
  embeddedCount: 0,
  enrichedCount: 0,
  lowConfidenceCount: 0,
  rejectedFieldsCount: 0,
};

export const COUNT_FIELDS = Object.keys(ZERO_COUNTS) as Array<keyof CatalogCounts>;

/**
 * Below half the attributes established.
 *
 * Disc will score most dimensions neutral for such a product, which is
 * worth surfacing rather than hiding behind an "enriched" tick — the
 * reason `lowConfidence` is reported separately from `enriched` at all.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.5;

/** The product-shaped facts the counters derive from. */
export type CountableProduct = {
  anyVariantAvailable: boolean;
  images: string[];
  embeddedAt?: number;
};

/** The profile-shaped facts the counters derive from. */
export type CountableProfile = {
  completeness: number;
  rejectedFields?: string[];
};

export function isUnavailable(product: CountableProduct): boolean {
  return !product.anyVariantAvailable;
}

export function hasNoImages(product: CountableProduct): boolean {
  return product.images.length === 0;
}

export function isEmbedded(product: CountableProduct): boolean {
  // Read from the PRODUCT, never from the embeddings table. This is the
  // whole point: `embeddedAt` is a marker on a small row, so both the
  // live counter and the reconciliation rebuild can establish "is this
  // product indexed" without materialising a 12 KB vector.
  return product.embeddedAt !== undefined;
}

export function isLowConfidence(profile: CountableProfile): boolean {
  return profile.completeness < LOW_CONFIDENCE_THRESHOLD;
}

export function hasRejectedFields(profile: CountableProfile): boolean {
  return (profile.rejectedFields?.length ?? 0) > 0;
}

/** A signed change to apply to the maintained counters. */
export type CountDelta = Partial<Record<keyof CatalogCounts, number>>;

/** `+1` when a predicate becomes true, `-1` when it stops being true. */
function step(before: boolean, after: boolean): number {
  if (before === after) return 0;
  return after ? 1 : -1;
}

/**
 * A product appearing, changing or disappearing.
 *
 * `before`/`after` are the product's state; `null` means it did not
 * exist. Expressing every lifecycle event as one transition function is
 * what makes retries safe: re-running a mutation that has already been
 * applied produces `before === after` and therefore a zero delta, rather
 * than a second increment.
 */
export function productDelta(
  before: CountableProduct | null,
  after: CountableProduct | null,
): CountDelta {
  const existedBefore = before !== null;
  const existsAfter = after !== null;

  return {
    productCount: step(existedBefore, existsAfter),
    unavailableCount: step(
      existedBefore && isUnavailable(before!),
      existsAfter && isUnavailable(after!),
    ),
    missingImagesCount: step(
      existedBefore && hasNoImages(before!),
      existsAfter && hasNoImages(after!),
    ),
    embeddedCount: step(
      existedBefore && isEmbedded(before!),
      existsAfter && isEmbedded(after!),
    ),
  };
}

/**
 * A profile appearing, being replaced, or disappearing.
 *
 * Replacement is the case worth being careful about: `enrichedCount` is
 * unchanged because the product was already enriched, but `completeness`
 * can cross the threshold in either direction and `rejectedFields` can
 * appear or clear. Treating replacement as "no change" would let those
 * two counters drift on every re-enrichment.
 */
export function profileDelta(
  before: CountableProfile | null,
  after: CountableProfile | null,
): CountDelta {
  const existedBefore = before !== null;
  const existsAfter = after !== null;

  return {
    enrichedCount: step(existedBefore, existsAfter),
    lowConfidenceCount: step(
      existedBefore && isLowConfidence(before!),
      existsAfter && isLowConfidence(after!),
    ),
    rejectedFieldsCount: step(
      existedBefore && hasRejectedFields(before!),
      existsAfter && hasRejectedFields(after!),
    ),
  };
}

/**
 * Apply a delta, clamped at zero.
 *
 * A negative count is never correct and would be visibly wrong on a
 * merchant's dashboard, so it is clamped. The clamp does NOT make drift
 * acceptable — it hides the sign of it — which is why reconciliation
 * exists and why it rebuilds from authoritative state rather than
 * trusting the running total.
 */
export function applyDelta(counts: CatalogCounts, delta: CountDelta): CatalogCounts {
  const next = { ...counts };
  for (const field of COUNT_FIELDS) {
    const change = delta[field];
    if (change) next[field] = Math.max(0, next[field] + change);
  }
  return next;
}

/**
 * Combine deltas.
 *
 * Lets a mutation touching many rows accumulate one delta and write the
 * tenant row once, instead of patching it per row — which on a page of
 * a large sync would be fifty writes to one document to record a number
 * that only has to be right when the mutation commits.
 */
export function mergeDelta(a: CountDelta, b: CountDelta): CountDelta {
  const out: CountDelta = { ...a };
  for (const field of COUNT_FIELDS) {
    const change = b[field];
    if (change) out[field] = (out[field] ?? 0) + change;
  }
  return out;
}

/** True when a delta would change nothing — the retry case. */
export function isNoOpDelta(delta: CountDelta): boolean {
  return COUNT_FIELDS.every((field) => !delta[field]);
}

/**
 * Fold one product and its profile into a running total.
 *
 * Used by reconciliation, which walks products — never embeddings, and
 * never profiles independently. Driving off products is what keeps the
 * rebuild consistent with `catalogHealth`'s own semantics: a profile
 * whose product has been deleted is not "enriched", it is an orphan.
 */
export function accumulate(
  counts: CatalogCounts,
  product: CountableProduct,
  profile: CountableProfile | null,
): CatalogCounts {
  return {
    productCount: counts.productCount + 1,
    unavailableCount: counts.unavailableCount + (isUnavailable(product) ? 1 : 0),
    missingImagesCount: counts.missingImagesCount + (hasNoImages(product) ? 1 : 0),
    embeddedCount: counts.embeddedCount + (isEmbedded(product) ? 1 : 0),
    enrichedCount: counts.enrichedCount + (profile ? 1 : 0),
    lowConfidenceCount:
      counts.lowConfidenceCount + (profile && isLowConfidence(profile) ? 1 : 0),
    rejectedFieldsCount:
      counts.rejectedFieldsCount + (profile && hasRejectedFields(profile) ? 1 : 0),
  };
}

/** Read counters off a tenant row, treating absent as zero. */
export function countsFrom(row: Partial<CatalogCounts>): CatalogCounts {
  const out = { ...ZERO_COUNTS };
  for (const field of COUNT_FIELDS) out[field] = row[field] ?? 0;
  return out;
}

/** Fields that differ between two count sets. Used to report drift. */
export function countsDrift(
  a: CatalogCounts,
  b: CatalogCounts,
): Array<{ field: keyof CatalogCounts; from: number; to: number }> {
  return COUNT_FIELDS.filter((field) => a[field] !== b[field]).map((field) => ({
    field,
    from: a[field],
    to: b[field],
  }));
}
