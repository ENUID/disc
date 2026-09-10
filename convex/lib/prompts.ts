/**
 * Prompt registry (spec §84).
 *
 * Every prompt is named, versioned, and lives here — not inline in a
 * route, which is what the spec forbids and what the Python prototype
 * did (two prompts buried in `server.py`, unversioned, so a wording
 * change was invisible in the response and untraceable afterwards).
 *
 * The version string is recorded on every model response and on every
 * recommendation trace. That is what makes "did quality drop because of
 * the prompt or the model?" answerable rather than a guess.
 *
 * **Bump the version when you change a prompt.** Cached enrichment keys
 * include it, so a bump invalidates exactly the work that prompt
 * produced and nothing else.
 */

export const PROMPT_VERSIONS = {
  productProfile: "product_profile_v1",
  productProfileVision: "product_profile_vision_v1",
  brandExtract: "brand_extract_v1",
  intentParse: "intent_parse_v1",
  outfitJudge: "outfit_judge_v1",
  explanation: "explanation_v1",
} as const;

/**
 * Shared framing for every extraction prompt.
 *
 * The "unknown" instruction is load-bearing: spec §32 forbids
 * hallucinating hidden garment properties, and a model asked to fill a
 * schema will invent plausible values unless explicitly permitted not
 * to. Every downstream score treats null as neutral, so an honest
 * "unknown" is genuinely better than a confident guess.
 */
const EXTRACTION_RULES = `You extract structured fashion attributes.

Rules:
- Answer ONLY with a single JSON object. No prose, no code fences.
- Use exactly the vocabulary given. Never invent a term.
- If an attribute is not established by the evidence, use null.
- Never guess a hidden property (fabric composition, care, provenance)
  that the evidence does not show.
- Confidence should reflect the evidence, not your fluency.`;

export const productProfileSystem = EXTRACTION_RULES;

export function productProfileUser(input: {
  title: string;
  description: string;
  productType: string;
  tags: string[];
  vocabulary: Record<string, readonly string[]>;
}): string {
  return `Product:
title: ${input.title}
type: ${input.productType || "unspecified"}
tags: ${input.tags.join(", ") || "none"}
description: ${input.description.slice(0, 1200) || "none"}

Allowed vocabulary:
${Object.entries(input.vocabulary)
  .map(([field, terms]) => `${field}: ${terms.join(" | ")}`)
  .join("\n")}

Return JSON with these keys:
{
  "garment": <garment term or null>,
  "fit": <fit term or null>,
  "volume": <volume term or null>,
  "silhouette": <short phrase or null>,
  "fabric": <short phrase or null>,
  "weight": <weight term or null>,
  "drape": <drape term or null>,
  "pattern": <pattern term or null>,
  "patternScale": <pattern scale term or null>,
  "color": <short phrase or null>,
  "colorFamily": <colour family term or null>,
  "formality": <0-5 or null>,
  "styleVector": { <style term>: <0-1>, ... },
  "occasionVector": { <occasion term>: <0-1>, ... },
  "seasonVector": { <season term>: <0-1>, ... },
  "logoLevel": <0-1 or null>,
  "graphicLevel": <0-1 or null>,
  "visualWeight": <0-1 or null>,
  "confidence": <0-1>
}`;
}

/**
 * Vision extraction.
 *
 * Restricted to what is *visible* (spec §32). The model is told what it
 * cannot know from a photograph, because otherwise it reliably reports
 * fabric composition and weight from a flat product shot.
 */
export const productProfileVisionSystem = `${EXTRACTION_RULES}

You are looking at product photography. Report only what the image
shows: garment type, apparent fit and volume, silhouette, pattern and
its scale, colour, how much visual attention the piece commands, and how
prominent any logo or graphic is.

You cannot see fabric composition, weight or care instructions from a
photograph. If the image does not establish an attribute, return null
for it.`;

export function productProfileVisionUser(input: {
  title: string;
  vocabulary: Record<string, readonly string[]>;
}): string {
  return `The product is titled "${input.title}".

Allowed vocabulary:
${Object.entries(input.vocabulary)
  .map(([field, terms]) => `${field}: ${terms.join(" | ")}`)
  .join("\n")}

Return the same JSON shape as the text extractor, with null for anything
the image does not establish.`;
}

/**
 * Brand extraction (spec §19, §20, §23).
 *
 * Given aggregate statistics rather than raw products — the model's job
 * is to characterise a brand from evidence we computed, not to read a
 * catalog. That keeps the call small, cheap and reproducible, and it
 * means the numeric parts of the Brand Brain are deterministic rather
 * than a model's impression.
 */
export const brandExtractSystem = `You characterise a fashion brand from
statistics about its own catalog.

Rules:
- Answer ONLY with a single JSON object. No prose, no code fences.
- Base every statement on the statistics given. Do not use outside
  knowledge about any brand, even if you recognise the name.
- Weights must reflect the distribution you were shown.
- If the evidence does not support a characterisation, use null.`;

