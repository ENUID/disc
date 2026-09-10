/**
 * Controlled fashion vocabulary (spec §28).
 *
 * Why a closed vocabulary at all: every downstream score — compatibility,
 * formality gaps, silhouette pairing, diversity — compares attributes
 * across products. Free-text attributes make that impossible, because
 * "relaxed fit" and "loose" and "easy" would be three incomparable
 * values. A model that returns a term outside this list is treated as
 * having returned nothing rather than having invented a category.
 *
 * These lists come straight from the spec. They are deliberately
 * extensible — §28 says "Include regional/cultural garments when the
 * catalog requires them" — but extension must be a considered change,
 * because adding a garment means deciding which slot it occupies and how
 * it pairs.
 */

export const GARMENTS = [
  "shirt", "t-shirt", "polo", "blouse", "sweater", "hoodie",
  "trouser", "jeans", "chinos", "shorts", "skirt", "dress", "jumpsuit",
  "jacket", "blazer", "coat", "suit", "vest",
  "sneaker", "loafer", "boot", "derby", "sandal", "heel", "flat",
  "bag", "belt", "hat", "scarf", "jewelry", "watch",
] as const;
export type Garment = (typeof GARMENTS)[number];

export const FITS = [
  "skinny", "slim", "regular", "relaxed", "oversized", "wide",
  "tailored", "cropped",
] as const;
export type Fit = (typeof FITS)[number];

export const VOLUMES = ["fitted", "boxy"] as const;
export type Volume = (typeof VOLUMES)[number];

export const WEIGHTS = ["light", "medium", "heavy"] as const;
export type Weight = (typeof WEIGHTS)[number];

export const DRAPES = ["crisp", "fluid", "structured"] as const;
export type Drape = (typeof DRAPES)[number];

export const PATTERNS = [
  "plain", "stripe", "check", "floral", "graphic", "geometric", "textured",
] as const;
export type Pattern = (typeof PATTERNS)[number];

export const PATTERN_SCALES = ["none", "small", "medium", "large"] as const;
export type PatternScale = (typeof PATTERN_SCALES)[number];

export const STYLES = [
  "classic", "minimal", "preppy", "streetwear", "workwear", "smart_casual",
  "formal", "romantic", "resort", "sport", "vintage", "avant_garde",
] as const;
export type Style = (typeof STYLES)[number];

/**
 * Outfit slots.
 *
 * Not in the spec's taxonomy section, but implied by the outfit object
 * (§56) and required by slot-level refinement (§61: "change the shoes"
 * means lock every other slot). A garment maps to exactly one slot,
 * which is what makes an outfit a structured object rather than a list.
 */
export const SLOTS = [
  "top", "bottom", "outerwear", "footwear", "accessory", "onepiece",
] as const;
export type Slot = (typeof SLOTS)[number];

const GARMENT_SLOT: Record<Garment, Slot> = {
  shirt: "top", "t-shirt": "top", polo: "top", blouse: "top",
  sweater: "top", hoodie: "top",
  trouser: "bottom", jeans: "bottom", chinos: "bottom",
  shorts: "bottom", skirt: "bottom",
  // A dress or jumpsuit occupies top and bottom at once, so it gets its
  // own slot — pairing one with trousers is not a styling judgement
  // call, it is a category error.
  dress: "onepiece", jumpsuit: "onepiece", suit: "onepiece",
  jacket: "outerwear", blazer: "outerwear", coat: "outerwear", vest: "outerwear",
  sneaker: "footwear", loafer: "footwear", boot: "footwear",
  derby: "footwear", sandal: "footwear", heel: "footwear", flat: "footwear",
  bag: "accessory", belt: "accessory", hat: "accessory",
  scarf: "accessory", jewelry: "accessory", watch: "accessory",
};

export function slotForGarment(garment: string | null | undefined): Slot | null {
  if (!garment) return null;
  return GARMENT_SLOT[garment as Garment] ?? null;
}

/**
 * Formality, 0–5 (spec §52).
 *
 * A normalised scale rather than labels, so an incompatible *gap* can be
 * penalised proportionally: trainers with a dinner jacket is a gap of 4
 * and should score far worse than loafers with chinos, a gap of 1.
 */
export const FORMALITY = {
  VERY_CASUAL: 0,
  CASUAL: 1,
  SMART_CASUAL: 2,
  POLISHED: 3,
  FORMAL: 4,
  HIGHLY_FORMAL: 5,
} as const;

export const FORMALITY_MIN = 0;
export const FORMALITY_MAX = 5;

/**
 * Colour families, for relationships that hue alone cannot express
 * (spec §50). Neutrals matter disproportionately in fashion: a neutral
 * goes with almost anything, which is a rule about the family, not about
 * the hue.
 */
export const COLOR_FAMILIES = [
  "black", "white", "grey", "beige", "brown", "navy", "blue", "green",
  "olive", "yellow", "orange", "red", "pink", "purple", "metallic", "multi",
] as const;
export type ColorFamily = (typeof COLOR_FAMILIES)[number];

export const NEUTRAL_FAMILIES: ReadonlySet<string> = new Set([
  "black", "white", "grey", "beige", "brown", "navy",
]);

export function isNeutral(family: string | null | undefined): boolean {
  return family ? NEUTRAL_FAMILIES.has(family) : false;
}

export const OCCASIONS = [
  "everyday", "work", "dinner", "party", "wedding", "travel",
  "beach", "outdoor", "sport", "formal_event",
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export const SEASONS = ["spring", "summer", "autumn", "winter", "all_season"] as const;
export type Season = (typeof SEASONS)[number];

/** Membership checks used to reject out-of-vocabulary model output. */
export function isValidTerm<T extends readonly string[]>(
  vocabulary: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && (vocabulary as readonly string[]).includes(value);
}

/**
 * Coerce a model's answer to a vocabulary term, or null.
 *
 * Tolerates the two harmless ways a model deviates — casing and
 * hyphen/underscore/space — because rejecting "Smart Casual" for
 * "smart_casual" throws away a correct answer over formatting. Anything
 * genuinely outside the vocabulary returns null, which the caller stores
 * as "unknown" rather than guessing (spec §32: "If not visible:
 * unknown").
 */
export function coerceTerm<T extends readonly string[]>(
  vocabulary: T,
  value: unknown,
): T[number] | null {
  if (typeof value !== "string") return null;
  const normalised = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  for (const term of vocabulary) {
    if (term.toLowerCase().replace(/[\s-]+/g, "_") === normalised) return term as T[number];
  }
  // t-shirt is the one vocabulary term containing a hyphen, so the
  // normalisation above turns it into t_shirt and misses it.
  if (normalised === "t_shirt" && (vocabulary as readonly string[]).includes("t-shirt")) {
    return "t-shirt" as T[number];
  }
  return null;
}
