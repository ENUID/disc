/**
 * Colour reasoning (spec §50).
 *
 * The spec asks for hue, lightness, saturation, family, contrast and
 * temperature, and then says something important:
 *
 *   "Do not make color theory rigid. Context matters."
 *
 * So this returns a *score with a named relationship*, not a verdict.
 * Two saturated colours 180° apart are complementary, which is a real
 * and deliberate choice in fashion — but it is also how you get a
 * red-and-green outfit. The score reflects that it is defensible but
 * risky, and the relationship name lets the explanation say why.
 *
 * Neutrals do most of the work in real wardrobes and are treated
 * accordingly: a neutral pairs with almost anything, and two neutrals
 * together are the safest combination there is.
 */

import { isNeutral } from "./taxonomy";

export type ColorPoint = {
  /** Degrees, 0-360. Null for achromatic colours where hue is meaningless. */
  hue: number | null;
  /** 0 (black) to 1 (white). */
  lightness: number;
  /** 0 (grey) to 1 (vivid). */
  saturation: number;
  family: string;
  neutral: boolean;
};

export type ColorRelationship =
  | "tonal"
  | "analogous"
  | "complementary"
  | "neutral_anchored"
  | "both_neutral"
  | "clash"
  | "unknown";

/**
 * Representative point for each colour family.
 *
 * Approximations, deliberately. The alternative is parsing a merchant's
 * free-text colour name ("Blizzard Sole", "Hazy Indigo"), which is
 * unreliable in exactly the cases where it matters. The family is what
 * the vision model established, so the family is what is trusted.
 */
const FAMILY_POINTS: Record<string, Omit<ColorPoint, "family" | "neutral">> = {
  black: { hue: null, lightness: 0.05, saturation: 0 },
  white: { hue: null, lightness: 0.96, saturation: 0 },
  grey: { hue: null, lightness: 0.55, saturation: 0.02 },
  beige: { hue: 35, lightness: 0.82, saturation: 0.18 },
  brown: { hue: 25, lightness: 0.32, saturation: 0.45 },
  navy: { hue: 220, lightness: 0.22, saturation: 0.55 },
  blue: { hue: 210, lightness: 0.5, saturation: 0.7 },
  green: { hue: 130, lightness: 0.42, saturation: 0.55 },
  olive: { hue: 80, lightness: 0.38, saturation: 0.4 },
  yellow: { hue: 52, lightness: 0.7, saturation: 0.85 },
  orange: { hue: 28, lightness: 0.6, saturation: 0.85 },
  red: { hue: 358, lightness: 0.45, saturation: 0.8 },
  pink: { hue: 340, lightness: 0.72, saturation: 0.55 },
  purple: { hue: 280, lightness: 0.42, saturation: 0.55 },
  metallic: { hue: 45, lightness: 0.72, saturation: 0.25 },
  multi: { hue: null, lightness: 0.5, saturation: 0.6 },
};

export function colorPoint(family: string | null | undefined): ColorPoint | null {
  if (!family) return null;
  const base = FAMILY_POINTS[family];
  if (!base) return null;
  return { ...base, family, neutral: isNeutral(family) };
}

/** Shortest angular distance between two hues, 0-180. */
export function hueDistance(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return raw > 180 ? 360 - raw : raw;
}

export function classifyRelationship(
  a: ColorPoint | null,
  b: ColorPoint | null,
): ColorRelationship {
  if (!a || !b) return "unknown";

  if (a.neutral && b.neutral) return "both_neutral";
  if (a.neutral || b.neutral) return "neutral_anchored";

  // "multi" has no single hue to compare against; treat it as its own
  // thing rather than pretending it sits somewhere on the wheel.
  if (a.hue === null || b.hue === null) return "unknown";

  if (a.family === b.family) return "tonal";

  // These bands are wider than textbook colour theory, deliberately.
  // Named colour families do not sit at tidy 180° oppositions: red and
  // green — the canonical "opposed" pair in clothing — are 132° apart
  // here, and blue and green are 80°, which reads as a normal cool-tone
  // pairing rather than a mistake. Strict 40°/150° bands classified both
  // as clashes, which is wrong about how the colours actually behave.
  const distance = hueDistance(a.hue, b.hue);
  if (distance <= 90) return "analogous";
  if (distance >= 120) return "complementary";
  return "clash";
}

