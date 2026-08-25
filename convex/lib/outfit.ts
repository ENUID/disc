/**
 * Outfit assembly, ranking and diversity (spec §46, §47, §55-§59).
 *
 * The problem this exists to solve, from §46: 30 tops × 30 bottoms × 20
 * shoes is 18,000 combinations. Sending those to a model is impossible
 * and pointless. The funnel is:
 *
 *   18,000 → 3,000 → 500 → 100 → 20 → 5
 *
 * achieved by applying the cheap, certain filters first (hard
 * constraints) and the expensive, uncertain ones last (judge). Every
 * threshold here is a parameter, because §46 says "Thresholds
 * configurable" and because the right values depend on catalog size.
 */

import { affinityBonus, EMPTY_AFFINITY, type AffinityGraph } from "./looks";
import {
  brandCoherence,
  CompatibilityWeights,
  DEFAULT_WEIGHTS,
  NEUTRAL_SCORE,
  scoreOutfit,
  type OutfitScore,
} from "./compatibility";
import { FashionProfile } from "./fashion-profile";
import { Intent } from "./intent";
import { slotForGarment, type Slot } from "./taxonomy";

/** A product plus everything needed to reason about it. */
export type Candidate = {
  productId: string;
  title: string;
  price: number;
  currency: string;
  available: boolean;
  profile: FashionProfile;
  slot: Slot | null;
  /** Retrieval score, carried through so ranking can use relevance too. */
  relevance: number;
  /** Merchant merchandising signal, 0-1. Never overrides shopper needs. */
  boost?: number;
};

export type Outfit = {
  slots: Partial<Record<Slot, string>>;
  pieces: Candidate[];
  direction: string;
  scores: {
    compatibility: number;
    brand: number;
    shopperFit: number;
    relevance: number;
    /** Contribution from the merchant's own approved looks. 0 for most tenants. */
    affinity: number;
    final: number;
  };
  detail: OutfitScore;
  issues: string[];
  confidence: number;
};

export type FunnelLimits = {
  perSlot: number;
  combinations: number;
  ranked: number;
  judged: number;
  final: number;
};

export const DEFAULT_LIMITS: FunnelLimits = {
  perSlot: 12,
  combinations: 500,
  ranked: 100,
  judged: 20,
  final: 5,
};

/**
 * Hard constraints (spec §47).
 *
 * "A hard conflict should reject a candidate." These are certainties,
 * not preferences: an unavailable product cannot be bought, an
 * over-budget one violates something the shopper said out loud. Applied
 * first because they are the cheapest way to shrink the funnel and the
 * only filters that are never a judgement call.
 */
export function passesHardConstraints(candidate: Candidate, intent: Intent): boolean {
  // Spec §47: availability. The prototype stored this and never used it.
  if (!candidate.available) return false;

  // A strict budget is a statement, not a preference.
  if (intent.budget && candidate.price > intent.budget.amount) return false;

  // An explicitly banned attribute.
  if (candidate.profile.fit && intent.fitNegative.includes(candidate.profile.fit)) {
    return false;
  }

  // A negated style the shopper named.
  for (const banned of intent.styleNegative) {
    if ((candidate.profile.styleVector[banned] ?? 0) >= 0.5) return false;
  }

  // A large formality gap against an EXPLICIT request.
  //
  // Formality is a soft signal in general (§48) and stays one for gaps of
  // one or two steps — real outfits mix registers slightly, and a
  // penalty is the right instrument there. But §47 says a *hard
  // conflict* should reject a candidate, and three steps is a hard
  // conflict: a formality-5 derby in a "relaxed weekend outfit" is not a
  // bolder alternative, it is wrong.
  //
  // Gated on the shopper having actually stated a level. Inferring one
  // and then filtering on it would reject products over a guess.
  if (intent.formality !== null && candidate.profile.formality !== null) {
    if (Math.abs(intent.formality - candidate.profile.formality) >= 3) return false;
  }

  return true;
}

/**
 * How well one product matches what the shopper asked for, independent
 * of what it is paired with (spec §48's soft signals).
 */
