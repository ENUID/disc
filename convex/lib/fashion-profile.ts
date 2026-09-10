/**
 * The Disc intelligence layer for a product (spec §26, §27).
 *
 * Two rules govern this file, and both come from the spec:
 *
 *   "Never overwrite source facts with model inference."  (§26)
 *   "If not visible: unknown. Do not hallucinate."        (§32)
 *
 * So a fashion profile lives in its own table, never inside the product
 * row, and every inferred field carries where it came from, which model,
 * how confident, and when. Without that, "why did Disc recommend this?"
 * is unanswerable and a bad attribute is untraceable — which is exactly
 * the failure mode `Disc audit.md` flags as unfixable-after-the-fact.
 *
 * `null` is a first-class value here. It means "not established", and it
 * must survive all the way to scoring, where an unknown attribute is
 * scored as neutral rather than assumed.
 */

import {
  coerceTerm,
  ColorFamily,
  COLOR_FAMILIES,
  Drape,
  DRAPES,
  Fit,
  FITS,
  FORMALITY_MAX,
  FORMALITY_MIN,
  Garment,
  GARMENTS,
  OCCASIONS,
  Pattern,
  PatternScale,
  PATTERN_SCALES,
  PATTERNS,
  SEASONS,
  STYLES,
  Volume,
  VOLUMES,
  Weight,
  WEIGHTS,
} from "./taxonomy";

/** Where a value came from (spec §27). Ordered by how much it is trusted. */
export const PROVENANCE_SOURCES = [
  "merchant", // a human at the shop said so — highest authority
  "shopify", // structured source data
  "rule", // deterministic derivation from source data
  "text_model",
  "vision_model",
  "human", // our own reviewer
] as const;
export type ProvenanceSource = (typeof PROVENANCE_SOURCES)[number];

export type Provenance = {
  source: ProvenanceSource;
  model: string | null;
  confidence: number; // 0-1
  version: string;
  at: number;
};

/** A weighted vector over a vocabulary, e.g. {minimal: 0.8, classic: 0.6}. */
export type WeightedTags = Record<string, number>;

/**
 * The profile itself.
 *
 * Every field is nullable because every field can genuinely be
 * unestablished — a product with no image cannot have a visual weight,
 * and a two-word description cannot support a drape judgement.
 */
export type FashionProfile = {
  garment: Garment | null;
  fit: Fit | null;
  volume: Volume | null;
  silhouette: string | null;
  fabric: string | null;
  weight: Weight | null;
  drape: Drape | null;
  pattern: Pattern | null;
  patternScale: PatternScale | null;
  color: string | null;
  colorFamily: ColorFamily | null;
  formality: number | null; // 0-5
  styleVector: WeightedTags;
  occasionVector: WeightedTags;
  seasonVector: WeightedTags;
  logoLevel: number | null; // 0-1, how prominent branding is
  graphicLevel: number | null; // 0-1
  visualWeight: number | null; // 0-1, how much attention the piece commands
};

export const PROFILE_SCHEMA_VERSION = "profile_v1";

export function emptyProfile(): FashionProfile {
  return {
    garment: null, fit: null, volume: null, silhouette: null, fabric: null,
    weight: null, drape: null, pattern: null, patternScale: null,
    color: null, colorFamily: null, formality: null,
    styleVector: {}, occasionVector: {}, seasonVector: {},
    logoLevel: null, graphicLevel: null, visualWeight: null,
  };
}

function clamp01(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(1, n));
}

/**
 * Coerce a model's weighted-tag output onto the vocabulary.
 *
 * Out-of-vocabulary keys are dropped rather than kept, because a style
 * axis nothing else understands cannot participate in a comparison — it
 * would silently contribute zero while looking like data.
 */
function coerceWeighted(
  vocabulary: readonly string[],
  raw: unknown,
): WeightedTags {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: WeightedTags = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const term = coerceTerm(vocabulary, key);
    const weight = clamp01(value);
    if (term && weight !== null && weight > 0) out[term] = weight;
  }
  return out;
}

/**
 * Validate and coerce raw model output into a profile (spec §85).
 *
 * Never throws. Anything unparseable becomes null, which is a truthful
 * "we do not know" rather than a guess. Returns the profile alongside a
 * list of fields that were rejected, so a model that keeps failing one
 * field is visible rather than silently degrading every product.
 */
