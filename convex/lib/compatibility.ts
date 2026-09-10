/**
 * Compatibility engine (spec §45, §48-§55).
 *
 * Spec §45 forbids collapsing four distinct questions into one:
 *
 *   Retrieval      Could this be relevant?
 *   Compatibility  Do these pieces actually work together?
 *   Ranking        Which valid options are strongest for this shopper?
 *   Judge          Is the final recommendation actually coherent?
 *
 * This file answers only the second. Retrieval happens before it
 * (`search.ts`), ranking and judging after it (`outfit.ts`). Keeping
 * them apart is what makes a bad result diagnosable: an outfit can be
 * compatible but badly ranked, or well ranked but incoherent, and those
 * are different bugs with different fixes.
 *
 * Two rules run through everything here:
 *
 *   1. Unknown scores 0.5, never 0. An unenriched product must not rank
 *      below a genuinely bad one, and missing data must not fake quality.
 *   2. Weights are configurable, not constants baked into the maths.
 *      §49: "Do not assume one universal static set of weights forever.
 *      Start configurable. Learn later from outcomes."
 */

import { colorPoint, colorScore, paletteScore, type ColorRelationship } from "./color";
import { FashionProfile } from "./fashion-profile";
import { FORMALITY_MAX, slotForGarment, type Slot } from "./taxonomy";

export const NEUTRAL_SCORE = 0.5;

export type CompatibilityWeights = {
  color: number;
  silhouette: number;
  formality: number;
  style: number;
  weight: number;
  pattern: number;
  occasion: number;
};

/**
 * Starting weights. Formality and colour lead because they are what a
 * shopper notices first when an outfit is wrong; pattern is lowest
 * because most catalog products are plain and it rarely discriminates.
 */
export const DEFAULT_WEIGHTS: CompatibilityWeights = {
  color: 1.0,
  silhouette: 0.9,
  formality: 1.0,
  style: 0.8,
  weight: 0.5,
  pattern: 0.6,
  occasion: 0.7,
};

export type PairScore = {
  total: number;
  components: Record<keyof CompatibilityWeights, number>;
  /** Things that work, for the explanation. */
  notes: string[];
  /** Things that are wrong, judged per dimension. */
  issues: string[];
  colorRelationship: ColorRelationship;
};

/**
 * Formality gap (spec §52).
 *
 * The point of a 0-5 scale rather than labels is that the *size* of the
 * gap matters: trainers with a dinner jacket is a gap of 4 and should
 * score far worse than loafers with chinos, a gap of 1. A gap of 1 is
 * normal and barely penalised — real outfits mix registers slightly.
 */
export function formalityScore(a: number | null, b: number | null): number {
  if (a === null || b === null) return NEUTRAL_SCORE;
  const gap = Math.abs(a - b);
  if (gap <= 1) return 1 - gap * 0.05;
  // Superlinear beyond one step, so a 4-point gap is not merely twice as
  // bad as a 2-point one — it is a different kind of wrong. Tuned so a
  // 3-step gap (trainers with a suit) lands below 0.5 and therefore
  // registers as an issue rather than a mild note; an earlier curve left
  // it at 0.61, which was too forgiving to surface at all.
  const normalised = (gap - 1) / (FORMALITY_MAX - 1);
  return Math.max(0, 0.95 - Math.pow(normalised, 1.2) * 1.05);
}

/**
 * Silhouette pairing (spec §51).
 *
 * The principle real styling runs on is balance: volume on top wants
 * restraint below, and vice versa. Two oversized pieces read as
 * shapeless; two very fitted pieces read as severe. This scores the
 * *relationship*, not either piece alone.
 */
const VOLUME_RANK: Record<string, number> = {
  skinny: 0, slim: 1, tailored: 1, cropped: 2, regular: 2,
  relaxed: 3, wide: 4, oversized: 4,
};

export function silhouetteScore(
  a: FashionProfile,
  b: FashionProfile,
): { score: number; note: string } {
  const rankA = a.fit ? VOLUME_RANK[a.fit] : undefined;
  const rankB = b.fit ? VOLUME_RANK[b.fit] : undefined;

  if (rankA === undefined || rankB === undefined) {
    return { score: NEUTRAL_SCORE, note: "fit not established" };
  }

  const spread = Math.abs(rankA - rankB);

  // Both extremes at once.
  if (rankA >= 3 && rankB >= 3) {
    return { score: 0.35, note: "volume on both halves reads shapeless" };
  }
  if (rankA <= 1 && rankB <= 1) {
    return { score: 0.55, note: "close-cut throughout — deliberate but severe" };
  }
  // One relaxed, one clean: the classic balance.
  if (spread >= 2) {
    return { score: 0.92, note: "volume balanced against a cleaner line" };
  }
  if (spread === 1) return { score: 0.82, note: "proportions sit comfortably" };
  return { score: 0.7, note: "similar proportions" };
}

