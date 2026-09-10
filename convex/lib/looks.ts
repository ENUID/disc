/**
 * The outfit graph: what a merchant's own styling teaches Disc.
 *
 * A brand's campaign imagery already contains decisions — someone chose
 * that shirt with those trousers and photographed it. Disc could not see
 * those decisions before: it inferred compatibility from product
 * attributes alone, which is a good prior and a poor substitute for
 * knowing that two pieces were deliberately shown together.
 *
 * THE LOAD-BEARING CONSTRAINT, and the reason this file is separate and
 * pure: looks are *additive evidence*. They add a capped bonus on top of
 * a ranker that already works without them. A tenant with no looks gets
 * byte-identical recommendations to the ones they get today.
 *
 * That is not a nicety. If ranking came to depend on approved looks, a
 * brand that installed Disc this morning — zero looks, by definition —
 * would get worse results than one that never opens the Look Builder at
 * all, and the feature would punish exactly the merchants it is meant to
 * win. `convex/looks.itest.ts` asserts the identity directly.
 */

import {
  coerceTerm,
  FORMALITY_MAX,
  GARMENTS,
  OCCASIONS,
  SEASONS,
  slotForGarment,
  STYLES,
  type Slot,
} from "./taxonomy";
import type { FashionProfile } from "./fashion-profile";

/** An unordered product pair, canonicalised so it has exactly one form. */
export type Pair = { a: string; b: string };

/**
 * Order a pair consistently.
 *
 * Without this the same relationship is stored twice — once as (A,B) and
 * once as (B,A) — and every lookup has to try both, or silently counts
 * the pair twice when scoring.
 */
export function orderPair(x: string, y: string): Pair {
  return x <= y ? { a: x, b: y } : { a: y, b: x };
}

export function pairKey(x: string, y: string): string {
  const { a, b } = orderPair(x, y);
  return `${a}|${b}`;
}

/**
 * Every unordered pair in a look.
 *
 * A three-piece look yields three edges, a four-piece yields six. That
 * growth is quadratic, which is fine at outfit scale (a look is rarely
 * more than six pieces) and is why looks are capped rather than
 * unbounded.
 */
export function pairsOf(productIds: string[]): Pair[] {
  const unique = [...new Set(productIds)];
  const pairs: Pair[] = [];
  for (let i = 0; i < unique.length; i++) {
    for (let j = i + 1; j < unique.length; j++) {
      pairs.push(orderPair(unique[i], unique[j]));
    }
  }
  return pairs;
}

/**
 * A read-only view of the tenant's outfit graph, keyed for lookup.
 *
 * Built once per request from an indexed query, then consulted in memory
 * while scoring hundreds of candidate combinations.
 */
export type AffinityGraph = {
  /** pairKey -> how many approved looks contain that pair. */
  weights: ReadonlyMap<string, number>;
  /** Total approved looks, for scaling confidence. */
  lookCount: number;
};

export const EMPTY_AFFINITY: AffinityGraph = {
  weights: new Map(),
  lookCount: 0,
};

export function buildAffinity(
  edges: Array<{ productA: string; productB: string; weight: number }>,
  lookCount: number,
): AffinityGraph {
  const weights = new Map<string, number>();
  for (const edge of edges) {
    weights.set(pairKey(edge.productA, edge.productB), edge.weight);
  }
  return { weights, lookCount };
}

/**
 * The most a look-derived bonus can ever contribute to a final score.
 *
 * Deliberately small. The final score is roughly 0..1, so this moves an
 * outfit by at most six points on a hundred-point scale — enough to
 * break a tie between two otherwise-comparable outfits in favour of the
 * one the brand actually photographed, and not enough to promote an
 * outfit the compatibility engine dislikes.
 *
 * The failure this guards against: a merchant uploads twenty looks from
 * one campaign, every one of them black, and a large bonus turns the
 * entire boutique black for every shopper regardless of what they asked
 * for. Merchant evidence should tilt the ranking, never replace it.
 */
export const MAX_AFFINITY_BONUS = 0.06;

/**
 * How much a candidate outfit is vouched for by the merchant's own looks.
 *
 * Returns 0..1, scaled by what proportion of the outfit's pairs the
 * merchant has actually shown together. An outfit whose every pair
 * appears in an approved look scores 1; one with no known pairs scores
 * 0, which is the overwhelmingly common case and must cost nothing.
 */
export function affinityScore(
  productIds: string[],
  graph: AffinityGraph,
): number {
  if (graph.weights.size === 0 || productIds.length < 2) return 0;

  const pairs = pairsOf(productIds);
  if (pairs.length === 0) return 0;

  let matched = 0;
  for (const pair of pairs) {
    const weight = graph.weights.get(pairKey(pair.a, pair.b)) ?? 0;
    if (weight <= 0) continue;
    // Diminishing returns on repetition: a pair shown in five looks is
    // better evidence than one shown once, but not five times better —
    // otherwise one heavily-repeated hero pairing dominates the graph.
    matched += Math.min(1, Math.log2(1 + weight) / 2);
  }

  return Math.min(1, matched / pairs.length);
}

/**
 * The bonus added to a final outfit score.
 *
 * Separate from `affinityScore` so the scaling decision is visible on
 * its own: this is the function that has to return exactly zero for a
 * tenant with no looks, and it is the one a test pins.
 */