export function brandExtractUser(input: {
  shopDomain: string;
  productCount: number;
  topCategories: Array<[string, number]>;
  topGarments: Array<[string, number]>;
  topColorFamilies: Array<[string, number]>;
  topFits: Array<[string, number]>;
  formalityHistogram: number[];
  priceRange: { min: number; max: number; median: number; currency: string };
  sampleTitles: string[];
  styleVocabulary: readonly string[];
}): string {
  return `Catalog statistics for ${input.shopDomain} (${input.productCount} products):

categories: ${input.topCategories.map(([k, v]) => `${k} (${v})`).join(", ") || "none"}
garments: ${input.topGarments.map(([k, v]) => `${k} (${v})`).join(", ") || "none"}
colour families: ${input.topColorFamilies.map(([k, v]) => `${k} (${v})`).join(", ") || "none"}
fits: ${input.topFits.map(([k, v]) => `${k} (${v})`).join(", ") || "none"}
formality histogram (0-5): ${input.formalityHistogram.join(", ")}
price: ${input.priceRange.min}-${input.priceRange.max} ${input.priceRange.currency} (median ${input.priceRange.median})

Example product titles:
${input.sampleTitles.slice(0, 25).map((t) => `- ${t}`).join("\n")}

Allowed style terms: ${input.styleVocabulary.join(" | ")}

Return JSON:
{
  "styleVector": { <style term>: <0-1>, ... },
  "voice": {
    "tone": [<up to 3 short adjectives>],
    "preferredTerms": [<up to 6 words this brand would use>],
    "avoidTerms": [<up to 6 words this brand would not use>]
  },
  "summary": "<one sentence a merchant would recognise as their brand>",
  "confidence": <0-1>
}`;
}

/**
 * Intent parsing, for the ambiguous half (spec §38).
 *
 * Only reached when the deterministic parser left residue it could not
 * account for — "something expensive-looking without looking flashy"
 * carries real constraints that no keyword table will catch. The model
 * is told what was already understood so it fills gaps rather than
 * re-deciding settled facts: an explicit "under $300" is more reliably
 * read by the parser than re-derived by a model.
 */
export const intentParseSystem = `You translate a shopper's clothing
request into structured constraints.

Rules:
- Answer ONLY with a single JSON object. No prose, no code fences.
- Use only the vocabulary given. Never invent a term.
- Omit any field the request does not establish. Do not guess.
- Read implied meaning: "nothing flashy" is a negative style constraint,
  "for a dinner" is an occasion, "smart but not stuffy" is a formality
  range.`;

export function intentParseUser(input: {
  query: string;
  residue: string[];
}): string {
  return `Shopper said: "${input.query}"

A keyword parser could not account for these words: ${input.residue.join(", ") || "none"}

Return JSON with only the keys you can establish:
{
  "workflow": "PRODUCT_SEARCH" | "SIMILAR" | "STYLE_PRODUCT" | "COMPLETE_LOOK" | "OUTFIT" | "COMPARE" | "REFINE",
  "occasion": <occasion term>,
  "formality": <0-5>,
  "stylePositive": [<style terms>],
  "styleNegative": [<style terms the shopper is rejecting>],
  "fitNegative": [<fit terms the shopper is rejecting>],
  "colors": [<colour family terms>]
}`;
}

/**
 * The judge (spec §57, §58).
 *
 * Deliberately a separate call from generation. Asking a generator to
 * explain why its own output is good produces justification, not
 * evaluation — §58 is explicit that the generator creates and the judge
 * challenges.
 */
export const outfitJudgeSystem = `You are a critical fashion editor
evaluating an outfit assembled from one brand's catalog.

Rules:
- Answer ONLY with a single JSON object. No prose, no code fences.
- Judge only the pieces given. Never invent or suggest a product that is
  not listed.
- Score each dimension 0-1. Be willing to score low.
- List concrete issues. An outfit with no issues should be rare.`;

export function outfitJudgeUser(input: {
  request: string;
  brandSummary: string;
  pieces: Array<{ slot: string; title: string; attributes: string }>;
}): string {
  return `Shopper asked for: ${input.request || "no specific request"}

Brand context: ${input.brandSummary || "none available"}

Outfit:
${input.pieces.map((p) => `- ${p.slot}: ${p.title} (${p.attributes})`).join("\n")}

Return JSON:
{
  "overall": <0-1>,
  "color": <0-1>,
  "silhouette": <0-1>,
  "formality": <0-1>,
  "style": <0-1>,
  "occasion": <0-1>,
  "brand": <0-1>,
  "shopperFit": <0-1>,
  "issues": [<short strings>],
  "confidence": <0-1>
}`;
}

/**
 * Explanation (spec §60).
 *
 * Given the actual score components, not the products alone — "do not
 * invent reasons" is only enforceable if the model is handed the real
 * evidence and told to use it.
 */
export const explanationSystem = `You write one or two sentences
explaining why an outfit works, for a shopper on a fashion storefront.

Rules:
- Use only the evidence given. Never invent a reason.
- Never mention scores, numbers, or that you are an AI.
- Match the brand's voice if one is given.
- Be specific about the pieces. Avoid generic praise.`;

export function explanationUser(input: {
  request: string;
  pieces: Array<{ slot: string; title: string }>;
  evidence: string[];
  voice: { tone: string[]; preferredTerms: string[]; avoidTerms: string[] } | null;
}): string {
  const voice = input.voice
    ? `\nBrand voice: ${input.voice.tone.join(", ")}. Prefer: ${input.voice.preferredTerms.join(", ")}. Avoid: ${input.voice.avoidTerms.join(", ")}.`
    : "";
  return `Shopper asked for: ${input.request || "no specific request"}

Pieces:
${input.pieces.map((p) => `- ${p.slot}: ${p.title}`).join("\n")}

Why these work together (actual scoring evidence):
${input.evidence.map((e) => `- ${e}`).join("\n")}${voice}

Write the explanation. Plain text, no JSON.`;
}
