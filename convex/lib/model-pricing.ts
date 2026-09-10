/**
 * What a model call costs.
 *
 * The rates below are configuration, not truth. Published prices move,
 * they differ by region and commitment, and this file will be out of
 * date at some point without anyone noticing. That is survivable
 * *because of how the data is stored*: `modelUsage` keeps raw input and
 * output token counts, and cost is derived from them. A wrong rate is
 * fixed by editing a constant and recomputing history. A missing token
 * count is gone forever.
 *
 * So: never store only the dollar figure, and never let a caller pass a
 * pre-computed cost in.
 *
 * Rates are per 1,000,000 tokens, in USD, and overridable per deployment
 * via DISC_MODEL_PRICES without a code change — which is what lets a
 * negotiated rate be applied without redeploying.
 */

export type ModelRate = {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M output tokens. */
  output: number;
};

/**
 * Published list rates at the time of writing.
 *
 * Deliberately conservative where uncertain: over-estimating our own
 * cost produces cautious pricing, under-estimating produces a margin
 * that quietly is not there.
 */
export const MODEL_PRICES: Record<string, ModelRate> = {
  // Anthropic — reasoning and vision.
  "claude-opus-4-5": { input: 5, output: 25 },
  "claude-sonnet-4-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },

  // OpenAI — embeddings. Output tokens do not apply.
  "text-embedding-3-small": { input: 0.02, output: 0 },
  "text-embedding-3-large": { input: 0.13, output: 0 },

  // The stand-in used in tests and on a deployment with no key. Free,
  // because it never leaves the process.
  "null-provider": { input: 0, output: 0 },
};

/**
 * What an unknown model costs.
 *
 * Not zero. A model that is not in the table is one someone pointed a
 * deployment at without updating this file, and pricing it at zero means
 * its spend silently vanishes from every economics report — the exact
 * failure this whole module exists to prevent. Priced at the most
 * expensive thing we know about, so an unpriced model shows up as an
 * alarming number rather than as nothing.
 */
export const UNKNOWN_MODEL_RATE: ModelRate = { input: 5, output: 25 };

/**
 * Per-deployment overrides, as JSON:
 *   {"claude-sonnet-4-5": {"input": 2.4, "output": 12}}
 *
 * Parsed defensively: a malformed override must not take down every
 * model call in the deployment, so it degrades to the built-in table
 * and complains once.
 */
let overridesCache: Record<string, ModelRate> | null = null;

function overrides(): Record<string, ModelRate> {
  if (overridesCache) return overridesCache;

  const raw = process.env.DISC_MODEL_PRICES;
  if (!raw) return (overridesCache = {});

  try {
    const parsed = JSON.parse(raw);
    const out: Record<string, ModelRate> = {};
    for (const [model, rate] of Object.entries(parsed as Record<string, unknown>)) {
      const r = rate as { input?: unknown; output?: unknown };
      if (typeof r?.input === "number" && typeof r?.output === "number") {
        out[model] = { input: r.input, output: r.output };
      }
    }
    return (overridesCache = out);
  } catch {
    console.warn("DISC_MODEL_PRICES is not valid JSON; using built-in rates");
    return (overridesCache = {});
  }
}

/** Test seam. Env is read once and cached, so a test needs to clear it. */
export function resetPriceCache(): void {
  overridesCache = null;
}

export function rateFor(model: string): ModelRate {
  return overrides()[model] ?? MODEL_PRICES[model] ?? UNKNOWN_MODEL_RATE;
}

/** Whether this model is priced, or falling back to the unknown rate. */
export function isPriced(model: string): boolean {
  return model in overrides() || model in MODEL_PRICES;
}

/**
 * Cost of one call, in USD.
 *
 * Returned as a full-precision float rather than rounded to cents: a
 * single call costs small fractions of a cent, and rounding here would
 * floor almost every call to zero and report a monthly bill of nothing.
 * Rounding belongs at the point of display, never at the point of
 * accumulation.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const rate = rateFor(model);
  return (
    (Math.max(0, inputTokens) / 1_000_000) * rate.input +
    (Math.max(0, outputTokens) / 1_000_000) * rate.output
  );
}

/** Format for a human. Small numbers need more places than money usually does. */
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.01) return `$${amount.toFixed(5)}`;
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/**
 * The operations whose spend is tracked separately.
 *
 * A closed set, so a typo becomes a new bucket nobody looks at rather
 * than silently merging with a real one. These are the units the
 * economics report breaks cost down by, and they are chosen to answer
 * one question: which part of a shopper's session costs money?
 */
export const OPERATIONS = [
  /** Per shopper request — parsing what they asked for. */
  "intent",
  /** Per shopper request — the outfit judge. The expensive one. */
  "judge",
  /** Per shopper request — the one-line "why this works". */
  "explanation",
  /** Per shopper request — refining an existing session's state. */
  "refine",
  /** Per catalog change — reading a product's attributes. */
  "enrichment",
  /** Per catalog change — looking at product photography. */
  "vision",
  /** Per catalog change — embedding a product's text. One-time per product. */
  "embedding",
  /**
   * Per shopper query — embedding what they typed.
   *
   * Split from catalog embedding deliberately. `/search` calls no
   * reasoning model at all, which makes it easy to describe as free —
   * it is not. It embeds the query, every time, and that is the one
   * cost that scales with search traffic rather than catalog size.
   * Merged into "embedding" it would be invisible underneath ingestion.
   */
  "query_embedding",
  /** Per catalog rebuild — deriving the Brand Brain. */
  "brand",
] as const;

export type Operation = (typeof OPERATIONS)[number];

/**
 * Which operations are driven by shopper traffic rather than by catalog
 * size.
 *
 * This split is the whole point of the exercise. Catalog-driven spend is
 * a one-time cost per product that a catalog-size price tier covers
 * correctly. Shopper-driven spend scales with traffic, is not covered by
 * a catalog-size tier at all, and is what makes a flat unlimited price
 * dangerous.
 */
export const SHOPPER_DRIVEN: ReadonlySet<string> = new Set([
  "intent",
  "judge",
  "explanation",
  "refine",
  "query_embedding",
]);

export function isShopperDriven(operation: string): boolean {
  return SHOPPER_DRIVEN.has(operation);
}