export function shopperFit(candidate: Candidate, intent: Intent): number {
  const signals: number[] = [];

  if (intent.formality !== null && candidate.profile.formality !== null) {
    const gap = Math.abs(intent.formality - candidate.profile.formality);
    signals.push(Math.max(0, 1 - gap / 3));
  }

  if (intent.stylePositive.length > 0) {
    const matched = intent.stylePositive.map((s) => candidate.profile.styleVector[s] ?? 0);
    signals.push(Math.max(...matched));
  }

  if (intent.occasion && Object.keys(candidate.profile.occasionVector).length > 0) {
    signals.push(candidate.profile.occasionVector[intent.occasion] ?? 0.2);
  }

  if (intent.colors.length > 0 && candidate.profile.colorFamily) {
    signals.push(intent.colors.includes(candidate.profile.colorFamily) ? 1 : 0.35);
  }

  // Nothing to judge on means neutral, not zero — the shopper simply
  // did not constrain this dimension.
  if (signals.length === 0) return NEUTRAL_SCORE;
  return signals.reduce((sum, s) => sum + s, 0) / signals.length;
}

/**
 * Group candidates by slot and keep the best few of each.
 *
 * This is the 18,000 → 3,000 step: cutting each slot to its strongest
 * options before any combination is formed, since a weak top cannot
 * become a good outfit by being paired well.
 */
export function bucketBySlot(
  candidates: Candidate[],
  intent: Intent,
  limits: FunnelLimits = DEFAULT_LIMITS,
): Map<Slot, Candidate[]> {
  const buckets = new Map<Slot, Candidate[]>();

  for (const candidate of candidates) {
    const slot = candidate.slot ?? slotForGarment(candidate.profile.garment);
    if (!slot) continue;
    if (!passesHardConstraints(candidate, intent)) continue;
    const bucket = buckets.get(slot) ?? [];
    bucket.push(candidate);
    buckets.set(slot, bucket);
  }

  for (const [slot, bucket] of buckets) {
    bucket.sort(
      (a, b) =>
        shopperFit(b, intent) + b.relevance - (shopperFit(a, intent) + a.relevance),
    );
    buckets.set(slot, bucket.slice(0, limits.perSlot));
  }

  return buckets;
}

/**
 * Which slots an outfit needs.
 *
 * A one-piece (dress, jumpsuit, suit) replaces top and bottom rather
 * than joining them — pairing a dress with trousers is a category error,
 * not a taste call.
 */
export function requiredSlots(buckets: Map<Slot, Candidate[]>): Slot[][] {
  const plans: Slot[][] = [];

  const hasTop = (buckets.get("top")?.length ?? 0) > 0;
  const hasBottom = (buckets.get("bottom")?.length ?? 0) > 0;
  const hasFootwear = (buckets.get("footwear")?.length ?? 0) > 0;
  const hasOnepiece = (buckets.get("onepiece")?.length ?? 0) > 0;

  if (hasTop && hasBottom) {
    plans.push(hasFootwear ? ["top", "bottom", "footwear"] : ["top", "bottom"]);
  }
  if (hasOnepiece) {
    plans.push(hasFootwear ? ["onepiece", "footwear"] : ["onepiece"]);
  }
  // Nothing complete available — offer the best pairing we can rather
  // than nothing at all.
  if (plans.length === 0) {
    const populated = [...buckets.keys()].filter((s) => (buckets.get(s)?.length ?? 0) > 0);
    if (populated.length >= 2) plans.push(populated.slice(0, 3));
  }
  return plans;
}

/**
 * Generate combinations, bounded.
 *
 * The cartesian product is capped rather than fully enumerated: with
 * `perSlot` at 12 across three slots that is 1,728, and the cap keeps a
 * larger catalog from exploding. Buckets are pre-sorted by strength, so
 * truncation drops the weakest options rather than an arbitrary subset.
 */
export function generateCombinations(
  buckets: Map<Slot, Candidate[]>,
  plan: Slot[],
  limit: number,
): Candidate[][] {
  let combos: Candidate[][] = [[]];

  for (const slot of plan) {
    const options = buckets.get(slot) ?? [];
    if (options.length === 0) continue;

    const next: Candidate[][] = [];
    for (const combo of combos) {
      for (const option of options) {
        next.push([...combo, option]);
        if (next.length >= limit) break;
      }
      if (next.length >= limit) break;
    }
    combos = next;
  }

  return combos.filter((c) => c.length >= 2);
}