/**
 * Score a colour pairing, 0-1.
 *
 * Unknown returns 0.5 — genuinely neutral. This matters: a product with
 * no established colour must not be scored as *bad*, or an unenriched
 * catalog would rank worse than a wrong one. It must not be scored as
 * *good* either, or missing data would fake quality.
 */
export function colorScore(
  a: ColorPoint | null,
  b: ColorPoint | null,
): { score: number; relationship: ColorRelationship; note: string } {
  const relationship = classifyRelationship(a, b);

  if (relationship === "unknown" || !a || !b) {
    return { score: 0.5, relationship: "unknown", note: "colour not established" };
  }

  const contrast = Math.abs(a.lightness - b.lightness);

  switch (relationship) {
    case "both_neutral": {
      // Two neutrals almost always work. The one failure is two mid-tone
      // neutrals so close in value they read as a failed match rather
      // than a deliberate tonal choice.
      const muddy = contrast < 0.12 && a.family !== b.family;
      return {
        score: muddy ? 0.62 : 0.92,
        relationship,
        note: muddy
          ? "two neutrals close in tone can read as a mismatch"
          : "neutral palette",
      };
    }

    case "neutral_anchored":
      // A neutral grounds a colour. This is the workhorse of real
      // outfits and should score highly.
      return { score: 0.86, relationship, note: "a neutral anchors the colour" };

    case "tonal": {
      // Same family. Strong when the values differ enough to be legible
      // as intentional.
      const legible = contrast >= 0.15;
      return {
        score: legible ? 0.88 : 0.66,
        relationship,
        note: legible ? "tonal, with enough contrast to read" : "tonal but very flat",
      };
    }

    case "analogous":
      return { score: 0.78, relationship, note: "neighbouring colours" };

    case "complementary": {
      // Defensible and deliberate, but the risk rises with saturation:
      // two muted opposites are handsome, two vivid ones are a costume.
      // Threshold at 0.6, not 0.7: red and green average 0.675 and are
      // the canonical risky pairing, so a 0.7 gate let exactly the case
      // this rule exists for score as "muted enough to work".
      const intensity = (a.saturation + b.saturation) / 2;
      const score = intensity > 0.6 ? 0.42 : 0.68;
      return {
        score,
        relationship,
        note:
          intensity > 0.6
            ? "opposing colours, both vivid — high risk"
            : "opposing colours, muted enough to work",
      };
    }

    case "clash":
    default: {
      // Neither neighbouring nor opposing. Saturation decides how badly.
      const intensity = (a.saturation + b.saturation) / 2;
      return {
        score: intensity > 0.6 ? 0.28 : 0.5,
        relationship: "clash",
        note: "colours sit awkwardly apart on the wheel",
      };
    }
  }
}

/**
 * Score a whole palette rather than a pair.
 *
 * An outfit is not a set of independent pairings: three pieces that each
 * pair acceptably can still be three competing colours. This takes the
 * worst pairing and then penalises breadth, because "how many distinct
 * non-neutral colours are present" is what actually makes an outfit look
 * busy.
 */
export function paletteScore(points: Array<ColorPoint | null>): {
  score: number;
  worstPair: ColorRelationship;
  distinctColors: number;
} {
  const known = points.filter((p): p is ColorPoint => p !== null);
  if (known.length < 2) {
    return { score: 0.5, worstPair: "unknown", distinctColors: known.length };
  }

  let worst = 1;
  let worstRelationship: ColorRelationship = "unknown";
  for (let i = 0; i < known.length; i++) {
    for (let j = i + 1; j < known.length; j++) {
      const { score, relationship } = colorScore(known[i], known[j]);
      if (score < worst) {
        worst = score;
        worstRelationship = relationship;
      }
    }
  }

  const distinctColors = new Set(known.filter((p) => !p.neutral).map((p) => p.family)).size;

  // Three or more competing colours is where an outfit stops reading as
  // considered. Neutrals are free — they are what holds the rest
  // together.
  const breadthPenalty = distinctColors >= 3 ? 0.15 * (distinctColors - 2) : 0;

  return {
    score: Math.max(0, Math.min(1, worst - breadthPenalty)),
    worstPair: worstRelationship,
    distinctColors,
  };
}
