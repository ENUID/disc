import { test } from "node:test";
import assert from "node:assert/strict";
import {
  affinityBonus,
  affinityScore,
  buildAffinity,
  deriveLookAttributes,
  EMPTY_AFFINITY,
  MAX_AFFINITY_BONUS,
  orderPair,
  pairKey,
  pairsOf,
  parseDetections,
  sanitiseLookAttributes,
} from "./looks";
import { emptyProfile } from "./fashion-profile";
import { rankOutfits, type Candidate } from "./outfit";
import { slotForGarment, type Garment } from "./taxonomy";
import { emptyIntent } from "./intent";

/** A minimal ranking candidate, for the identity assertions below. */
function candidate(productId: string, garment: Garment): Candidate {
  return {
    productId,
    title: productId,
    price: 100,
    currency: "GBP",
    available: true,
    profile: { ...emptyProfile(), garment, formality: 3, colorFamily: "navy" },
    slot: slotForGarment(garment),
    relevance: 0.5,
  };
}

/**
 * The outfit graph's arithmetic.
 *
 * The single most important property here is that a tenant with no looks
 * gets exactly zero. Everything else is a tuning decision; that one is a
 * correctness requirement, because it is what stops the Look Builder
 * punishing every merchant who has not used it yet.
 */

test("a pair has exactly one canonical form", () => {
  // Two forms would mean the same relationship stored twice and counted
  // twice while scoring.
  assert.deepEqual(orderPair("b", "a"), { a: "a", b: "b" });
  assert.deepEqual(orderPair("a", "b"), { a: "a", b: "b" });
  assert.equal(pairKey("z", "a"), pairKey("a", "z"));
});

test("pairs are every unordered combination, without repeats", () => {
  assert.equal(pairsOf(["a", "b", "c"]).length, 3);
  assert.equal(pairsOf(["a", "b", "c", "d"]).length, 6);
  assert.equal(pairsOf(["a"]).length, 0);
  assert.equal(pairsOf([]).length, 0);
  // A product listed twice is still one product.
  assert.equal(pairsOf(["a", "a", "b"]).length, 1);
});

test("THE COLD-START GUARANTEE: no looks means exactly zero bonus", () => {
  // The property the whole feature rests on. A brand that installed Disc
  // this morning has no looks by definition; if that cost them anything
  // the Look Builder would punish the merchants it exists to win.
  const products = ["p1", "p2", "p3"];
  assert.equal(affinityBonus(products, EMPTY_AFFINITY), 0);
  assert.equal(affinityBonus(products), 0, "the default must be empty");
  assert.equal(affinityScore(products, EMPTY_AFFINITY), 0);
});

test("COLD START, at the ranker: the affinity argument is inert when empty", () => {
  // The strongest form of the guarantee — not "the bonus is small" but
  // "passing an empty graph is indistinguishable from not passing one".
  // If this ever diverges, every existing tenant's results shifted the
  // day the Look Builder shipped.
  const combinations = [
    [candidate("p1", "shirt"), candidate("p2", "trouser"), candidate("p3", "loafer")],
    [candidate("p1", "shirt"), candidate("p4", "jeans"), candidate("p5", "sneaker")],
  ];
  const intent = emptyIntent("something for dinner");

  const withoutArg = rankOutfits(combinations, intent, null);
  const withEmpty = rankOutfits(combinations, intent, null, undefined, EMPTY_AFFINITY);

  assert.deepEqual(
    withoutArg.map((o) => o.scores),
    withEmpty.map((o) => o.scores),
    "an empty graph must not change a single score",
  );
  for (const outfit of withoutArg) {
    assert.equal(outfit.scores.affinity, 0, "no looks means no affinity contribution");
  }
});

test("a vouched pair actually moves the ranking", () => {
  // The other half: a guarantee that the bonus is inert would be easy to
  // satisfy by making the feature do nothing at all.
  const combinations = [
    [candidate("p1", "shirt"), candidate("p2", "trouser"), candidate("p3", "loafer")],
  ];
  const intent = emptyIntent("something for dinner");

  const plain = rankOutfits(combinations, intent, null)[0];
  const vouched = rankOutfits(combinations, intent, null, undefined, buildAffinity(
    [
      { productA: "p1", productB: "p2", weight: 5 },
      { productA: "p1", productB: "p3", weight: 5 },
      { productA: "p2", productB: "p3", weight: 5 },
    ],
    30,
  ))[0];

  assert.ok(vouched.scores.final > plain.scores.final);
  assert.ok(vouched.scores.affinity > 0);
  // ...and only through the bonus. The other components are untouched,
  // which is what "additive, not folded into the weights" means.
  assert.equal(vouched.scores.compatibility, plain.scores.compatibility);
  assert.equal(vouched.scores.brand, plain.scores.brand);
  assert.equal(vouched.scores.shopperFit, plain.scores.shopperFit);
  assert.equal(vouched.scores.relevance, plain.scores.relevance);
});