/**
 * Rank assembled outfits (spec §55's hierarchy).
 *
 *   shopper hard constraint
 *     > product validity
 *       > brand coherence
 *         > fashion quality
 *           > merchandising boost
 *
 * Hard constraints already removed candidates upstream. What remains is
 * expressed as weights, with merchandising deliberately the smallest
 * term: §55 is explicit that "Merchandising cannot override explicit
 * shopper needs."
 */
export function rankOutfits(
  combinations: Candidate[][],
  intent: Intent,
  brandStyleVector: Record<string, number> | null,
  weights: CompatibilityWeights = DEFAULT_WEIGHTS,
  /**
   * The merchant's own outfit graph, from approved looks.
   *
   * Defaulted, and the default is empty. That default IS the cold-start
   * guarantee: a tenant with no looks — every tenant on day one — gets
   * a zero bonus and therefore byte-identical output to before this
   * parameter existed. `looks.itest.ts` asserts that identity rather
   * than trusting this comment.
   */
  affinity: AffinityGraph = EMPTY_AFFINITY,
): Outfit[] {
  const outfits: Outfit[] = [];

  for (const pieces of combinations) {
    const profiles = pieces.map((p) => p.profile);
    const detail = scoreOutfit(profiles, weights);
    const brand = brandCoherence(profiles, brandStyleVector);
    const fit = pieces.reduce((sum, p) => sum + shopperFit(p, intent), 0) / pieces.length;
    const relevance = pieces.reduce((sum, p) => sum + p.relevance, 0) / pieces.length;
    const boost = pieces.reduce((sum, p) => sum + (p.boost ?? 0), 0) / pieces.length;

    // Added ON TOP of the weighted sum, never folded into it. Adding a
    // sixth term inside would renormalise the other five and shift every
    // existing result — including the evaluation baseline — for every
    // tenant, whether or not they have ever uploaded a look.
    const affinityPart = affinityBonus(
      pieces.map((p) => p.productId),
      affinity,
    );

    const final =
      fit * 0.34 + brand * 0.24 + detail.total * 0.28 + relevance * 0.1 + boost * 0.04 +
      affinityPart;

    const slots: Partial<Record<Slot, string>> = {};
    for (const piece of pieces) {
      const slot = piece.slot ?? slotForGarment(piece.profile.garment);
      if (slot) slots[slot] = piece.productId;
    }

    outfits.push({
      slots,
      pieces,
      direction: describeDirection(profiles),
      scores: {
        compatibility: round(detail.total),
        brand: round(brand),
        shopperFit: round(fit),
        relevance: round(relevance),
        // Surfaced so a trace can show that a merchant's own styling
        // moved this outfit, rather than the bonus being invisible.
        affinity: round(affinityPart),
        final: round(final),
      },
      detail,
      issues: detail.issues,
      confidence: round(confidenceOf(profiles, detail)),
    });
  }

  outfits.sort((a, b) => b.scores.final - a.scores.final);
  return outfits;
}

/**
 * Confidence (spec §97: "If confidence is low... Be honest").
 *
 * Driven by how much was actually *known* about the pieces, not by how
 * good the score is. An outfit assembled from three barely-enriched
 * products can score well by accident, and saying so is the honest
 * answer.
 */
function confidenceOf(profiles: FashionProfile[], detail: OutfitScore): number {
  const known = profiles.map((p) => {
    const fields = [p.garment, p.colorFamily, p.formality, p.fit];
    return fields.filter((f) => f !== null).length / fields.length;
  });
  const coverage = known.reduce((sum, k) => sum + k, 0) / known.length;
  // A well-understood outfit that scores badly is a confident negative;
  // confidence is about the evidence, not the verdict.
  return coverage * 0.8 + (detail.issues.length === 0 ? 0.2 : 0.1);
}

/** A short human label for the outfit's character. */
function describeDirection(profiles: FashionProfile[]): string {
  const formalities = profiles
    .map((p) => p.formality)
    .filter((f): f is number => f !== null);
  const styles: Record<string, number> = {};
  for (const profile of profiles) {
    for (const [style, weight] of Object.entries(profile.styleVector)) {
      styles[style] = (styles[style] ?? 0) + weight;
    }
  }
  const topStyle = Object.entries(styles).sort((a, b) => b[1] - a[1])[0]?.[0];

  if (formalities.length === 0 && !topStyle) return "A considered pairing";

  const mean = formalities.length
    ? formalities.reduce((s, f) => s + f, 0) / formalities.length
    : 2;
  const register =
    mean <= 1 ? "Relaxed" : mean <= 2.5 ? "Easy" : mean <= 3.5 ? "Polished" : "Formal";

  return topStyle ? `${register}, ${topStyle.replace(/_/g, " ")}` : register;
}

