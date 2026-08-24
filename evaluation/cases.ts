/**
 * Benchmark cases (spec §98).
 *
 * Written against `fixture-catalog.ts`, so every expectation refers to
 * products that actually exist and the answers are checkable rather than
 * impressionistic.
 *
 * The bias throughout is towards cases that *can fail*. A benchmark of
 * things that obviously work measures nothing; each case here targets a
 * specific way the engine could be wrong, and most of them target a
 * mistake that was actually made at some point in building it.
 */

import type { EvalCase } from "../convex/lib/evaluation";
import { SOLD_OUT_IDS } from "./fixture-catalog";

/**
 * Availability and budget are checked on every case by the evaluator, so
 * these are the cases that target them *specifically* — where the wrong
 * answer is tempting rather than incidental.
 */
const budgetCases: EvalCase[] = [
  {
    id: "budget-under-300",
    category: "budget",
    query: "an outfit under $300",
    expect: { maxPrice: 300, minResults: 1 },
    rationale: "A stated budget is a statement, not a preference (§47).",
  },
  {
    id: "budget-excludes-luxury",
    category: "budget",
    query: "a smart outfit under $500",
    expect: { maxPrice: 500, forbiddenProductIds: ["coat-cashmere-luxury"] },
    rationale:
      "The £2,400 coat is the strongest brand match in the catalog, so it is exactly what a ranker ignoring budget would surface.",
  },
  {
    id: "budget-very-tight",
    category: "budget",
    query: "something under $100",
    expect: { maxPrice: 100 },
    rationale:
      "Only the tee and the scarf qualify; the engine must return little or nothing rather than relaxing the constraint.",
  },
  {
    id: "budget-with-style",
    category: "budget",
    query: "a minimal outfit under $400",
    expect: { maxPrice: 400, minResults: 1 },
    rationale: "Budget and style together — neither may quietly override the other.",
  },
];

const availabilityCases: EvalCase[] = [
  {
    id: "availability-tailored-trouser",
    category: "search",
    query: "tailored charcoal wool flannel trouser",
    expect: { forbiddenProductIds: SOLD_OUT_IDS },
    rationale:
      "This query names the sold-out product almost exactly, so retrieval will rank it first. It must still never be recommended (§47).",
  },
  {
    id: "availability-formal-outfit",
    category: "outfit",
    query: "a formal tailored outfit for work",
    expect: { forbiddenProductIds: SOLD_OUT_IDS, minResults: 1 },
    rationale:
      "The sold-out trouser is the best formality match for this request; the engine must build the outfit without it.",
  },
];

const outfitCases: EvalCase[] = [
  {
    id: "outfit-complete-slots",
    category: "outfit",
    query: "a complete outfit for everyday wear",
    expect: { requiredSlots: ["top", "bottom"], minResults: 1 },
    rationale: "An outfit that is only a top is not an outfit (§56).",
  },
  {
    id: "outfit-dinner",
    category: "outfit",
    query: "something understated for dinner tonight",
    expect: { minResults: 1 },
    rationale:
      "Spec §135's worked example. Deliberately does NOT require top+bottom: the catalog has a dress, and a dress with shoes is a complete outfit — demanding both slots would have marked a correct answer wrong.",
  },
  {
    id: "outfit-no-duplicate-pieces",
    category: "outfit",
    query: "a smart outfit",
    expect: { minResults: 1 },
    rationale:
      "Duplicate detection runs on every case; this one exists so a slot-assignment bug surfaces here rather than in production.",
  },
  {
    id: "outfit-diversity",
    category: "outfit",
    query: "an everyday outfit",
    expect: { minResults: 2, minDiversity: 0.3 },
    rationale:
      "Two near-identical white shirts are in the catalog specifically so that returning both counts as a failure (§59).",
  },
];

const formalityCases: EvalCase[] = [
  {
    id: "formality-casual",
    category: "occasion",
    query: "a relaxed casual outfit for the weekend",
    expect: { formalityRange: [0, 3], minResults: 1 },
    rationale:
      "A black derby at formality 5 must not appear in a weekend outfit — the gap is the thing formality scoring exists to catch (§52).",
  },
  {
    id: "formality-formal",
    category: "occasion",
    query: "a formal outfit for a black tie adjacent event",
    expect: { formalityRange: [2, 5], minResults: 1 },
    rationale: "The graphic hoodie at formality 0 must not appear.",
  },
  {
    id: "occasion-work",
    category: "occasion",
    query: "something to wear to the office",
    expect: { minResults: 1, formalityRange: [1, 5] },
    rationale: "Occasion vectors should pull work-appropriate pieces forward.",
  },
];

const negativeCases: EvalCase[] = [
  {
    id: "negative-no-oversized",
    category: "negative_preference",
    query: "an outfit, nothing oversized",
    expect: { forbiddenFits: ["oversized"] },
    rationale:
      "A rejected fit is a hard constraint, not a ranking penalty (§47). The red hoodie is the only oversized piece.",
  },
  {
    id: "negative-no-streetwear",
    category: "negative_preference",
    query: "a smart outfit, nothing streetwear",
    expect: { forbiddenProductIds: ["hoodie-red-graphic"], minResults: 1 },
    rationale: "A rejected style must exclude the product that most embodies it.",
  },
  {
    id: "negative-avoid-skinny",
    category: "negative_preference",
    query: "trousers but not skinny",
    expect: { forbiddenFits: ["skinny"] },
    rationale: "Negation must survive parsing rather than being read as a positive.",
  },
];