test("an outfit sharing no pair with any look scores zero", () => {
  // The common case even for a merchant with a big library, and it must
  // cost nothing.
  const graph = buildAffinity(
    [{ productA: "x", productB: "y", weight: 3 }],
    10,
  );
  assert.equal(affinityBonus(["p1", "p2"], graph), 0);
});

test("a fully-vouched outfit gets the bonus, and never more than the cap", () => {
  const graph = buildAffinity(
    [
      { productA: "p1", productB: "p2", weight: 9 },
      { productA: "p1", productB: "p3", weight: 9 },
      { productA: "p2", productB: "p3", weight: 9 },
    ],
    50,
  );
  const bonus = affinityBonus(["p1", "p2", "p3"], graph);
  assert.ok(bonus > 0);
  assert.ok(
    bonus <= MAX_AFFINITY_BONUS + 1e-9,
    `bonus ${bonus} exceeded the cap ${MAX_AFFINITY_BONUS}`,
  );
});

test("the cap is small enough to break ties, not to override the ranker", () => {
  // Final scores sit roughly in 0..1. A bonus large enough to promote an
  // outfit the compatibility engine dislikes would let twenty looks from
  // one black campaign turn the whole boutique black.
  assert.ok(MAX_AFFINITY_BONUS <= 0.1, "bonus must stay a tiebreaker");
  assert.ok(MAX_AFFINITY_BONUS > 0, "a zero cap makes the feature inert");
});

test("partial evidence earns a partial bonus", () => {
  // One known pair out of three should not count as a fully-vouched
  // outfit — the merchant photographed part of this, not all of it.
  const full = buildAffinity(
    [
      { productA: "p1", productB: "p2", weight: 4 },
      { productA: "p1", productB: "p3", weight: 4 },
      { productA: "p2", productB: "p3", weight: 4 },
    ],
    50,
  );
  const partial = buildAffinity([{ productA: "p1", productB: "p2", weight: 4 }], 50);

  const products = ["p1", "p2", "p3"];
  assert.ok(affinityBonus(products, partial) < affinityBonus(products, full));
  assert.ok(affinityBonus(products, partial) > 0);
});

test("a repeated pair is better evidence, but with diminishing returns", () => {
  const once = buildAffinity([{ productA: "p1", productB: "p2", weight: 1 }], 50);
  const thrice = buildAffinity([{ productA: "p1", productB: "p2", weight: 3 }], 50);
  const fifty = buildAffinity([{ productA: "p1", productB: "p2", weight: 50 }], 50);

  const pair = ["p1", "p2"];
  assert.ok(affinityScore(pair, thrice) > affinityScore(pair, once));
  // Not linear: one hero pairing repeated across a whole campaign must
  // not dominate the graph.
  assert.ok(
    affinityScore(pair, fifty) < affinityScore(pair, once) * 10,
    "repetition must have diminishing returns",
  );
  assert.ok(affinityScore(pair, fifty) <= 1);
});

test("the bonus ramps in with library size", () => {
  const edges = [{ productA: "p1", productB: "p2", weight: 1 }];
  const one = buildAffinity(edges, 1);
  const many = buildAffinity(edges, 40);

  const pair = ["p1", "p2"];
  // A single photograph is not yet a statement about a brand's styling.
  // Without the ramp, the first look uploaded would immediately outrank
  // everything it touches on evidence of one image.
  assert.ok(affinityBonus(pair, one) < affinityBonus(pair, many));
  assert.ok(affinityBonus(pair, one) > 0);
});

test("a single-product outfit cannot be vouched for", () => {
  const graph = buildAffinity([{ productA: "p1", productB: "p2", weight: 5 }], 20);
  assert.equal(affinityBonus(["p1"], graph), 0);
  assert.equal(affinityBonus([], graph), 0);
});

