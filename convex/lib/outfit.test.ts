import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildOutfits,
  bucketBySlot,
  Candidate,
  DEFAULT_LIMITS,
  distance,
  generateCombinations,
  passesHardConstraints,
  rankOutfits,
  requiredSlots,
  selectDiverse,
  shopperFit,
} from "./outfit";
import { emptyProfile, type FashionProfile } from "./fashion-profile";
import { emptyIntent, type Intent } from "./intent";

const profile = (over: Partial<FashionProfile>): FashionProfile => ({
  ...emptyProfile(),
  ...over,
});

const candidate = (
  id: string,
  garment: string,
  over: Partial<FashionProfile> = {},
  extra: Partial<Candidate> = {},
): Candidate => ({
  productId: id,
  title: id,
  price: 100,
  currency: "GBP",
  available: true,
  profile: profile({ garment: garment as never, ...over }),
  slot: null,
  relevance: 0.5,
  ...extra,
});

const intent = (over: Partial<Intent> = {}): Intent => ({ ...emptyIntent(), ...over });

/**
 * Spec §46's funnel and §55's ranking hierarchy. The properties that
 * matter are that hard constraints are absolute, that merchandising
 * cannot outrank what the shopper asked for, and that the final results
 * are genuinely different from each other.
 */

test("hard constraints reject rather than penalise (spec §47)", () => {
  const base = intent({ budget: { amount: 150, currency: "GBP" } });

  assert.equal(
    passesHardConstraints(candidate("sold-out", "shirt", {}, { available: false }), base),
    false,
    "an unavailable product cannot be bought, so it is not an option",
  );
  assert.equal(
    passesHardConstraints(candidate("expensive", "shirt", {}, { price: 400 }), base),
    false,
    "a stated budget is a statement, not a preference",
  );
  assert.equal(passesHardConstraints(candidate("ok", "shirt", {}, { price: 120 }), base), true);
});

test("an explicitly rejected fit or style is excluded", () => {
  const noSkinny = intent({ fitNegative: ["skinny"] });
  assert.equal(
    passesHardConstraints(candidate("a", "jeans", { fit: "skinny" }), noSkinny),
    false,
  );
  assert.equal(
    passesHardConstraints(candidate("b", "jeans", { fit: "relaxed" }), noSkinny),
    true,
  );

  const noStreetwear = intent({ styleNegative: ["streetwear"] });
  assert.equal(
    passesHardConstraints(
      candidate("c", "hoodie", { styleVector: { streetwear: 0.9 } }),
      noStreetwear,
    ),
    false,
  );
  // A faint trace of a rejected style is not the same as being that style.
  assert.equal(
    passesHardConstraints(
      candidate("d", "hoodie", { styleVector: { streetwear: 0.2, minimal: 0.8 } }),
      noStreetwear,
    ),
    true,
  );
});

test("shopperFit is neutral when the shopper constrained nothing", () => {
  const fit = shopperFit(candidate("a", "shirt", { formality: 3 }), intent());
  assert.equal(fit, 0.5, "an unconstrained request must not advantage or penalise anything");
});

test("shopperFit rewards matching what was actually asked for", () => {
  const wantsFormal = intent({ formality: 4, stylePositive: ["classic"] });
  const match = shopperFit(
    candidate("a", "blazer", { formality: 4, styleVector: { classic: 0.9 } }),
    wantsFormal,
  );
  const mismatch = shopperFit(
    candidate("b", "hoodie", { formality: 0, styleVector: { streetwear: 0.9 } }),
    wantsFormal,
  );
  assert.ok(match > 0.8);
  assert.ok(mismatch < 0.3);
});

test("bucketBySlot groups by garment and drops failures", () => {
  const candidates = [
    candidate("top1", "shirt"),
    candidate("top2", "sweater"),
    candidate("bottom1", "trouser"),
    candidate("shoe1", "loafer"),
    candidate("gone", "shirt", {}, { available: false }),
    candidate("untyped", "" as never),
  ];

  const buckets = bucketBySlot(candidates, intent(), DEFAULT_LIMITS);
  assert.equal(buckets.get("top")?.length, 2);
  assert.equal(buckets.get("bottom")?.length, 1);
  assert.equal(buckets.get("footwear")?.length, 1);
  // A product whose garment could not be established has no slot, so it
  // cannot be placed in an outfit.
  assert.equal([...buckets.values()].flat().find((c) => c.productId === "untyped"), undefined);
  assert.equal([...buckets.values()].flat().find((c) => c.productId === "gone"), undefined);
});