const refineCases: EvalCase[] = [
  {
    id: "refine-cheaper-keeps-context",
    category: "refine",
    query: "make it cheaper",
    priorQuery: "a smart outfit for dinner under $600",
    expect: {
      maxPrice: 600,
      preservesFromSession: { occasion: "dinner" },
    },
    rationale:
      "§128 exactly: the follow-up must lower the budget while preserving the occasion. Re-parsing from scratch would lose it.",
  },
  {
    id: "refine-less-formal-keeps-budget",
    category: "refine",
    query: "make it less formal",
    priorQuery: "an outfit under $400",
    expect: { maxPrice: 400 },
    rationale:
      "A formality transform must not discard a budget the shopper already stated (§40).",
  },
];

const styleThisCases: EvalCase[] = [
  {
    id: "style-this-shirt",
    category: "style_this",
    query: "",
    anchorProductId: "shirt-white-oxford",
    expect: { minResults: 1, requiredSlots: ["bottom"] },
    rationale:
      "§136: styling a top must return something to wear with it, not more tops.",
  },
  {
    id: "style-this-dress",
    category: "style_this",
    query: "",
    anchorProductId: "dress-black-midi",
    expect: { minResults: 1 },
    rationale:
      "A dress occupies top and bottom at once; the outfit built around it must not also contain trousers.",
  },
  {
    id: "complete-look-trouser",
    category: "complete_the_look",
    query: "",
    anchorProductId: "trouser-navy-wool",
    expect: { minResults: 1, requiredSlots: ["top"] },
    rationale: "Completing a bottom must produce a top.",
  },
];

const searchCases: EvalCase[] = [
  {
    id: "search-white-shirt",
    category: "search",
    query: "white cotton shirt",
    expect: { minResults: 1 },
    rationale: "The simplest possible retrieval; if this fails, nothing else matters.",
  },
  {
    id: "search-wool-knit",
    category: "search",
    query: "fine merino wool knitwear",
    expect: { minResults: 1 },
    rationale: "Semantic match on material rather than exact title words.",
  },
  {
    id: "similar-loafer",
    category: "similar",
    query: "polished leather shoes",
    expect: { minResults: 1 },
    rationale: "Category-level retrieval across two products that share a type.",
  },
];

const brandCases: EvalCase[] = [
  {
    id: "brand-coherence-minimal",
    category: "brand_specific",
    query: "an outfit that feels like this brand",
    expect: { minResults: 1, forbiddenProductIds: ["hoodie-red-graphic"] },
    rationale:
      "The fixture brand is minimal/classic with streetwear at 0.05. §54: a fashion-valid outfit can still be wrong for the merchant.",
  },
];

const noResultCases: EvalCase[] = [
  {
    id: "no-result-impossible-budget",
    category: "no_result",
    query: "a complete outfit under $10",
    expect: { expectNoResult: true },
    rationale:
      "§96: never fabricate. Nothing in the catalog is under $10, so the honest answer is nothing.",
  },
  {
    id: "no-result-absent-category",
    category: "no_result",
    query: "a scuba wetsuit and diving fins under $20",
    expect: { expectNoResult: true },
    rationale:
      "The catalog has nothing like this at that price; returning a shirt anyway would be answering a question nobody asked.",
  },
];

const compareCases: EvalCase[] = [
  {
    id: "compare-two-shirts",
    category: "compare",
    query: "compare the white shirts",
    expect: { minResults: 1 },
    rationale:
      "COMPARE is a declared workflow (§43); this pins that the request at least routes and returns rather than erroring.",
  },
];

export const EVAL_CASES: EvalCase[] = [
  ...searchCases,
  ...budgetCases,
  ...availabilityCases,
  ...outfitCases,
  ...formalityCases,
  ...negativeCases,
  ...refineCases,
  ...styleThisCases,
  ...brandCases,
  ...noResultCases,
  ...compareCases,
];

/**
 * Query variations, to widen coverage without hand-writing every case.
 *
 * §98 asks for 100-300 cases. Hand-writing that many *distinct* checks
 * would mostly produce near-duplicates; instead the hand-written cases
 * above each target a specific failure, and these variations test that
 * the same guarantees hold across phrasings — which is where a
 * deterministic parser actually breaks.
 */
const PHRASINGS: Array<{ suffix: string; query: (base: string) => string }> = [
  { suffix: "plain", query: (q) => q },
  { suffix: "polite", query: (q) => `could you find me ${q}` },
  { suffix: "terse", query: (q) => q.replace(/^(a|an|some)\s+/i, "") },
  { suffix: "caps", query: (q) => q.toUpperCase() },
];

export function expandedCases(): EvalCase[] {
  const expanded: EvalCase[] = [...EVAL_CASES];

  // Only constraint-bearing cases are worth rephrasing: those are the
  // ones where a parser change could silently drop the constraint.
  const worthVarying = EVAL_CASES.filter(
    (c) =>
      c.query &&
      (c.expect.maxPrice !== undefined ||
        c.expect.forbiddenFits?.length ||
        c.expect.formalityRange),
  );

  for (const base of worthVarying) {
    for (const phrasing of PHRASINGS.slice(1)) {
      expanded.push({
        ...base,
        id: `${base.id}--${phrasing.suffix}`,
        query: phrasing.query(base.query),
        rationale: `${base.rationale} (phrasing: ${phrasing.suffix})`,
      });
    }
  }

  return expanded;
}