// --------------------------------------------------------------- attributes

test("look attributes come from the weight of the evidence, not a vote count", () => {
  const strongDinner = { ...emptyProfile(), occasionVector: { dinner: 0.9 }, formality: 4 };
  const faintEveryday1 = { ...emptyProfile(), occasionVector: { everyday: 0.2 }, formality: 2 };
  const faintEveryday2 = { ...emptyProfile(), occasionVector: { everyday: 0.2 }, formality: 2 };

  const derived = deriveLookAttributes([strongDinner, faintEveryday1, faintEveryday2]);
  // Two faint "everyday" pieces should not outvote one emphatic "dinner".
  assert.equal(derived.occasion, "dinner");
  // Mean, not max: one formal piece does not make a look formal.
  assert.equal(derived.formality, 3);
});

test("attributes of an empty look are null, not invented", () => {
  const derived = deriveLookAttributes([]);
  assert.deepEqual(derived, {
    occasion: null,
    style: null,
    formality: null,
    season: null,
  });
});

test("merchant attributes outside the vocabulary are dropped, not stored", () => {
  const clean = sanitiseLookAttributes({
    occasion: "Dinner",
    style: "smart casual",
    season: "AUTUMN",
    formality: 4,
    notes: "our autumn campaign",
  });
  // Casing and separators are tolerated; the value is still canonical.
  assert.equal(clean.occasion, "dinner");
  assert.equal(clean.style, "smart_casual");
  assert.equal(clean.season, "autumn");
  assert.equal(clean.formality, 4);

  const junk = sanitiseLookAttributes({
    occasion: "moon landing",
    style: "<script>alert(1)</script>",
    season: 42,
    formality: 999,
  });
  assert.equal(junk.occasion, undefined);
  assert.equal(junk.style, undefined);
  assert.equal(junk.season, undefined);
  // Clamped into the real scale rather than stored as given.
  assert.equal(junk.formality, 5);
});

// --------------------------------------------------------------- detection

test("detections are parsed into the closed vocabulary", () => {
  const detected = parseDetections({
    garments: [
      { label: "white linen shirt", garment: "shirt", colour: "white", description: "A crisp white linen shirt, relaxed fit." },
      { label: "navy trousers", garment: "Trouser", colour: "navy", description: "Navy wide-leg trousers." },
      { label: "brown loafers", garment: "loafer", colour: "brown", description: "Brown leather loafers." },
    ],
  });

  assert.equal(detected.length, 3);
  assert.equal(detected[0].garment, "shirt");
  assert.equal(detected[0].slot, "top");
  // Casing tolerated, same as everywhere else in the vocabulary layer.
  assert.equal(detected[1].garment, "trouser");
  assert.equal(detected[1].slot, "bottom");
  assert.equal(detected[2].slot, "footwear");
});

test("an unrecognised garment survives as an unmapped detection", () => {
  // The merchant can still map it by hand, and their mapping is what
  // actually counts — discarding it would lose a real garment because
  // the model used a word outside our list.
  const detected = parseDetections({
    garments: [{ label: "kimono", garment: "kimono", description: "A patterned kimono." }],
  });
  assert.equal(detected.length, 1);
  assert.equal(detected[0].garment, null);
  assert.equal(detected[0].slot, null);
  assert.equal(detected[0].label, "kimono");
});

test("malformed detection output yields nothing rather than throwing", () => {
  // §85: repair, then fall back to an honest empty result.
  for (const bad of [null, undefined, "text", 42, {}, { garments: "nope" }]) {
    assert.deepEqual(parseDetections(bad), []);
  }
  assert.deepEqual(parseDetections({ garments: [null, 5, {}] }), []);
});

test("detections are bounded", () => {
  // A photograph of a crowd must not produce a fifty-item look.
  const many = Array.from({ length: 40 }, (_, i) => ({
    label: `item ${i}`,
    garment: "shirt",
    description: "a shirt",
  }));
  assert.ok(parseDetections({ garments: many }).length <= 12);
});

test("detection fields are truncated, not trusted", () => {
  const detected = parseDetections({
    garments: [{ label: "x".repeat(500), garment: "shirt", description: "y".repeat(9000) }],
  });
  assert.ok(detected[0].label.length <= 80);
  assert.ok(detected[0].description.length <= 300);
});
