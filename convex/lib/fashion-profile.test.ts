import { test } from "node:test";
import assert from "node:assert/strict";
import {
  emptyProfile,
  mergeProfiles,
  parseProfile,
  profileCompleteness,
  type Provenance,
} from "./fashion-profile";
import { coerceTerm, GARMENTS, isNeutral, slotForGarment, STYLES } from "./taxonomy";
import { enrichmentCacheKey } from "./enrichment-cache";
import { extractJson } from "./providers";

/**
 * The rule under test throughout: a model that returns something outside
 * the vocabulary has established nothing, and "nothing" must survive as
 * null rather than becoming a guess.
 */

test("coerceTerm tolerates formatting but not invention", () => {
  assert.equal(coerceTerm(STYLES, "smart_casual"), "smart_casual");
  assert.equal(coerceTerm(STYLES, "Smart Casual"), "smart_casual", "casing and spaces");
  assert.equal(coerceTerm(STYLES, "smart-casual"), "smart_casual", "hyphens");
  assert.equal(coerceTerm(GARMENTS, "T-Shirt"), "t-shirt", "the one hyphenated term");
  assert.equal(coerceTerm(GARMENTS, "T Shirt"), "t-shirt");
  // Plausible but outside the vocabulary — must not be admitted.
  assert.equal(coerceTerm(STYLES, "cottagecore"), null);
  assert.equal(coerceTerm(GARMENTS, "kaftan"), null);
  assert.equal(coerceTerm(STYLES, 42), null);
});

test("slotForGarment: a dress is neither top nor bottom", () => {
  assert.equal(slotForGarment("shirt"), "top");
  assert.equal(slotForGarment("jeans"), "bottom");
  assert.equal(slotForGarment("blazer"), "outerwear");
  assert.equal(slotForGarment("loafer"), "footwear");
  // Pairing a dress with trousers is a category error, not a taste call,
  // so it gets its own slot.
  assert.equal(slotForGarment("dress"), "onepiece");
  assert.equal(slotForGarment("jumpsuit"), "onepiece");
  assert.equal(slotForGarment("unknown-thing"), null);
  assert.equal(slotForGarment(null), null);
});

test("isNeutral", () => {
  assert.equal(isNeutral("navy"), true);
  assert.equal(isNeutral("beige"), true);
  assert.equal(isNeutral("red"), false);
  assert.equal(isNeutral(null), false);
});

test("parseProfile accepts a well-formed model answer", () => {
  const { profile, rejected } = parseProfile({
    garment: "sweater",
    fit: "relaxed",
    volume: "boxy",
    weight: "heavy",
    drape: "structured",
    pattern: "plain",
    patternScale: "none",
    colorFamily: "navy",
    color: "deep navy",
    fabric: "merino wool",
    silhouette: "dropped shoulder",
    formality: 2,
    styleVector: { minimal: 0.8, classic: 0.6 },
    occasionVector: { everyday: 0.9 },
    seasonVector: { winter: 0.8 },
    logoLevel: 0,
    graphicLevel: 0,
    visualWeight: 0.4,
  });

  assert.deepEqual(rejected, []);
  assert.equal(profile.garment, "sweater");
  assert.equal(profile.formality, 2);
  assert.deepEqual(profile.styleVector, { minimal: 0.8, classic: 0.6 });
});

test("parseProfile turns invention into null and reports it", () => {
  const { profile, rejected } = parseProfile({
    garment: "cape", // not in the vocabulary
    fit: "relaxed",
    formality: 9, // out of the 0-5 range
    styleVector: { minimal: 0.5, cottagecore: 0.9 },
  });

  assert.equal(profile.garment, null, "an invented garment is not stored");
  assert.equal(profile.formality, null, "an out-of-range score is not stored");
  assert.equal(profile.fit, "relaxed", "valid fields still survive");
  // An out-of-vocabulary style axis is dropped, not kept at zero —
  // nothing downstream could compare it.
  assert.deepEqual(profile.styleVector, { minimal: 0.5 });
  assert.ok(rejected.includes("garment"));
  assert.ok(rejected.includes("formality"));
});