/**
 * Style overlap (spec §53).
 *
 * Cosine similarity over the weighted style vectors, so partial overlap
 * counts — §53's whole point is that a piece can be 0.8 minimal and 0.2
 * classic, and comparing single labels would throw that away.
 */
export function styleScore(a: FashionProfile, b: FashionProfile): number {
  const keys = new Set([...Object.keys(a.styleVector), ...Object.keys(b.styleVector)]);
  if (keys.size === 0) return NEUTRAL_SCORE;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const key of keys) {
    const x = a.styleVector[key] ?? 0;
    const y = b.styleVector[key] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return NEUTRAL_SCORE;

  const cosine = dot / (Math.sqrt(magA) * Math.sqrt(magB));
  // Rescaled: total style disagreement is bad but not disqualifying,
  // since a deliberate contrast is a legitimate styling move.
  return 0.25 + cosine * 0.75;
}

/** Fabric weight (spec §49's material/weight term). */
const WEIGHT_RANK: Record<string, number> = { light: 0, medium: 1, heavy: 2 };

export function weightScore(a: FashionProfile, b: FashionProfile): number {
  const rankA = a.weight ? WEIGHT_RANK[a.weight] : undefined;
  const rankB = b.weight ? WEIGHT_RANK[b.weight] : undefined;
  if (rankA === undefined || rankB === undefined) return NEUTRAL_SCORE;

  const gap = Math.abs(rankA - rankB);
  // A linen shirt with a heavy wool coat is fine — that is layering.
  // A heavy knit with heavy corduroy is a lot. Mild penalties only.
  if (gap === 0) return rankA === 2 ? 0.65 : 0.85;
  if (gap === 1) return 0.9;
  return 0.75;
}

/**
 * Pattern (spec §49).
 *
 * The workable rule: one pattern per outfit, unless the scales differ
 * enough to read as intentional. Two medium florals is the classic
 * mistake.
 */
const SCALE_RANK: Record<string, number> = { none: 0, small: 1, medium: 2, large: 3 };

export function patternScore(a: FashionProfile, b: FashionProfile): number {
  if (!a.pattern || !b.pattern) return NEUTRAL_SCORE;

  const aPlain = a.pattern === "plain";
  const bPlain = b.pattern === "plain";
  if (aPlain && bPlain) return 0.8;
  if (aPlain || bPlain) return 0.95; // one pattern, one ground — ideal

  const scaleA = a.patternScale ? SCALE_RANK[a.patternScale] : undefined;
  const scaleB = b.patternScale ? SCALE_RANK[b.patternScale] : undefined;
  if (scaleA === undefined || scaleB === undefined) return 0.45;

  const spread = Math.abs(scaleA - scaleB);
  if (spread >= 2) return 0.7; // clearly deliberate mixing
  if (spread === 1) return 0.5;
  return 0.3; // two patterns at the same scale
}

/** Occasion overlap, cosine over the occasion vectors. */
export function occasionScore(a: FashionProfile, b: FashionProfile): number {
  const keys = new Set([...Object.keys(a.occasionVector), ...Object.keys(b.occasionVector)]);
  if (keys.size === 0) return NEUTRAL_SCORE;

  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const key of keys) {
    const x = a.occasionVector[key] ?? 0;
    const y = b.occasionVector[key] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return NEUTRAL_SCORE;
  return 0.3 + (dot / (Math.sqrt(magA) * Math.sqrt(magB))) * 0.7;
}

/** Score one pair of pieces (spec §49's `pair_score`). */
export function scorePair(
  a: FashionProfile,
  b: FashionProfile,
  weights: CompatibilityWeights = DEFAULT_WEIGHTS,
): PairScore {
  const color = colorScore(colorPoint(a.colorFamily), colorPoint(b.colorFamily));
  const silhouette = silhouetteScore(a, b);

  const components = {
    color: color.score,
    silhouette: silhouette.score,
    formality: formalityScore(a.formality, b.formality),
    style: styleScore(a, b),
    weight: weightScore(a, b),
    pattern: patternScore(a, b),
    occasion: occasionScore(a, b),
  };

  let weighted = 0;
  let totalWeight = 0;
  for (const key of Object.keys(components) as (keyof CompatibilityWeights)[]) {
    weighted += components[key] * weights[key];
    totalWeight += weights[key];
  }

  // Classified per dimension, not by the pair's total. A pairing can be
  // acceptable overall while one dimension is plainly wrong — trainers
  // with a dinner suit still score reasonably on colour and silhouette,
  // and judging by the total would let that formality gap go unmentioned.
  const notes: string[] = [];
  const issues: string[] = [];

  if (color.score >= 0.8) notes.push(color.note);
  else if (color.score <= 0.45) issues.push(color.note);

  if (silhouette.score >= 0.85) notes.push(silhouette.note);
  else if (silhouette.score <= 0.45) issues.push(silhouette.note);

  if (components.formality <= 0.5) {
    issues.push("the pieces sit at different levels of formality");
  }
  if (components.pattern <= 0.4) issues.push("two competing patterns");
  if (components.style <= 0.35) issues.push("the pieces pull in different style directions");

  return {
    total: totalWeight > 0 ? weighted / totalWeight : NEUTRAL_SCORE,
    components,
    notes,
    issues,
    colorRelationship: color.relationship,
  };
}

