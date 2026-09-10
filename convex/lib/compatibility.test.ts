import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyRelationship, colorPoint, colorScore, hueDistance, paletteScore } from "./color";
import {
  brandCoherence,
  formalityScore,
  NEUTRAL_SCORE,
  occasionScore,
  patternScore,
  scoreOutfit,
  scorePair,
  silhouetteScore,
  styleScore,
  weightScore,
} from "./compatibility";
import { emptyProfile, type FashionProfile } from "./fashion-profile";

const p = (over: Partial<FashionProfile>): FashionProfile => ({ ...emptyProfile(), ...over });

/**
 * The rule under test throughout: an unknown attribute scores NEUTRAL,
 * never zero. An unenriched product must not rank below a genuinely bad
 * one, and missing data must not fake quality either.
 */

test("every scorer returns neutral when the attribute is unestablished", () => {
  const blank = p({});
  assert.equal(formalityScore(null, null), NEUTRAL_SCORE);
  assert.equal(formalityScore(2, null), NEUTRAL_SCORE);
  assert.equal(silhouetteScore(blank, blank).score, NEUTRAL_SCORE);
  assert.equal(styleScore(blank, blank), NEUTRAL_SCORE);
  assert.equal(weightScore(blank, blank), NEUTRAL_SCORE);
  assert.equal(patternScore(blank, blank), NEUTRAL_SCORE);
  assert.equal(occasionScore(blank, blank), NEUTRAL_SCORE);
  assert.equal(colorScore(null, null).score, NEUTRAL_SCORE);
});

test("hueDistance wraps around the wheel", () => {
  assert.equal(hueDistance(10, 350), 20, "must go the short way round");
  assert.equal(hueDistance(0, 180), 180);
  assert.equal(hueDistance(90, 90), 0);
});

test("colour relationships are classified from families", () => {
  assert.equal(classifyRelationship(colorPoint("black"), colorPoint("white")), "both_neutral");
  assert.equal(classifyRelationship(colorPoint("navy"), colorPoint("red")), "neutral_anchored");
  assert.equal(classifyRelationship(colorPoint("red"), colorPoint("red")), "tonal");
  assert.equal(classifyRelationship(colorPoint("blue"), colorPoint("orange")), "complementary");
  // 80 degrees apart: both cool, reads as related rather than opposed.
  assert.equal(classifyRelationship(colorPoint("blue"), colorPoint("green")), "analogous");
  assert.equal(classifyRelationship(colorPoint("red"), colorPoint("orange")), "analogous");
  assert.equal(classifyRelationship(colorPoint("blue"), null), "unknown");
});

test("neutrals score high, vivid opposites score low", () => {
  const neutrals = colorScore(colorPoint("navy"), colorPoint("white"));
  const vividOpposites = colorScore(colorPoint("red"), colorPoint("green"));

  assert.ok(neutrals.score > 0.8, `neutral pairing should be strong, got ${neutrals.score}`);
  // Defensible but risky — the score should say so rather than forbid it.
  assert.ok(
    vividOpposites.score < 0.5,
    `two vivid opposites should score low, got ${vividOpposites.score}`,
  );
  assert.ok(vividOpposites.score > 0.2, "but not be treated as impossible");
});

test("two mid-tone neutrals close in value are flagged as a near-miss", () => {
  // navy with brown: close enough in value that it reads as a failed
  // match rather than a deliberate tonal choice. A genuine styling
  // debate, and the case this rule exists for.
  const muddy = colorScore(colorPoint("navy"), colorPoint("brown"));
  const clean = colorScore(colorPoint("navy"), colorPoint("white"));
  assert.ok(muddy.score < clean.score, `${muddy.score} should be below ${clean.score}`);
  assert.ok(muddy.score > 0.5, "still a defensible pairing, just not a strong one");
});

test("paletteScore penalises breadth, not just bad pairs", () => {
  // Each pair here is individually acceptable against a neutral, but
  // four competing colours is not an outfit.
  const busy = paletteScore([
    colorPoint("red"),
    colorPoint("green"),
    colorPoint("yellow"),
    colorPoint("purple"),
  ]);
  const calm = paletteScore([colorPoint("navy"), colorPoint("white"), colorPoint("grey")]);

  assert.ok(calm.score > busy.score);
  assert.equal(calm.distinctColors, 0, "neutrals do not count as competing colours");
  assert.equal(busy.distinctColors, 4);
});

test("formality gaps are penalised superlinearly", () => {
  // Trainers with a dinner jacket is not merely twice as wrong as
  // loafers with chinos — it is a different kind of wrong.
  const oneStep = formalityScore(2, 3);
  const twoStep = formalityScore(1, 3);
  const fourStep = formalityScore(1, 5);

  assert.ok(oneStep > 0.9, "one step apart is normal");
  assert.ok(twoStep < oneStep);
  assert.ok(fourStep < twoStep * 0.6, `a four-step gap must be severe, got ${fourStep}`);
  assert.equal(formalityScore(3, 3), 1);
});

test("silhouette scores the relationship, not either piece", () => {
  const bothOversized = silhouetteScore(p({ fit: "oversized" }), p({ fit: "wide" }));
  const balanced = silhouetteScore(p({ fit: "relaxed" }), p({ fit: "slim" }));
  const bothTight = silhouetteScore(p({ fit: "skinny" }), p({ fit: "slim" }));

  assert.ok(balanced.score > 0.85, "volume against a cleaner line is the classic balance");
  assert.ok(bothOversized.score < 0.5, "volume on both halves reads shapeless");
  // Severe rather than wrong — a deliberate look, scored below balance.
  assert.ok(bothTight.score > bothOversized.score);
  assert.ok(bothTight.score < balanced.score);
});