export function parseProfile(raw: unknown): {
  profile: FashionProfile;
  rejected: string[];
} {
  const profile = emptyProfile();
  const rejected: string[] = [];
  if (!raw || typeof raw !== "object") return { profile, rejected: ["<not an object>"] };

  const r = raw as Record<string, unknown>;
  const single = <T extends readonly string[]>(
    key: string,
    vocab: T,
  ): T[number] | null => {
    const value = r[key];
    if (value === undefined || value === null || value === "" || value === "unknown") {
      return null;
    }
    const term = coerceTerm(vocab, value);
    if (!term) rejected.push(key);
    return term;
  };

  profile.garment = single("garment", GARMENTS);
  profile.fit = single("fit", FITS);
  profile.volume = single("volume", VOLUMES);
  profile.weight = single("weight", WEIGHTS);
  profile.drape = single("drape", DRAPES);
  profile.pattern = single("pattern", PATTERNS);
  profile.patternScale = single("patternScale", PATTERN_SCALES);
  profile.colorFamily = single("colorFamily", COLOR_FAMILIES);

  // Free text, but bounded — a model that returns an essay here would
  // otherwise put it straight into a prompt later.
  const text = (key: string): string | null => {
    const value = r[key];
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!trimmed || trimmed.toLowerCase() === "unknown") return null;
    return trimmed.slice(0, 120);
  };
  profile.silhouette = text("silhouette");
  profile.fabric = text("fabric");
  profile.color = text("color");

  if (r.formality !== undefined && r.formality !== null) {
    const n = Number(r.formality);
    if (Number.isFinite(n) && n >= FORMALITY_MIN && n <= FORMALITY_MAX) {
      profile.formality = n;
    } else {
      rejected.push("formality");
    }
  }

  profile.styleVector = coerceWeighted(STYLES, r.styleVector);
  profile.occasionVector = coerceWeighted(OCCASIONS, r.occasionVector);
  profile.seasonVector = coerceWeighted(SEASONS, r.seasonVector);

  profile.logoLevel = clamp01(r.logoLevel);
  profile.graphicLevel = clamp01(r.graphicLevel);
  profile.visualWeight = clamp01(r.visualWeight);

  return { profile, rejected };
}

/**
 * Merge a new profile over an existing one, respecting provenance.
 *
 * A more-trusted source always wins. Between equal sources the newer
 * value wins. A null never overwrites a known value — losing an
 * established attribute because one run couldn't see the image would be
 * a silent regression.
 */
const SOURCE_RANK: Record<ProvenanceSource, number> = {
  merchant: 6, human: 5, shopify: 4, rule: 3, vision_model: 2, text_model: 1,
};

export function mergeProfiles(
  existing: { profile: FashionProfile; provenance: Record<string, Provenance> } | null,
  incoming: { profile: FashionProfile; provenance: Provenance },
): { profile: FashionProfile; provenance: Record<string, Provenance> } {
  if (!existing) {
    const provenance: Record<string, Provenance> = {};
    for (const key of Object.keys(incoming.profile)) {
      const value = (incoming.profile as Record<string, unknown>)[key];
      if (value !== null && !isEmptyVector(value)) provenance[key] = incoming.provenance;
    }
    return { profile: incoming.profile, provenance };
  }

  const merged: FashionProfile = { ...existing.profile };
  const provenance: Record<string, Provenance> = { ...existing.provenance };

  for (const key of Object.keys(incoming.profile) as (keyof FashionProfile)[]) {
    const value = incoming.profile[key];
    if (value === null || isEmptyVector(value)) continue;

    const current = provenance[key];
    const incomingRank = SOURCE_RANK[incoming.provenance.source];
    const currentRank = current ? SOURCE_RANK[current.source] : -1;

    if (incomingRank > currentRank) {
      (merged as Record<string, unknown>)[key] = value;
      provenance[key] = incoming.provenance;
    } else if (incomingRank === currentRank && incoming.provenance.at >= (current?.at ?? 0)) {
      (merged as Record<string, unknown>)[key] = value;
      provenance[key] = incoming.provenance;
    }
  }

  return { profile: merged, provenance };
}

function isEmptyVector(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 0
  );
}

/**
 * How complete a profile is, 0-1.
 *
 * Drives the catalog dashboard's "missing data / low confidence" counts
 * (spec §73) and lets ranking discount products it barely understands.
 */
export function profileCompleteness(profile: FashionProfile): number {
  const fields: unknown[] = [
    profile.garment, profile.fit, profile.volume, profile.weight,
    profile.drape, profile.pattern, profile.colorFamily, profile.formality,
    Object.keys(profile.styleVector).length > 0 ? true : null,
    Object.keys(profile.occasionVector).length > 0 ? true : null,
  ];
  const known = fields.filter((f) => f !== null && f !== undefined).length;
  return known / fields.length;
}
