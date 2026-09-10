/**
 * Evaluation (spec §98-§101).
 *
 * The problem this solves: right now a change to a scoring weight either
 * improves recommendations or ruins them, and nothing distinguishes the
 * two. §134 states the requirement plainly — "No silent quality
 * regression."
 *
 * Three design decisions make this actually useful rather than
 * ceremonial:
 *
 * 1. It runs against a FIXTURE catalog, not a real merchant's. A
 *    benchmark whose inputs change is not a benchmark — the number would
 *    move for reasons nobody could attribute.
 *
 * 2. It runs with NO model keys. The deterministic engine is what these
 *    cases measure, so the score is reproducible and a regression points
 *    at a code change rather than at model variance. Model-dependent
 *    quality needs a different instrument.
 *
 * 3. Every failure carries an error code from §101's taxonomy, so
 *    "quality dropped" becomes "constraint_loss went from 0 to 14",
 *    which is a debuggable statement.
 */

import { Intent } from "./intent";
import { Outfit } from "./outfit";
import { Slot } from "./taxonomy";

/** Spec §98's case categories. */
export const EVAL_CATEGORIES = [
  "search", "similar", "style_this", "complete_the_look", "outfit",
  "compare", "refine", "budget", "negative_preference", "occasion",
  "brand_specific", "no_result",
] as const;
export type EvalCategory = (typeof EVAL_CATEGORIES)[number];

/** Spec §101's error taxonomy, verbatim. */
export const ERROR_CODES = [
  "wrong_category", "wrong_brand_style", "wrong_color", "wrong_silhouette",
  "wrong_fit", "wrong_formality", "wrong_occasion", "wrong_season",
  "wrong_material", "wrong_budget", "bad_outfit", "duplicate",
  "hallucinated_fact", "availability_error", "constraint_loss",
  "conversation_state_loss", "tenant_leak",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Spec §99's measured dimensions. */
export const EVAL_DIMENSIONS = [
  "category_correctness", "constraint_satisfaction", "brand_coherence",
  "fashion_coherence", "fact_accuracy", "availability_accuracy",
  "diversity", "latency",
] as const;
export type EvalDimension = (typeof EVAL_DIMENSIONS)[number];

export type EvalExpectation = {
  /** Every returned product must cost no more than this. */
  maxPrice?: number;
  /** Slots the answer must fill to count as an outfit. */
  requiredSlots?: Slot[];
  /** Products that must never appear — sold out, wrong tenant, banned. */
  forbiddenProductIds?: string[];
  /** Fits the shopper rejected; none may appear. */
  forbiddenFits?: string[];
  /** Formality band the pieces must sit within. */
  formalityRange?: [number, number];
  /** The honest answer is nothing at all. */
  expectNoResult?: boolean;
  minResults?: number;
  /** Returned options must differ from each other by at least this much. */
  minDiversity?: number;
  /** Constraints that must survive a follow-up (spec §40, §128). */
  preservesFromSession?: Partial<Intent>;
};

export type EvalCase = {
  id: string;
  category: EvalCategory;
  query: string;
  anchorProductId?: string;
  /** Prior session state, for refinement cases. */
  priorQuery?: string;
  expect: EvalExpectation;
  /** Why this case exists. Shown when it fails. */
  rationale: string;
};

export type CaseResult = {
  caseId: string;
  category: EvalCategory;
  passed: boolean;
  errors: ErrorCode[];
  detail: string[];
  latencyMs: number;
  resultCount: number;
};

export type EvalRunSummary = {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  byCategory: Record<string, { total: number; passed: number }>;
  byError: Record<string, number>;
  latency: { p50: number; p95: number; max: number };
};

/**
 * Judge one case's output.
 *
 * Returns every violated code rather than the first: a result can be
 * both over budget and unavailable, and knowing only the first would
 * hide half the regression.
 */
export function evaluateCase(
  testCase: EvalCase,
  outfits: Outfit[],
  intent: Intent,
  latencyMs: number,
): CaseResult {
  const errors: ErrorCode[] = [];
  const detail: string[] = [];
  const expect = testCase.expect;

  const pieces = outfits.flatMap((o) => o.pieces);

  if (expect.expectNoResult) {
    // §96: fabricating an answer is worse than admitting there isn't
    // one, so returning results here is the failure.
    if (outfits.length > 0) {
      errors.push("hallucinated_fact");
      detail.push(`expected no result, got ${outfits.length} outfits`);
    }
    return finish(testCase, errors, detail, latencyMs, outfits.length);
  }

  if (outfits.length < (expect.minResults ?? 1)) {
    errors.push("constraint_loss");
    detail.push(`expected at least ${expect.minResults ?? 1} results, got ${outfits.length}`);
    return finish(testCase, errors, detail, latencyMs, outfits.length);
  }

  if (expect.maxPrice !== undefined) {
    const over = pieces.filter((p) => p.price > expect.maxPrice!);
    if (over.length > 0) {
      errors.push("wrong_budget");
      detail.push(
        `${over.length} pieces over budget: ${over.map((p) => `${p.title} (${p.price})`).join(", ")}`,
      );
    }
  }

  const unavailable = pieces.filter((p) => !p.available);
  if (unavailable.length > 0) {
    // Always checked, on every case. A shopper discovering this at
    // checkout is the worst version of the failure.
    errors.push("availability_error");
    detail.push(`${unavailable.length} sold-out pieces recommended`);
  }

  if (expect.forbiddenProductIds?.length) {
    const found = pieces.filter((p) => expect.forbiddenProductIds!.includes(p.productId));
    if (found.length > 0) {
      errors.push("constraint_loss");
      detail.push(`forbidden products present: ${found.map((p) => p.productId).join(", ")}`);
    }
  }

  if (expect.forbiddenFits?.length) {
    const found = pieces.filter(
      (p) => p.profile.fit && expect.forbiddenFits!.includes(p.profile.fit),
    );
    if (found.length > 0) {
      errors.push("wrong_fit");
      detail.push(`rejected fits present: ${found.map((p) => p.profile.fit).join(", ")}`);
    }
  }

  if (expect.formalityRange) {
    const [min, max] = expect.formalityRange;
    const outside = pieces.filter(
      (p) => p.profile.formality !== null && (p.profile.formality < min || p.profile.formality > max),
    );
    if (outside.length > 0) {
      errors.push("wrong_formality");
      detail.push(`${outside.length} pieces outside formality ${min}-${max}`);
    }
  }

  if (expect.requiredSlots?.length) {
    for (const outfit of outfits) {
      const filled = new Set(Object.keys(outfit.slots));
      const missing = expect.requiredSlots.filter((s) => !filled.has(s));
      if (missing.length > 0) {
        errors.push("bad_outfit");
        detail.push(`outfit missing slots: ${missing.join(", ")}`);
        break;
      }
    }
  }

  // Duplicate pieces within a single outfit are always wrong.
  for (const outfit of outfits) {
    const ids = outfit.pieces.map((p) => p.productId);
    if (new Set(ids).size !== ids.length) {
      errors.push("duplicate");
      detail.push("an outfit contains the same product twice");
      break;
    }
  }

  if (expect.minDiversity !== undefined && outfits.length >= 2) {
    // §59: five options that differ by one accessory are one option.
    const overlaps: number[] = [];
    for (let i = 0; i < outfits.length; i++) {
      for (let j = i + 1; j < outfits.length; j++) {
        const a = new Set(outfits[i].pieces.map((p) => p.productId));
        const b = new Set(outfits[j].pieces.map((p) => p.productId));
        const shared = [...a].filter((id) => b.has(id)).length;
        overlaps.push(shared / Math.max(a.size, b.size));
      }
    }
    const meanOverlap = overlaps.reduce((s, o) => s + o, 0) / overlaps.length;
    if (1 - meanOverlap < expect.minDiversity) {
      errors.push("duplicate");
      detail.push(`options too similar: mean overlap ${meanOverlap.toFixed(2)}`);
    }
  }

  if (expect.preservesFromSession) {
    for (const [key, value] of Object.entries(expect.preservesFromSession)) {
      const actual = (intent as unknown as Record<string, unknown>)[key];
      if (JSON.stringify(actual) !== JSON.stringify(value)) {
        // §128: a follow-up must not discard what the shopper already
        // established.
        errors.push("conversation_state_loss");
        detail.push(`${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`);
      }
    }
  }

  return finish(testCase, errors, detail, latencyMs, outfits.length);
}

function finish(
  testCase: EvalCase,
  errors: ErrorCode[],
  detail: string[],
  latencyMs: number,
  resultCount: number,
): CaseResult {
  return {
    caseId: testCase.id,
    category: testCase.category,
    passed: errors.length === 0,
    errors: [...new Set(errors)],
    detail,
    latencyMs,
    resultCount,
  };
}

export function summarise(results: CaseResult[]): EvalRunSummary {
  const byCategory: Record<string, { total: number; passed: number }> = {};
  const byError: Record<string, number> = {};

  for (const result of results) {
    const bucket = (byCategory[result.category] ??= { total: 0, passed: 0 });
    bucket.total++;
    if (result.passed) bucket.passed++;
    for (const code of result.errors) byError[code] = (byError[code] ?? 0) + 1;
  }

  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const at = (q: number) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))] ?? 0;

  const passed = results.filter((r) => r.passed).length;
  return {
    total: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length === 0 ? 0 : passed / results.length,
    byCategory,
    byError,
    latency: { p50: at(0.5), p95: at(0.95), max: latencies[latencies.length - 1] ?? 0 },
  };
}

