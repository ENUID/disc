import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyFollowUp,
  emptyIntent,
  parseIntent,
  parseModelIntent,
  type Intent,
} from "./intent";

/**
 * The rule under test throughout is spec §38's last line: the
 * deterministic path must never discard meaningful semantic residue. A
 * parser that silently drops what it didn't understand looks like it
 * worked and answers the wrong question.
 */

test("a fully explicit query is parsed without needing a model", () => {
  const { intent, residue, needsReasoning } = parseIntent("black linen shirt under $100");
  assert.deepEqual(intent.colors, ["black"]);
  assert.deepEqual(intent.garments, ["shirt"]);
  assert.deepEqual(intent.budget, { amount: 100, currency: "USD" });
  // "linen" is a fabric, which this parser does not model — so it is
  // residue, and residue means escalate.
  assert.ok(residue.includes("linen"));
  assert.equal(needsReasoning, true);
});

test("a query with nothing left over does not escalate", () => {
  const { residue, needsReasoning } = parseIntent("black shirt under $100");
  assert.deepEqual(residue, []);
  assert.equal(needsReasoning, false, "no residue, no model call needed");
});

test("an ambiguous query escalates rather than being half-understood", () => {
  // The exact §38 example. A keyword parser would extract nothing and
  // could easily report success.
  const { intent, needsReasoning, residue } = parseIntent(
    "I want something expensive-looking without looking flashy",
  );
  assert.equal(needsReasoning, true);
  assert.ok(residue.length > 0);
  assert.equal(intent.budget, null, "nothing is invented");
});

test("stopwords alone never trigger escalation", () => {
  const { needsReasoning } = parseIntent("I need a shirt please");
  assert.equal(needsReasoning, false);
});

test("budget parses symbols, words and thousands separators", () => {
  assert.deepEqual(parseIntent("shirt under $100").intent.budget, {
    amount: 100,
    currency: "USD",
  });
  assert.deepEqual(parseIntent("coat under £1,200").intent.budget, {
    amount: 1200,
    currency: "GBP",
  });
  assert.deepEqual(parseIntent("dress €80").intent.budget, { amount: 80, currency: "EUR" });
  assert.deepEqual(parseIntent("jacket under 250").intent.budget, {
    amount: 250,
    currency: null,
  });
  assert.equal(parseIntent("a nice shirt").intent.budget, null);
});

test("negation flips the sense of what follows it", () => {
  const { intent } = parseIntent("trousers but not skinny");
  assert.deepEqual(intent.fitNegative, ["skinny"]);
  assert.deepEqual(intent.garments, ["trouser"]);
});

test("negated styles go to the negative list, not the positive one", () => {
  const { intent } = parseIntent("a jacket, not streetwear");
  assert.deepEqual(intent.styleNegative, ["streetwear"]);
  assert.deepEqual(intent.stylePositive, []);
});

test("synonyms normalise so they can be compared", () => {
  assert.deepEqual(parseIntent("grey jumper").intent.garments, ["sweater"]);
  assert.deepEqual(parseIntent("gray trainers").intent.colors, ["grey"]);
  assert.deepEqual(parseIntent("trainers").intent.garments, ["sneaker"]);
  assert.deepEqual(parseIntent("baggy jeans").intent.garments, ["jeans"]);
  assert.deepEqual(parseIntent("no baggy jeans").intent.fitNegative, ["relaxed"]);
});

test("occasions map onto the controlled vocabulary", () => {
  assert.equal(parseIntent("something for dinner").intent.occasion, "dinner");
  assert.equal(parseIntent("outfit for the office").intent.occasion, "work");
  assert.equal(parseIntent("beach holiday shirt").intent.occasion, "travel");
});

test("parseModelIntent never overrides what the parser established", () => {
  const base: Intent = {
    ...emptyIntent("black shirt under $100"),
    budget: { amount: 100, currency: "USD" },
    occasion: "dinner",
  };
  const merged = parseModelIntent(
    { budget: { amount: 500, currency: "EUR" }, occasion: "party", workflow: "OUTFIT" },
    base,
  );
  // An explicit "$100" beats a model's reading of the same sentence.
  assert.deepEqual(merged.budget, { amount: 100, currency: "USD" });
  assert.equal(merged.occasion, "dinner");
  // Workflow is the model's to decide — the parser never sets it.
  assert.equal(merged.workflow, "OUTFIT");
});