export function affinityBonus(
  productIds: string[],
  graph: AffinityGraph = EMPTY_AFFINITY,
): number {
  const score = affinityScore(productIds, graph);
  if (score <= 0) return 0;

  // Ramp in with library size. Three looks is not yet a signal about a
  // brand's styling; thirty is. Without this, the very first look a
  // merchant uploads would immediately outrank everything else it
  // touches, on evidence of exactly one photograph.
  const confidence = Math.min(1, graph.lookCount / 10);
  return MAX_AFFINITY_BONUS * score * confidence;
}

/**
 * Derive a look's attributes from the products the merchant confirmed.
 *
 * A starting point the merchant edits, not an answer. Everything here is
 * an average or a plurality over the confirmed pieces, which is right
 * often enough to save typing and wrong often enough that the fields
 * must stay editable.
 */
export function deriveLookAttributes(profiles: FashionProfile[]): {
  occasion: string | null;
  style: string | null;
  formality: number | null;
  season: string | null;
} {
  if (profiles.length === 0) {
    return { occasion: null, style: null, formality: null, season: null };
  }

  const formalities = profiles
    .map((p) => p.formality)
    .filter((f): f is number => typeof f === "number");

  return {
    // The occasion the pieces most agree on, by summed weight rather
    // than by count: a piece that is strongly "dinner" should outweigh
    // three that are faintly "everyday".
    occasion: heaviest(profiles.map((p) => p.occasionVector)),
    style: heaviest(profiles.map((p) => p.styleVector)),
    // Mean, not max: an outfit's register is set by the whole, and one
    // formal shoe does not make a look formal.
    formality:
      formalities.length > 0
        ? Math.round(formalities.reduce((s, f) => s + f, 0) / formalities.length)
        : null,
    season: heaviest(profiles.map((p) => p.seasonVector)),
  };
}

/** The highest-weight tag across a set of weighted vectors. */
function heaviest(vectors: Array<Record<string, number>>): string | null {
  const totals = new Map<string, number>();
  for (const vector of vectors) {
    for (const [tag, weight] of Object.entries(vector ?? {})) {
      if (typeof weight !== "number" || !Number.isFinite(weight)) continue;
      totals.set(tag, (totals.get(tag) ?? 0) + weight);
    }
  }

  let best: string | null = null;
  let bestWeight = 0;
  for (const [tag, weight] of totals) {
    // Strictly greater, so ties resolve to the first-seen tag and the
    // same input always produces the same look.
    if (weight > bestWeight) {
      best = tag;
      bestWeight = weight;
    }
  }
  return best;
}

/**
 * One garment the vision model found in a campaign image.
 *
 * Deliberately not a `FashionProfile`: this describes something seen in
 * a photograph, which may not correspond to any product in the catalog
 * at all. Conflating the two is how a detection becomes a false claim
 * about a real product.
 */
export type DetectedGarment = {
  /** What the model called it, verbatim — shown to the merchant. */
  label: string;
  garment: string | null;
  slot: Slot | null;
  colour: string | null;
  /** Free text used to search the catalog for candidates. */
  description: string;
};

/**
 * Parse the vision model's answer into detected garments.
 *
 * Rejects anything outside the vocabulary rather than inventing a
 * category — same contract as product enrichment (§32: "if not visible:
 * unknown"). A detection with no recognised garment still survives, with
 * its label and description intact, because the merchant can still map
 * it by hand and their mapping is what actually counts.
 */
export function parseDetections(raw: unknown): DetectedGarment[] {
  const items = Array.isArray((raw as { garments?: unknown })?.garments)
    ? ((raw as { garments: unknown[] }).garments)
    : Array.isArray(raw)
      ? (raw as unknown[])
      : [];

  const out: DetectedGarment[] = [];
  for (const item of items.slice(0, 12)) {
    if (!item || typeof item !== "object") continue;
    const g = item as Record<string, unknown>;

    const label = typeof g.label === "string" ? g.label.slice(0, 80) : "";
    const description = typeof g.description === "string"
      ? g.description.slice(0, 300)
      : label;
    if (!label && !description) continue;

    const garment = coerceTerm(GARMENTS, g.garment);

    out.push({
      label: label || description.slice(0, 80),
      garment,
      slot: garment ? slotForGarment(garment) : null,
      colour: typeof g.colour === "string" ? g.colour.slice(0, 40) : null,
      description,
    });
  }
  return out;
}

/** Validate merchant-supplied look attributes against the closed vocabulary. */
export function sanitiseLookAttributes(raw: {
  occasion?: unknown;
  style?: unknown;
  formality?: unknown;
  season?: unknown;
  notes?: unknown;
}) {
  const formality =
    typeof raw.formality === "number" && Number.isFinite(raw.formality)
      ? Math.min(FORMALITY_MAX, Math.max(0, Math.round(raw.formality)))
      : undefined;

  return {
    occasion: coerceTerm(OCCASIONS, raw.occasion) ?? undefined,
    style: coerceTerm(STYLES, raw.style) ?? undefined,
    season: coerceTerm(SEASONS, raw.season) ?? undefined,
    formality,
    notes: typeof raw.notes === "string" ? raw.notes.slice(0, 500) : undefined,
  };
}