/** A readable report, for CI output and for the run record. */
export function formatSummary(summary: EvalRunSummary, results: CaseResult[]): string {
  const lines: string[] = [];
  lines.push(
    `${summary.passed}/${summary.total} passed (${(summary.passRate * 100).toFixed(1)}%)`,
  );
  lines.push("");
  lines.push("by category:");
  for (const [category, stats] of Object.entries(summary.byCategory).sort()) {
    const mark = stats.passed === stats.total ? "ok  " : "FAIL";
    lines.push(`  ${mark} ${category.padEnd(20)} ${stats.passed}/${stats.total}`);
  }

  if (Object.keys(summary.byError).length > 0) {
    lines.push("");
    lines.push("errors:");
    for (const [code, count] of Object.entries(summary.byError).sort((a, b) => b[1] - a[1])) {
      lines.push(`  ${String(count).padStart(3)}  ${code}`);
    }
  }

  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    lines.push("");
    lines.push("failures:");
    for (const failure of failures.slice(0, 20)) {
      lines.push(`  ${failure.caseId} [${failure.errors.join(", ")}]`);
      for (const d of failure.detail) lines.push(`      ${d}`);
    }
    if (failures.length > 20) lines.push(`  ... and ${failures.length - 20} more`);
  }

  lines.push("");
  lines.push(
    `latency p50 ${summary.latency.p50}ms  p95 ${summary.latency.p95}ms  max ${summary.latency.max}ms`,
  );
  return lines.join("\n");
}
