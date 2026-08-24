/**
 * The judge (spec §57, §58).
 *
 * §58 is the important instruction here:
 *
 *   "Do not ask the generator to simply explain why its own result is
 *    good. Generator: create. Judge: challenge."
 *
 * So this is a separate model call with a separate prompt, and it is
 * given the outfit *without* the deterministic scores that produced it.
 * Handing over our own scores would invite agreement rather than
 * assessment — the whole value of a second opinion is that it can
 * disagree.
 *
 * What the judge is allowed to change: the ranking. What it is not
 * allowed to do: introduce a product. §57 — "Judge does not invent
 * products." Anything it names that is not in the outfit is discarded.
 */

import { FashionProfile } from "./fashion-profile";

export type JudgeVerdict = {
  overall: number;
  color: number;
  silhouette: number;
  formality: number;
  style: number;
  occasion: number;
  brand: number;
  shopperFit: number;
  issues: string[];
  confidence: number;
  /** True when this is the neutral fallback rather than a real verdict. */
  fallback: boolean;
};

const DIMENSIONS = [
  "overall", "color", "silhouette", "formality",
  "style", "occasion", "brand", "shopperFit",
] as const;

/**
 * A verdict that asserts nothing.
 *
 * Used whenever the model is unavailable or returns something
 * unusable. Every dimension sits at 0.5 so blending it with the
 * deterministic score leaves the ranking essentially unchanged — a
 * missing judge must not silently reorder results, and must certainly
 * not make an outfit look better than the evidence supports.
 */
export function neutralVerdict(): JudgeVerdict {
  return {
    overall: 0.5, color: 0.5, silhouette: 0.5, formality: 0.5,
    style: 0.5, occasion: 0.5, brand: 0.5, shopperFit: 0.5,
    issues: [],
    confidence: 0,
    fallback: true,
  };
}

function clamp01(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * Validate raw judge output (spec §85).
 *
 * Never throws. A malformed verdict degrades to neutral rather than
 * poisoning the ranking with garbage — "the model returned nonsense" and
 * "the outfit is bad" are different facts and must not be conflated.
 */
export function parseVerdict(raw: unknown): JudgeVerdict {
  if (!raw || typeof raw !== "object") return neutralVerdict();
  const r = raw as Record<string, unknown>;

  const verdict = neutralVerdict();
  let recognised = 0;

  for (const dimension of DIMENSIONS) {
    const value = clamp01(r[dimension]);
    if (value !== null) {
      verdict[dimension] = value;
      recognised++;
    }
  }

  // A verdict that scored nothing is not a verdict.
  if (recognised === 0) return neutralVerdict();

  if (Array.isArray(r.issues)) {
    verdict.issues = r.issues
      .filter((i): i is string => typeof i === "string")
      .map((i) => i.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 8);
  }

  const confidence = clamp01(r.confidence);
  verdict.confidence = confidence ?? 0.5;
  verdict.fallback = false;

  // If the model gave dimensions but no overall, derive one rather than
  // discarding an otherwise usable verdict.
  if (clamp01(r.overall) === null) {
    const scored = DIMENSIONS.filter((d) => d !== "overall").map((d) => verdict[d]);
    verdict.overall = scored.reduce((sum, s) => sum + s, 0) / scored.length;
  }

  return verdict;
}

/**
 * Combine the deterministic score with the judge's.
 *
 * The deterministic score keeps the larger share. It is reproducible,
 * explainable and cheap; the judge is a second opinion on the things
 * arithmetic cannot see. Weighting the model higher would make the
 * ranking non-reproducible and put §81's trace requirement out of reach.
 *
 * The judge's confidence scales its own influence, so an uncertain
 * verdict moves the ranking less than a sure one, and the neutral
 * fallback (confidence 0) does not move it at all.
 */
export function blendScore(
  deterministic: number,
  verdict: JudgeVerdict,
  judgeWeight = 0.35,
): number {
  if (verdict.fallback) return deterministic;
  const effective = judgeWeight * verdict.confidence;
  return deterministic * (1 - effective) + verdict.overall * effective;
}

/** What the judge is shown about each piece. Deliberately not our scores. */
export function describePiece(profile: FashionProfile): string {
  const parts: string[] = [];
  if (profile.garment) parts.push(profile.garment);
  if (profile.colorFamily) parts.push(profile.colorFamily);
  if (profile.fit) parts.push(`${profile.fit} fit`);
  if (profile.pattern && profile.pattern !== "plain") parts.push(profile.pattern);
  if (profile.formality !== null) parts.push(`formality ${profile.formality}/5`);
  if (profile.fabric) parts.push(profile.fabric);
  return parts.length > 0 ? parts.join(", ") : "no attributes established";
}