/**
 * Diversity (spec §59).
 *
 * "Return 3-5 strong alternatives. Not 20 mediocre products." The
 * failure this prevents is five outfits that differ by one accessory —
 * technically five options, actually one. Greedy selection: take the
 * best, then repeatedly take the best remaining that is meaningfully
 * different from everything already chosen.
 */
export function selectDiverse(outfits: Outfit[], count: number): Outfit[] {
  if (outfits.length <= count) return outfits;

  const chosen: Outfit[] = [];
  const remaining = [...outfits];

  while (chosen.length < count && remaining.length > 0) {
    let bestIndex = 0;
    let bestValue = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const novelty =
        chosen.length === 0
          ? 1
          : Math.min(...chosen.map((c) => distance(c, candidate)));
      // Quality still leads; novelty breaks ties and prevents near-
      // duplicates from filling the list.
      const value = candidate.scores.final * 0.7 + novelty * 0.3;
      if (value > bestValue) {
        bestValue = value;
        bestIndex = i;
      }
    }

    chosen.push(remaining[bestIndex]);
    remaining.splice(bestIndex, 1);
  }

  return chosen;
}

/**
 * How different two outfits are, 0-1, across the dimensions §59 names:
 * shared pieces, palette, formality, style direction.
 */
export function distance(a: Outfit, b: Outfit): number {
  const idsA = new Set(a.pieces.map((p) => p.productId));
  const idsB = new Set(b.pieces.map((p) => p.productId));
  const shared = [...idsA].filter((id) => idsB.has(id)).length;
  const union = new Set([...idsA, ...idsB]).size;
  const pieceDistance = union === 0 ? 0 : 1 - shared / union;

  const familiesA = new Set(
    a.pieces.map((p) => p.profile.colorFamily).filter(Boolean) as string[],
  );
  const familiesB = new Set(
    b.pieces.map((p) => p.profile.colorFamily).filter(Boolean) as string[],
  );
  const sharedFamilies = [...familiesA].filter((f) => familiesB.has(f)).length;
  const familyUnion = new Set([...familiesA, ...familiesB]).size;
  const paletteDistance = familyUnion === 0 ? 0.5 : 1 - sharedFamilies / familyUnion;

  const directionDistance = a.direction === b.direction ? 0 : 1;

  return pieceDistance * 0.55 + paletteDistance * 0.3 + directionDistance * 0.15;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * The whole funnel, deterministic end to end.
 *
 * Everything up to the judge runs without a single model call, which is
 * what makes §46's numbers affordable — the model only ever sees the
 * final handful.
 */
export function buildOutfits(
  candidates: Candidate[],
  intent: Intent,
  brandStyleVector: Record<string, number> | null,
  limits: FunnelLimits = DEFAULT_LIMITS,
  weights: CompatibilityWeights = DEFAULT_WEIGHTS,
  /** Merchant-approved looks. Empty by default — see rankOutfits. */
  affinity: AffinityGraph = EMPTY_AFFINITY,
): { outfits: Outfit[]; funnel: Record<string, number> } {
  const buckets = bucketBySlot(candidates, intent, limits);
  const plans = requiredSlots(buckets);

  let combinations: Candidate[][] = [];
  for (const plan of plans) {
    combinations = combinations.concat(
      generateCombinations(buckets, plan, limits.combinations),
    );
  }
  combinations = combinations.slice(0, limits.combinations);

  const ranked = rankOutfits(
    combinations,
    intent,
    brandStyleVector,
    weights,
    affinity,
  ).slice(0, limits.ranked);
  const shortlist = ranked.slice(0, limits.judged);
  const diverse = selectDiverse(shortlist, limits.final);

  return {
    outfits: diverse,
    funnel: {
      candidates: candidates.length,
      afterHardConstraints: [...buckets.values()].reduce((s, b) => s + b.length, 0),
      combinations: combinations.length,
      ranked: ranked.length,
      shortlisted: shortlist.length,
      final: diverse.length,
    },
  };
}