test('parseProfile treats "unknown" and empty as not-established', () => {
  const { profile, rejected } = parseProfile({
    garment: "unknown",
    fit: null,
    fabric: "",
    drape: undefined,
  });
  assert.equal(profile.garment, null);
  assert.equal(profile.fabric, null);
  // Honest "I don't know" is not a rejection — it's the correct answer.
  assert.deepEqual(rejected, []);
});

test("parseProfile never throws on garbage", () => {
  assert.doesNotThrow(() => parseProfile(null));
  assert.doesNotThrow(() => parseProfile("a string"));
  assert.doesNotThrow(() => parseProfile([1, 2, 3]));
  assert.deepEqual(parseProfile(null).profile, emptyProfile());
});

test("parseProfile clamps 0-1 fields", () => {
  const { profile } = parseProfile({ logoLevel: 5, graphicLevel: -2, visualWeight: 0.5 });
  assert.equal(profile.logoLevel, 1);
  assert.equal(profile.graphicLevel, 0);
  assert.equal(profile.visualWeight, 0.5);
});

const prov = (source: Provenance["source"], at = 1000): Provenance => ({
  source,
  model: "test",
  confidence: 0.8,
  version: "v1",
  at,
});

test("mergeProfiles: a more-trusted source wins", () => {
  const base = mergeProfiles(null, {
    profile: { ...emptyProfile(), garment: "sweater", fit: "slim" },
    provenance: prov("text_model"),
  });

  const merged = mergeProfiles(base, {
    profile: { ...emptyProfile(), fit: "relaxed" },
    provenance: prov("merchant", 2000),
  });

  assert.equal(merged.profile.fit, "relaxed", "merchant beats text_model");
  assert.equal(merged.profile.garment, "sweater", "untouched fields survive");
  assert.equal(merged.provenance.fit.source, "merchant");
});

test("mergeProfiles: a less-trusted source does not overwrite", () => {
  const base = mergeProfiles(null, {
    profile: { ...emptyProfile(), fit: "relaxed" },
    provenance: prov("merchant", 1000),
  });

  const merged = mergeProfiles(base, {
    profile: { ...emptyProfile(), fit: "skinny" },
    provenance: prov("vision_model", 5000),
  });

  // Newer, but from a source the merchant outranks.
  assert.equal(merged.profile.fit, "relaxed");
  assert.equal(merged.provenance.fit.source, "merchant");
});

test("mergeProfiles: null never erases an established value", () => {
  const base = mergeProfiles(null, {
    profile: { ...emptyProfile(), garment: "sweater", colorFamily: "navy" },
    provenance: prov("vision_model"),
  });

  // A later run that couldn't see the image must not wipe what an
  // earlier one established.
  const merged = mergeProfiles(base, {
    profile: emptyProfile(),
    provenance: prov("vision_model", 9999),
  });

  assert.equal(merged.profile.garment, "sweater");
  assert.equal(merged.profile.colorFamily, "navy");
});

test("mergeProfiles: an empty vector does not erase a populated one", () => {
  const base = mergeProfiles(null, {
    profile: { ...emptyProfile(), styleVector: { minimal: 0.9 } },
    provenance: prov("text_model"),
  });
  const merged = mergeProfiles(base, {
    profile: emptyProfile(),
    provenance: prov("text_model", 9999),
  });
  assert.deepEqual(merged.profile.styleVector, { minimal: 0.9 });
});

test("profileCompleteness reflects what is actually known", () => {
  assert.equal(profileCompleteness(emptyProfile()), 0);
  const full = parseProfile({
    garment: "sweater", fit: "relaxed", volume: "boxy", weight: "heavy",
    drape: "structured", pattern: "plain", colorFamily: "navy", formality: 2,
    styleVector: { minimal: 1 }, occasionVector: { everyday: 1 },
  }).profile;
  assert.equal(profileCompleteness(full), 1);
});