test("a one-piece replaces top and bottom rather than joining them", () => {
  const buckets = bucketBySlot(
    [candidate("d1", "dress"), candidate("s1", "heel")],
    intent(),
    DEFAULT_LIMITS,
  );
  const plans = requiredSlots(buckets);

  assert.ok(plans.length > 0);
  for (const plan of plans) {
    if (plan.includes("onepiece")) {
      // Pairing a dress with trousers is a category error, not a taste
      // call, so no plan may contain both.
      assert.ok(!plan.includes("top"), "a dress plan must not also want a top");
      assert.ok(!plan.includes("bottom"), "a dress plan must not also want a bottom");
    }
  }
});

test("combination generation is bounded", () => {
  const many = Array.from({ length: 40 }, (_, i) => candidate(`t${i}`, "shirt"));
  const bottoms = Array.from({ length: 40 }, (_, i) => candidate(`b${i}`, "trouser"));
  const shoes = Array.from({ length: 40 }, (_, i) => candidate(`s${i}`, "loafer"));

  const buckets = bucketBySlot([...many, ...bottoms, ...shoes], intent(), DEFAULT_LIMITS);
  // 40 x 40 x 40 is 64,000 combinations; per-slot capping must cut that
  // long before any are formed.
  for (const bucket of buckets.values()) {
    assert.ok(bucket.length <= DEFAULT_LIMITS.perSlot);
  }

  const combos = generateCombinations(buckets, ["top", "bottom", "footwear"], 100);
  assert.ok(combos.length <= 100);
  assert.ok(combos.every((c) => c.length === 3));
});

test("merchandising cannot outrank what the shopper asked for (spec §55)", () => {
  const wantsCasual = intent({ formality: 1 });

  // A heavily promoted product that is wrong for the request, against an
  // unpromoted one that is right.
  const promotedWrong = [
    candidate("pt", "blazer", { formality: 5, colorFamily: "black" }, { boost: 1 }),
    candidate("pb", "trouser", { formality: 5, colorFamily: "black" }, { boost: 1 }),
  ];
  const plainRight = [
    candidate("gt", "t-shirt", { formality: 1, colorFamily: "white" }, { boost: 0 }),
    candidate("gb", "jeans", { formality: 1, colorFamily: "navy" }, { boost: 0 }),
  ];

  const ranked = rankOutfits([promotedWrong, plainRight], wantsCasual, null);
  assert.equal(
    ranked[0].pieces[0].productId,
    "gt",
    "the right-for-the-shopper outfit must win despite zero merchandising",
  );
});

test("brand coherence shifts ranking between equally valid outfits", () => {
  const minimalOutfit = [
    candidate("mt", "shirt", { styleVector: { minimal: 0.9 }, formality: 2, colorFamily: "white" }),
    candidate("mb", "trouser", { styleVector: { minimal: 0.9 }, formality: 2, colorFamily: "navy" }),
  ];
  const streetOutfit = [
    candidate("st", "hoodie", { styleVector: { streetwear: 0.9 }, formality: 1, colorFamily: "black" }),
    candidate("sb", "jeans", { styleVector: { streetwear: 0.9 }, formality: 1, colorFamily: "grey" }),
  ];

  const forMinimalBrand = rankOutfits([minimalOutfit, streetOutfit], intent(), { minimal: 1 });
  const forStreetBrand = rankOutfits([minimalOutfit, streetOutfit], intent(), { streetwear: 1 });

  // Same two outfits, different merchant: the winner should change.
  assert.equal(forMinimalBrand[0].pieces[0].productId, "mt");
  assert.equal(forStreetBrand[0].pieces[0].productId, "st");
});

test("confidence reflects evidence, not the score", () => {
  const known = rankOutfits(
    [
      [
        candidate("a", "shirt", { formality: 2, colorFamily: "white", fit: "slim" }),
        candidate("b", "trouser", { formality: 2, colorFamily: "navy", fit: "relaxed" }),
      ],
    ],
    intent(),
    null,
  );
  const unknown = rankOutfits(
    [[candidate("c", "shirt"), candidate("d", "trouser")]],
    intent(),
    null,
  );

  // An outfit assembled from barely-enriched products can score well by
  // accident; saying so is the honest answer (spec §97).
  assert.ok(known[0].confidence > unknown[0].confidence);
});