/**
 * Whole-outfit score (spec §49's second half: composition, proportion,
 * cohesion).
 *
 * Not the mean of the pairs. Spec §45 is explicit that compatibility is
 * about whether pieces work *together*, and an outfit where two pairs
 * are excellent and one is terrible is a bad outfit — the mean would
 * hide that. So the worst pair is weighted heavily, and the palette is
 * evaluated across the whole set rather than pairwise.
 */
export type OutfitScore = {
  total: number;
  pairwise: number;
  worstPair: number;
  palette: number;
  cohesion: number;
  issues: string[];
  notes: string[];
};

export function scoreOutfit(
  pieces: FashionProfile[],
  weights: CompatibilityWeights = DEFAULT_WEIGHTS,
): OutfitScore {
  if (pieces.length < 2) {
    return {
      total: NEUTRAL_SCORE,
      pairwise: NEUTRAL_SCORE,
      worstPair: NEUTRAL_SCORE,
      palette: NEUTRAL_SCORE,
      cohesion: NEUTRAL_SCORE,
      issues: ["not enough pieces to evaluate"],
      notes: [],
    };
  }

  const pairs: PairScore[] = [];
  for (let i = 0; i < pieces.length; i++) {
    for (let j = i + 1; j < pieces.length; j++) {
      pairs.push(scorePair(pieces[i], pieces[j], weights));
    }
  }

  const mean = pairs.reduce((sum, p) => sum + p.total, 0) / pairs.length;
  const worst = Math.min(...pairs.map((p) => p.total));
  const palette = paletteScore(pieces.map((p) => colorPoint(p.colorFamily)));

  // Cohesion: how tightly the formality levels cluster. A spread across
  // the whole outfit is worse than any single pair suggests, because
  // each piece drags in a different direction.
  const formalities = pieces
    .map((p) => p.formality)
    .filter((f): f is number => f !== null);
  const cohesion =
    formalities.length >= 2
      ? Math.max(0, 1 - (Math.max(...formalities) - Math.min(...formalities)) / FORMALITY_MAX)
      : NEUTRAL_SCORE;

  const issues: string[] = [];
  const notes: string[] = [];
  for (const pair of pairs) {
    issues.push(...pair.issues);
    notes.push(...pair.notes);
  }
  if (palette.distinctColors >= 3) {
    issues.push(`${palette.distinctColors} competing colours`);
  }

  // The worst pair carries the most weight: one bad pairing is what a
  // shopper sees, regardless of how good the rest is.
  const total = worst * 0.4 + mean * 0.25 + palette.score * 0.2 + cohesion * 0.15;

  return {
    total: Math.max(0, Math.min(1, total)),
    pairwise: mean,
    worstPair: worst,
    palette: palette.score,
    cohesion,
    issues: [...new Set(issues)],
    notes: [...new Set(notes)],
  };
}

/**
 * Brand coherence (spec §54).
 *
 * A separate score on purpose: "A fashion-valid outfit can still be
 * wrong for the merchant." Answers whether this combination would
 * plausibly belong inside *this* brand's world, by comparing the
 * outfit's aggregate style against the Brand Brain's.
 */
export function brandCoherence(
  pieces: FashionProfile[],
  brandStyleVector: Record<string, number> | null,
): number {
  if (!brandStyleVector || Object.keys(brandStyleVector).length === 0) {
    return NEUTRAL_SCORE;
  }

  const outfitStyle: Record<string, number> = {};
  let contributors = 0;
  for (const piece of pieces) {
    const entries = Object.entries(piece.styleVector);
    if (entries.length === 0) continue;
    contributors++;
    for (const [style, weight] of entries) {
      outfitStyle[style] = (outfitStyle[style] ?? 0) + weight;
    }
  }
  if (contributors === 0) return NEUTRAL_SCORE;
  for (const key of Object.keys(outfitStyle)) outfitStyle[key] /= contributors;

  const keys = new Set([...Object.keys(outfitStyle), ...Object.keys(brandStyleVector)]);
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (const key of keys) {
    const x = outfitStyle[key] ?? 0;
    const y = brandStyleVector[key] ?? 0;
    dot += x * y;
    magA += x * x;
    magB += y * y;
  }
  if (magA === 0 || magB === 0) return NEUTRAL_SCORE;
  return Math.max(0, Math.min(1, dot / (Math.sqrt(magA) * Math.sqrt(magB))));
}

/** Which slot a profiled product occupies, for outfit assembly. */
export function slotOf(profile: FashionProfile): Slot | null {
  return slotForGarment(profile.garment);
}