test("parseModelIntent fills only what is missing", () => {
  const base = emptyIntent("something understated for dinner");
  const merged = parseModelIntent(
    { occasion: "dinner", formality: 3, stylePositive: ["minimal"], workflow: "OUTFIT" },
    base,
  );
  assert.equal(merged.occasion, "dinner");
  assert.equal(merged.formality, 3);
  assert.deepEqual(merged.stylePositive, ["minimal"]);
});

test("parseModelIntent rejects invention", () => {
  const merged = parseModelIntent(
    {
      workflow: "TELEPORT",
      occasion: "moon_landing",
      formality: 99,
      stylePositive: ["cottagecore"],
      budget: { amount: -5 },
    },
    emptyIntent("x"),
  );
  assert.equal(merged.workflow, "PRODUCT_SEARCH", "unknown workflow falls back");
  assert.equal(merged.occasion, null);
  assert.equal(merged.formality, null);
  assert.deepEqual(merged.stylePositive, []);
  assert.equal(merged.budget, null, "a negative budget is not a budget");
});

test("parseModelIntent survives garbage", () => {
  const base = emptyIntent("x");
  assert.deepEqual(parseModelIntent(null, base), base);
  assert.deepEqual(parseModelIntent("nope", base), base);
  assert.deepEqual(parseModelIntent([], base), base);
});

const session = (over: Partial<Intent> = {}): Intent => ({
  ...emptyIntent("a relaxed dinner outfit under $300"),
  occasion: "dinner",
  formality: 2,
  budget: { amount: 300, currency: "USD" },
  stylePositive: ["minimal"],
  locked: { top: "p1", bottom: "p2", footwear: "p3" } as Record<string, string>,
  ...over,
});

test('"make it cheaper" lowers budget and keeps everything else', () => {
  const next = applyFollowUp(session(), "make it cheaper")!;
  assert.equal(next.budget!.amount, 210);
  // Losing these is §101's constraint_loss.
  assert.equal(next.occasion, "dinner");
  assert.equal(next.formality, 2);
  assert.deepEqual(next.stylePositive, ["minimal"]);
  assert.equal(next.workflow, "REFINE");
});

test('"make it cheaper" with no budget escalates rather than inventing one', () => {
  const result = applyFollowUp(session({ budget: null }), "make it cheaper");
  assert.equal(result, null, "no number was ever given, so none is guessed");
});

test('"less formal" lowers formality and preserves the rest', () => {
  const next = applyFollowUp(session(), "make it less formal")!;
  assert.equal(next.formality, 1);
  assert.deepEqual(next.budget, { amount: 300, currency: "USD" });
  assert.equal(next.occasion, "dinner");
});

test("formality transforms clamp at the ends of the scale", () => {
  assert.equal(applyFollowUp(session({ formality: 0 }), "less formal")!.formality, 0);
  assert.equal(applyFollowUp(session({ formality: 5 }), "more formal")!.formality, 5);
});

test('"change the shoes" locks every other slot', () => {
  const next = applyFollowUp(session(), "change the shoes")!;
  assert.equal(next.targetSlot, "footwear");
  // Checked before the deepEqual below: Node types deepEqual as an
  // assertion function, so it narrows `locked` to the expected shape and
  // a later `.footwear` access stops type-checking.
  assert.equal(next.locked.footwear, undefined, "the target is released");
  // Spec §61: lock all non-target slots, search only the target.
  assert.deepEqual(next.locked, { top: "p1", bottom: "p2" });
  assert.equal(next.workflow, "REFINE");
});

test("slot swap recognises the words shoppers actually use", () => {
  for (const [utterance, slot] of [
    ["change the shoes", "footwear"],
    ["swap the shoe", "footwear"],
    ["different trousers", "bottom"],
    ["another jacket", "outerwear"],
    ["replace the top", "top"],
  ] as const) {
    assert.equal(applyFollowUp(session(), utterance)?.targetSlot, slot, utterance);
  }
});

test("an unrecognised follow-up escalates rather than guessing", () => {
  assert.equal(applyFollowUp(session(), "hmm what about something else entirely"), null);
  assert.equal(applyFollowUp(session(), "change the vibe"), null);
});

test("a follow-up never mutates the session it was given", () => {
  const original = session();
  const snapshot = JSON.parse(JSON.stringify(original));
  applyFollowUp(original, "change the shoes");
  applyFollowUp(original, "make it cheaper");
  assert.deepEqual(original, snapshot, "transforms must be pure");
});