test("diversity returns different outfits, not variations on one", () => {
  const shared = candidate("same-top", "shirt", { colorFamily: "white", formality: 2 });
  const nearDuplicates = Array.from({ length: 6 }, (_, i) => [
    shared,
    candidate(`b${i}`, "trouser", { colorFamily: "navy", formality: 2 }),
  ]);
  const genuinelyDifferent = [
    candidate("alt-top", "hoodie", { colorFamily: "black", formality: 0 }),
    candidate("alt-bottom", "jeans", { colorFamily: "grey", formality: 0 }),
  ];

  const ranked = rankOutfits([...nearDuplicates, genuinelyDifferent], intent(), null);
  const chosen = selectDiverse(ranked, 3);

  assert.equal(chosen.length, 3);
  const ids = chosen.map((o) => o.pieces.map((p) => p.productId).join("+"));
  assert.equal(new Set(ids).size, 3, "no exact repeats");
  // The point of §59: five options that differ by one piece are one
  // option. The distinct alternative must earn a place.
  assert.ok(
    chosen.some((o) => o.pieces.some((p) => p.productId === "alt-top")),
    "a genuinely different outfit should be surfaced over another near-duplicate",
  );
});

test("distance counts shared pieces, palette and direction", () => {
  const ranked = rankOutfits(
    [
      [candidate("a", "shirt", { colorFamily: "white" }), candidate("b", "trouser", { colorFamily: "navy" })],
      [candidate("a", "shirt", { colorFamily: "white" }), candidate("c", "trouser", { colorFamily: "navy" })],
      [candidate("x", "hoodie", { colorFamily: "red" }), candidate("y", "jeans", { colorFamily: "green" })],
    ],
    intent(),
    null,
  );
  const byId = (id: string) => ranked.find((o) => o.pieces[0].productId === id)!;

  const nearlySame = distance(byId("a"), ranked.find((o) => o.pieces[1].productId === "c")!);
  const totallyDifferent = distance(byId("a"), byId("x"));
  assert.ok(totallyDifferent > nearlySame);
});

test("selectDiverse returns everything when there is little to choose from", () => {
  const ranked = rankOutfits(
    [[candidate("a", "shirt"), candidate("b", "trouser")]],
    intent(),
    null,
  );
  assert.equal(selectDiverse(ranked, 5).length, 1);
});

test("the whole funnel narrows and reports how (spec §46)", () => {
  const candidates = [
    ...Array.from({ length: 30 }, (_, i) =>
      candidate(`t${i}`, "shirt", { formality: 2, colorFamily: "white" }),
    ),
    ...Array.from({ length: 30 }, (_, i) =>
      candidate(`b${i}`, "trouser", { formality: 2, colorFamily: "navy" }),
    ),
    ...Array.from({ length: 20 }, (_, i) =>
      candidate(`s${i}`, "loafer", { formality: 3, colorFamily: "brown" }),
    ),
  ];

  const { outfits, funnel } = buildOutfits(candidates, intent(), null);

  assert.equal(funnel.candidates, 80);
  assert.ok(funnel.combinations <= DEFAULT_LIMITS.combinations);
  assert.ok(funnel.final <= DEFAULT_LIMITS.final);
  assert.ok(outfits.length > 0, "a workable catalog must produce outfits");
  // Every returned outfit must be complete and internally consistent.
  for (const outfit of outfits) {
    assert.ok(outfit.pieces.length >= 2);
    assert.ok(outfit.scores.final >= 0 && outfit.scores.final <= 1);
    assert.ok(outfit.direction.length > 0);
  }
});

test("the funnel yields nothing rather than something wrong", () => {
  // Everything sold out: there is no honest outfit to return.
  const soldOut = [
    candidate("t", "shirt", {}, { available: false }),
    candidate("b", "trouser", {}, { available: false }),
  ];
  const { outfits } = buildOutfits(soldOut, intent(), null);
  assert.equal(outfits.length, 0, "spec §96: never fabricate a result");
});

test("a catalog with only tops cannot make an outfit", () => {
  const topsOnly = Array.from({ length: 5 }, (_, i) => candidate(`t${i}`, "shirt"));
  const { outfits } = buildOutfits(topsOnly, intent(), null);
  assert.equal(outfits.length, 0);
});