test("style comparison uses partial overlap, not label equality", () => {
  const a = p({ styleVector: { minimal: 0.9, classic: 0.4 } });
  const b = p({ styleVector: { minimal: 0.8, classic: 0.5 } });
  const c = p({ styleVector: { streetwear: 0.9 } });

  assert.ok(styleScore(a, b) > 0.9, "near-identical vectors");
  assert.ok(styleScore(a, c) < styleScore(a, b));
  // Disagreement is not disqualifying — deliberate contrast is a real
  // styling move.
  assert.ok(styleScore(a, c) >= 0.25);
});

test("pattern: one pattern against a plain ground is ideal", () => {
  const patternOnPlain = patternScore(p({ pattern: "stripe" }), p({ pattern: "plain" }));
  const twoSameScale = patternScore(
    p({ pattern: "floral", patternScale: "medium" }),
    p({ pattern: "check", patternScale: "medium" }),
  );
  const twoDifferentScale = patternScore(
    p({ pattern: "floral", patternScale: "small" }),
    p({ pattern: "check", patternScale: "large" }),
  );

  assert.ok(patternOnPlain > 0.9);
  // Two medium patterns is the classic mistake.
  assert.ok(twoSameScale < 0.4);
  assert.ok(twoDifferentScale > twoSameScale, "differing scales read as intentional");
});

test("weight: layering is fine, two heavy pieces less so", () => {
  assert.ok(weightScore(p({ weight: "light" }), p({ weight: "heavy" })) > 0.7, "layering");
  assert.ok(
    weightScore(p({ weight: "heavy" }), p({ weight: "heavy" })) <
      weightScore(p({ weight: "light" }), p({ weight: "light" })),
  );
});

test("scorePair separates what works from what is wrong", () => {
  const good = scorePair(
    p({ colorFamily: "navy", fit: "relaxed", formality: 2, pattern: "plain" }),
    p({ colorFamily: "white", fit: "slim", formality: 2, pattern: "plain" }),
  );
  assert.ok(good.total > 0.75);
  assert.ok(good.notes.length > 0, "a strong pairing should be explainable");
  assert.equal(good.issues.length, 0);

  const bad = scorePair(
    p({ colorFamily: "red", fit: "oversized", formality: 0, pattern: "floral", patternScale: "medium" }),
    p({ colorFamily: "green", fit: "wide", formality: 5, pattern: "check", patternScale: "medium" }),
  );
  assert.ok(bad.total < 0.45);
  // Problems are issues, not notes — an explanation must not cite a
  // formality clash as a reason the outfit works.
  assert.equal(bad.notes.length, 0, "nothing here works");
  assert.ok(bad.issues.some((n) => /formality/.test(n)));
  assert.ok(bad.issues.some((n) => /pattern/.test(n)));
});

test("an outfit is judged by its worst pairing, not its average", () => {
  // Two excellent pairings and one terrible one is a bad outfit. A mean
  // would hide exactly the thing a shopper would notice first.
  const top = p({ colorFamily: "navy", formality: 2, fit: "relaxed" });
  const bottom = p({ colorFamily: "grey", formality: 2, fit: "slim" });
  const badShoe = p({ colorFamily: "red", formality: 5, fit: "skinny" });

  const good = scoreOutfit([top, bottom, p({ colorFamily: "white", formality: 2, fit: "regular" })]);
  const spoiled = scoreOutfit([top, bottom, badShoe]);

  assert.ok(spoiled.total < good.total);
  assert.ok(spoiled.worstPair < spoiled.pairwise, "the worst pair must drag the total");
  assert.ok(spoiled.issues.length > 0);
});

test("scoreOutfit needs at least two pieces to say anything", () => {
  const single = scoreOutfit([p({ colorFamily: "navy" })]);
  assert.equal(single.total, NEUTRAL_SCORE);
  assert.ok(single.issues.length > 0);
});

test("cohesion falls when formality is spread across the outfit", () => {
  const tight = scoreOutfit([p({ formality: 2 }), p({ formality: 2 }), p({ formality: 2 })]);
  const spread = scoreOutfit([p({ formality: 0 }), p({ formality: 2 }), p({ formality: 5 })]);
  assert.ok(spread.cohesion < tight.cohesion);
});

test("brand coherence is separate from fashion quality (spec §54)", () => {
  const streetwearOutfit = [
    p({ styleVector: { streetwear: 0.9 } }),
    p({ styleVector: { streetwear: 0.8 } }),
  ];
  const minimalBrand = { minimal: 1, classic: 0.7 };
  const streetwearBrand = { streetwear: 1 };

  // A fashion-valid outfit can still be wrong for the merchant.
  assert.ok(brandCoherence(streetwearOutfit, minimalBrand) < 0.3);
  assert.ok(brandCoherence(streetwearOutfit, streetwearBrand) > 0.9);
});

test("brand coherence is neutral when there is no brand to compare against", () => {
  const outfit = [p({ styleVector: { minimal: 1 } })];
  assert.equal(brandCoherence(outfit, null), NEUTRAL_SCORE);
  assert.equal(brandCoherence(outfit, {}), NEUTRAL_SCORE);
  assert.equal(brandCoherence([p({})], { minimal: 1 }), NEUTRAL_SCORE);
});

test("an entirely unenriched outfit lands at neutral, not at zero", () => {
  // The regression this guards: a catalog that has not been enriched yet
  // must not score as actively bad, or a new merchant's results would
  // look broken rather than provisional.
  const blank = scoreOutfit([p({}), p({}), p({})]);
  assert.ok(blank.total > 0.4 && blank.total < 0.6, `expected ~neutral, got ${blank.total}`);
});
