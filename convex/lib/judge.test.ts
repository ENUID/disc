import { test } from "node:test";
import assert from "node:assert/strict";
import { blendScore, describePiece, neutralVerdict, parseVerdict } from "./judge";
import { emptyProfile } from "./fashion-profile";

/**
 * Spec §85: every model output used by code must pass schema
 * validation. The property that matters here is that "the model returned
 * nonsense" and "the outfit is bad" stay distinguishable — conflating
 * them would let a broken judge silently reorder every result.
 */

test("a well-formed verdict is accepted", () => {
  const verdict = parseVerdict({
    overall: 0.91, color: 0.94, silhouette: 0.87, formality: 0.96,
    style: 0.9, occasion: 0.95, brand: 0.92, shopperFit: 0.88,
    issues: ["the belt is a slightly different brown"],
    confidence: 0.82,
  });

  assert.equal(verdict.overall, 0.91);
  assert.equal(verdict.fallback, false);
  assert.equal(verdict.issues.length, 1);
});

test("garbage degrades to neutral rather than to zero", () => {
  for (const bad of [null, "prose", [], 42, {}, { nonsense: true }]) {
    const verdict = parseVerdict(bad);
    assert.equal(verdict.fallback, true, `${JSON.stringify(bad)} should fall back`);
    assert.equal(verdict.overall, 0.5);
    assert.equal(verdict.confidence, 0);
  }
});

test("out-of-range scores are clamped, not rejected wholesale", () => {
  const verdict = parseVerdict({ overall: 5, color: -3, style: 0.7 });
  assert.equal(verdict.overall, 1);
  assert.equal(verdict.color, 0);
  assert.equal(verdict.style, 0.7);
  assert.equal(verdict.fallback, false);
});

test("a missing overall is derived rather than discarding the verdict", () => {
  const verdict = parseVerdict({ color: 0.8, silhouette: 0.8, formality: 0.8 });
  assert.equal(verdict.fallback, false);
  // Derived from the dimensions that were scored, with the rest neutral.
  assert.ok(verdict.overall > 0.5 && verdict.overall < 0.8);
});

test("issues are bounded and cleaned", () => {
  const verdict = parseVerdict({
    overall: 0.5,
    issues: [...Array(20).fill("an issue"), 42, "", "  spaced  "],
  });
  assert.ok(verdict.issues.length <= 8, "a model must not flood the UI");
  assert.ok(!verdict.issues.includes(""));
  assert.ok(verdict.issues.every((i) => typeof i === "string"));
});

test("the neutral fallback does not move the ranking at all", () => {
  const deterministic = 0.73;
  // A judge that could not answer must leave the reproducible score
  // exactly as it was, or an outage silently reorders every result.
  assert.equal(blendScore(deterministic, neutralVerdict()), deterministic);
});

test("the judge's influence scales with its own confidence", () => {
  const deterministic = 0.5;
  const confident = parseVerdict({ overall: 1, confidence: 1 });
  const unsure = parseVerdict({ overall: 1, confidence: 0.1 });

  const withConfident = blendScore(deterministic, confident);
  const withUnsure = blendScore(deterministic, unsure);

  assert.ok(withConfident > withUnsure);
  assert.ok(withUnsure > deterministic, "an unsure verdict still counts a little");
});

test("the deterministic score keeps the larger share", () => {
  // The judge is a second opinion, not the decision. Weighting it higher
  // would make ranking non-reproducible and put §81's trace out of reach.
  const blended = blendScore(0.2, parseVerdict({ overall: 1, confidence: 1 }));
  assert.ok(blended < 0.6, `the judge must not override arithmetic, got ${blended}`);
});

test("describePiece states only what was established", () => {
  const rich = describePiece({
    ...emptyProfile(),
    garment: "sweater",
    colorFamily: "navy",
    fit: "relaxed",
    formality: 2,
  });
  assert.match(rich, /sweater/);
  assert.match(rich, /navy/);
  assert.match(rich, /formality 2\/5/);

  // A product with nothing established must say so rather than have the
  // judge fill the gap with assumptions.
  assert.match(describePiece(emptyProfile()), /no attributes established/);
});

test("describePiece omits a plain pattern as uninformative", () => {
  const plain = describePiece({ ...emptyProfile(), garment: "shirt", pattern: "plain" });
  assert.ok(!plain.includes("plain"));
  const striped = describePiece({ ...emptyProfile(), garment: "shirt", pattern: "stripe" });
  assert.match(striped, /stripe/);
});