test("cache key changes with evidence, prompt, schema and model", () => {
  const base = {
    title: "Wool Sweater",
    description: "A warm sweater.",
    tags: ["wool"],
    images: ["https://cdn/a.jpg"],
    schemaVersion: "profile_v1",
    promptVersion: "product_profile_v1",
    model: "m1",
  };
  const key = enrichmentCacheKey(base);

  assert.equal(key, enrichmentCacheKey({ ...base }), "deterministic");
  assert.notEqual(key, enrichmentCacheKey({ ...base, title: "Wool Jumper" }));
  assert.notEqual(key, enrichmentCacheKey({ ...base, images: ["https://cdn/b.jpg"] }));
  assert.notEqual(key, enrichmentCacheKey({ ...base, promptVersion: "product_profile_v2" }));
  assert.notEqual(key, enrichmentCacheKey({ ...base, schemaVersion: "profile_v2" }));
  assert.notEqual(key, enrichmentCacheKey({ ...base, model: "m2" }));
});

test("cache key ignores tag order but not tag content", () => {
  const base = {
    title: "t", description: "d", images: [],
    schemaVersion: "s", promptVersion: "p", model: "m",
  };
  assert.equal(
    enrichmentCacheKey({ ...base, tags: ["a", "b"] }),
    enrichmentCacheKey({ ...base, tags: ["b", "a"] }),
    "reordering tags must not force a re-enrichment",
  );
  assert.notEqual(
    enrichmentCacheKey({ ...base, tags: ["a", "b"] }),
    enrichmentCacheKey({ ...base, tags: ["a", "c"] }),
  );
});

test("cache key is 64-bit", () => {
  const key = enrichmentCacheKey({
    title: "t", description: "d", tags: [], images: [],
    schemaVersion: "s", promptVersion: "p", model: "m",
  });
  // A 32-bit key collides at ~1-in-65k by the birthday bound, and a
  // collision here serves one product's attributes for another.
  assert.equal(key.length, 16);
});

test("extractJson recovers an object from prose and fences", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go:\n{"a":1}\nHope that helps.'), { a: 1 });
  assert.equal(extractJson("no json here"), null);
  assert.equal(extractJson(""), null);
  // A bare array is not a profile object.
  assert.deepEqual(extractJson("[1,2]"), [1, 2]);
});

/**
 * The rule-derived fallback. This is what a deployment with no model key
 * still produces, so it has to be genuinely useful rather than empty.
 */
import { ruleDerivedProfile } from "../enrichment";

test("ruleDerivedProfile finds a garment from title, type or tags", () => {
  assert.equal(
    ruleDerivedProfile({ title: "Merino Wool Sweater", productType: "", colour: "", tags: [] })
      .garment,
    "sweater",
  );
  assert.equal(
    ruleDerivedProfile({ title: "Classic", productType: "Jeans", colour: "", tags: [] }).garment,
    "jeans",
  );
  assert.equal(
    ruleDerivedProfile({ title: "The Everyday", productType: "", colour: "", tags: ["loafer"] })
      .garment,
    "loafer",
  );
});

test("ruleDerivedProfile matches plurals but not substrings", () => {
  assert.equal(
    ruleDerivedProfile({ title: "Wool Trousers", productType: "", colour: "", tags: [] }).garment,
    "trouser",
    "plural form",
  );
  // "bootcut" is a jeans cut, not a boot — a substring match would call
  // this footwear and put it in the wrong outfit slot entirely.
  assert.notEqual(
    ruleDerivedProfile({ title: "Bootcut Denim", productType: "", colour: "", tags: [] }).garment,
    "boot",
  );
});

test("ruleDerivedProfile reads a colour family from the variant colour", () => {
  const p = ruleDerivedProfile({
    title: "Overshirt",
    productType: "",
    colour: "Deep Navy",
    tags: [],
  });
  assert.equal(p.colorFamily, "navy");
  assert.equal(p.color, "Deep Navy", "the raw value is kept alongside the family");
});

test("ruleDerivedProfile establishes nothing rather than guessing", () => {
  const p = ruleDerivedProfile({ title: "Item 4471", productType: "", colour: "", tags: [] });
  assert.equal(p.garment, null);
  assert.equal(p.colorFamily, null);
  assert.equal(p.formality, null, "formality is never guessed from a title");
});
