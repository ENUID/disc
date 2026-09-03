import { test } from "node:test";
import assert from "node:assert/strict";
import {
  aggregateStyleVector,
  canDeriveBrand,
  computeBrandStats,
  deriveFormalityBand,
  derivePalette,
} from "./brand-stats";
import { emptyProfile, type FashionProfile } from "./fashion-profile";
import { blendStyleVectors, parseVoice } from "../brand";

const profile = (over: Partial<FashionProfile>): FashionProfile => ({
  ...emptyProfile(),
  ...over,
});

const product = (over: Partial<{ title: string; productType: string; price: number }>) => ({
  title: "Item",
  productType: "Tops",
  price: 100,
  currency: "GBP",
  tags: [],
  ...over,
});

test("computeBrandStats counts what it can count", () => {
  const stats = computeBrandStats(
    [
      product({ productType: "Tops", price: 80 }),
      product({ productType: "Tops", price: 120 }),
      product({ productType: "Trousers", price: 200 }),
    ],
    [
      profile({ garment: "shirt", colorFamily: "navy", formality: 2 }),
      profile({ garment: "shirt", colorFamily: "white", formality: 2 }),
      profile({ garment: "trouser", colorFamily: "navy", formality: 3 }),
    ],
  );

  assert.equal(stats.productCount, 3);
  assert.deepEqual(stats.topCategories[0], ["Tops", 2]);
  assert.deepEqual(stats.topGarments[0], ["shirt", 2]);
  assert.equal(stats.priceRange.min, 80);
  assert.equal(stats.priceRange.max, 200);
  assert.equal(stats.priceRange.median, 120);
  assert.equal(stats.priceRange.currency, "GBP");
  assert.equal(stats.formalityHistogram[2], 2);
  assert.equal(stats.formalityHistogram[3], 1);
  assert.equal(stats.coverage, 1);
});

test("tallies break ties deterministically", () => {
  // Same catalog must always produce the same statistics, or a Brand
  // Brain shifts between identical runs and nothing is reproducible.
  const build = () =>
    computeBrandStats(
      [product({ productType: "Zed" }), product({ productType: "Alpha" })],
      [],
    ).topCategories;
  assert.deepEqual(build(), build());
  assert.deepEqual(build()[0], ["Alpha", 1], "alphabetical on equal counts");
});

test("aggregateStyleVector normalises to the strongest axis", () => {
  // Every product weakly minimal IS a minimal brand — without
  // normalising this reads as "barely any identity".
  const v = aggregateStyleVector([
    profile({ styleVector: { minimal: 0.3, classic: 0.15 } }),
    profile({ styleVector: { minimal: 0.3, classic: 0.15 } }),
  ]);
  assert.equal(v.minimal, 1);
  assert.equal(v.classic, 0.5);
});

test("aggregateStyleVector drops noise", () => {
  const products = Array.from({ length: 100 }, () =>
    profile({ styleVector: { minimal: 1 } }),
  );
  products.push(profile({ styleVector: { avant_garde: 1 } }));
  const v = aggregateStyleVector(products);
  assert.equal(v.minimal, 1);
  // One product in a hundred is not part of the brand's identity.
  assert.equal(v.avant_garde, undefined);
});

test("aggregateStyleVector ignores products with no style vector", () => {
  const v = aggregateStyleVector([
    profile({ styleVector: { minimal: 0.8 } }),
    profile({}),
    profile({}),
  ]);
  // Averaged over contributors, not over the whole catalog — otherwise
  // an unenriched catalog dilutes the identity toward zero.
  assert.equal(v.minimal, 1);
});

test("aggregateStyleVector on an empty catalog is empty, not a guess", () => {
  assert.deepEqual(aggregateStyleVector([]), {});
  assert.deepEqual(aggregateStyleVector([profile({}), profile({})]), {});
});

test("derivePalette reports shares", () => {
  const palette = derivePalette([
    profile({ colorFamily: "navy" }),
    profile({ colorFamily: "navy" }),
    profile({ colorFamily: "beige" }),
    profile({ colorFamily: "white" }),
  ]);
  assert.equal(palette[0].family, "navy");
  assert.equal(palette[0].share, 0.5);
  assert.equal(palette.length, 3);
});

test("deriveFormalityBand describes a range, not a misleading mean", () => {
  // A brand selling t-shirts and dinner jackets has a mean of "smart
  // casual" and sells almost nothing there.
  const profiles = [
    ...Array.from({ length: 10 }, () => profile({ formality: 0 })),
    ...Array.from({ length: 10 }, () => profile({ formality: 5 })),
  ];
  const band = deriveFormalityBand(profiles)!;
  assert.equal(band.min, 0);
  assert.equal(band.max, 5);
});

test("deriveFormalityBand returns null when nothing is established", () => {
  assert.equal(deriveFormalityBand([]), null);
  assert.equal(deriveFormalityBand([profile({}), profile({})]), null);
});

test("canDeriveBrand refuses on a thin or unprofiled catalog", () => {
  const thin = computeBrandStats(
    [product({}), product({})],
    [profile({ garment: "shirt" }), profile({ garment: "shirt" })],
  );
  assert.equal(canDeriveBrand(thin), false, "too few products");

  const unprofiled = computeBrandStats(
    Array.from({ length: 50 }, () => product({})),
    [profile({ garment: "shirt" })],
  );
  // 2% coverage would produce a confident, wrong characterisation that
  // the merchant would believe because it looks specific.
  assert.equal(canDeriveBrand(unprofiled), false, "coverage too low");

  const ok = computeBrandStats(
    Array.from({ length: 50 }, () => product({})),
    Array.from({ length: 25 }, () => profile({ garment: "shirt" })),
  );
  assert.equal(canDeriveBrand(ok), true);
});

test("blendStyleVectors averages arithmetic and interpretation", () => {
  const blended = blendStyleVectors({ minimal: 1, classic: 0.4 }, { minimal: 0.6, streetwear: 0.8 });
  assert.equal(blended.minimal, 0.8);
  assert.equal(blended.classic, 0.2);
  assert.equal(blended.streetwear, 0.4);
});

test("blendStyleVectors drops what neither source rates", () => {
  const blended = blendStyleVectors({ sport: 0.04 }, {});
  assert.equal(blended.sport, undefined);
});

test("parseVoice keeps only usable strings and caps length", () => {
  const voice = parseVoice({
    tone: ["quiet", "warm", "editorial", "extra", "more"],
    preferredTerms: ["collection", "piece", 42, "", "look"],
    avoidTerms: ["cheap"],
  })!;
  assert.equal(voice.tone.length, 3, "capped");
  assert.deepEqual(voice.preferredTerms, ["collection", "piece", "look"], "non-strings dropped");
  assert.deepEqual(voice.avoidTerms, ["cheap"]);
});

test("parseVoice returns null rather than an empty shell", () => {
  assert.equal(parseVoice(null), null);
  assert.equal(parseVoice("nope"), null);
  assert.equal(parseVoice({ tone: [], preferredTerms: [], avoidTerms: [] }), null);
});

test("sampleTitles spreads across the catalog", () => {
  const products = Array.from({ length: 100 }, (_, i) => product({ title: `P${i}` }));
  const stats = computeBrandStats(products, []);
  assert.equal(stats.sampleTitles.length, 25);
  assert.equal(stats.sampleTitles[0], "P0");
  // Not the first 25 — the model should see the brand's range.
  assert.notEqual(stats.sampleTitles[24], "P24");
});
