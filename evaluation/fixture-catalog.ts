/**
 * The benchmark catalog (spec §98).
 *
 * Fixed and hand-written, because a benchmark whose inputs change is not
 * a benchmark — the score would move for reasons nobody could attribute
 * to a code change.
 *
 * Designed to exercise the specific things that go wrong rather than to
 * look like a real shop:
 *
 *   - a formality range wide enough that gaps are testable (0 to 5)
 *   - genuinely clashing colours alongside safe neutrals
 *   - sold-out products, so availability filtering has something to catch
 *   - one very expensive piece, so budget constraints bite
 *   - a dress, so the one-piece slot rule is exercised
 *   - two near-identical shirts, so diversity has a way to fail
 *   - a product with almost nothing established, so the "unknown scores
 *     neutral" rule is exercised on real input
 *
 * The brand is deliberately coherent (minimal/classic, muted) so that
 * brand-coherence scoring has a stable target.
 */

import type { FashionProfile } from "../convex/lib/fashion-profile";
import { emptyProfile } from "../convex/lib/fashion-profile";

export type FixtureProduct = {
  id: string;
  title: string;
  description: string;
  productType: string;
  price: number;
  available: boolean;
  profile: Partial<FashionProfile>;
};

export const FIXTURE_BRAND_STYLE: Record<string, number> = {
  minimal: 0.9,
  classic: 0.8,
  smart_casual: 0.6,
  streetwear: 0.05,
};

export const FIXTURE_CATALOG: FixtureProduct[] = [
  // ---- tops -------------------------------------------------------
  {
    id: "shirt-white-oxford",
    title: "White Oxford Shirt",
    description: "crisp white cotton oxford shirt with a button-down collar",
    productType: "Shirts",
    price: 120,
    available: true,
    profile: {
      garment: "shirt", colorFamily: "white", formality: 3, fit: "regular",
      pattern: "plain", weight: "medium", drape: "crisp",
      styleVector: { classic: 0.9, minimal: 0.7 },
      occasionVector: { work: 0.9, dinner: 0.7, everyday: 0.5 },
    },
  },
  {
    // Deliberately near-identical to the above: diversity must have a
    // way to fail.
    id: "shirt-white-poplin",
    title: "White Poplin Shirt",
    description: "crisp white cotton poplin shirt with a spread collar",
    productType: "Shirts",
    price: 130,
    available: true,
    profile: {
      garment: "shirt", colorFamily: "white", formality: 3, fit: "regular",
      pattern: "plain", weight: "light", drape: "crisp",
      styleVector: { classic: 0.9, minimal: 0.7 },
      occasionVector: { work: 0.9, dinner: 0.7 },
    },
  },
  {
    id: "tee-black",
    title: "Black Cotton Tee",
    description: "plain heavyweight black cotton t-shirt",
    productType: "Tops",
    price: 45,
    available: true,
    profile: {
      garment: "t-shirt", colorFamily: "black", formality: 0, fit: "relaxed",
      pattern: "plain", weight: "medium",
      styleVector: { minimal: 0.8 },
      occasionVector: { everyday: 0.95 },
    },
  },
  {
    id: "knit-oatmeal",
    title: "Oatmeal Merino Crewneck",
    description: "fine-gauge merino wool crewneck in oatmeal",
    productType: "Knitwear",
    price: 195,
    available: true,
    profile: {
      garment: "sweater", colorFamily: "beige", formality: 2, fit: "regular",
      pattern: "plain", weight: "medium", drape: "fluid",
      styleVector: { minimal: 0.9, classic: 0.7 },
      occasionVector: { everyday: 0.8, work: 0.6, dinner: 0.5 },
    },
  },
  {
    // Loud, off-brand, and clashes with most of the catalog.
    id: "hoodie-red-graphic",
    title: "Red Graphic Hoodie",
    description: "oversized red hoodie with a large chest graphic",
    productType: "Tops",
    price: 110,
    available: true,
    profile: {
      garment: "hoodie", colorFamily: "red", formality: 0, fit: "oversized",
      pattern: "graphic", patternScale: "large", weight: "heavy",
      graphicLevel: 0.9, logoLevel: 0.8, visualWeight: 0.9,
      styleVector: { streetwear: 0.95 },
      occasionVector: { everyday: 0.8 },
    },
  },

  // ---- bottoms ----------------------------------------------------
  {
    id: "trouser-navy-wool",
    title: "Navy Wool Trouser",
    description: "tailored navy wool trouser with a straight leg",
    productType: "Trousers",
    price: 220,
    available: true,
    profile: {
      garment: "trouser", colorFamily: "navy", formality: 4, fit: "tailored",
      pattern: "plain", weight: "medium", drape: "structured",
      styleVector: { classic: 0.9, minimal: 0.6 },
      occasionVector: { work: 0.9, formal_event: 0.7, dinner: 0.7 },
    },
  },
  {
    id: "jeans-indigo",
    title: "Indigo Straight Jean",
    description: "relaxed straight-leg jean in raw indigo denim",
    productType: "Trousers",
    price: 150,
    available: true,
    profile: {
      garment: "jeans", colorFamily: "blue", formality: 1, fit: "relaxed",
      pattern: "plain", weight: "heavy",
      styleVector: { classic: 0.6, minimal: 0.5 },
      occasionVector: { everyday: 0.95 },
    },
  },
  {
    id: "chino-stone",
    title: "Stone Cotton Chino",
    description: "slim cotton chino in stone",
    productType: "Trousers",
    price: 130,
    available: true,
    profile: {
      garment: "chinos", colorFamily: "beige", formality: 2, fit: "slim",
      pattern: "plain", weight: "medium",
      styleVector: { classic: 0.8, smart_casual: 0.8 },
      occasionVector: { everyday: 0.8, work: 0.7 },
    },
  },
  {
    // Sold out: availability filtering must catch this.
    id: "trouser-charcoal-soldout",
    title: "Charcoal Flannel Trouser",
    description: "tailored charcoal wool flannel trouser",
    productType: "Trousers",
    price: 240,
    available: false,
    profile: {
      garment: "trouser", colorFamily: "grey", formality: 4, fit: "tailored",
      pattern: "plain", weight: "heavy",
      styleVector: { classic: 0.9 },
      occasionVector: { work: 0.9, formal_event: 0.6 },
    },
  },

  // ---- footwear ---------------------------------------------------
  {
    id: "loafer-brown",
    title: "Brown Leather Loafer",
    description: "polished brown calf leather penny loafer",
    productType: "Shoes",
    price: 290,
    available: true,
    profile: {
      garment: "loafer", colorFamily: "brown", formality: 3, fit: "regular",
      pattern: "plain",
      styleVector: { classic: 0.95 },
      occasionVector: { work: 0.8, dinner: 0.8 },
    },
  },
  {
    id: "sneaker-white",
    title: "White Leather Sneaker",
    description: "clean minimal white leather sneaker",
    productType: "Shoes",
    price: 160,
    available: true,
    profile: {
      garment: "sneaker", colorFamily: "white", formality: 1, fit: "regular",
      pattern: "plain",
      styleVector: { minimal: 0.9, sport: 0.3 },
      occasionVector: { everyday: 0.95 },
    },
  },
  {
    id: "boot-black-derby",
    title: "Black Leather Derby",
    description: "black calf leather derby with a leather sole",
    productType: "Shoes",
    price: 340,
    available: true,
    profile: {
      garment: "derby", colorFamily: "black", formality: 5, fit: "regular",
      pattern: "plain",
      styleVector: { formal: 0.9, classic: 0.8 },
      occasionVector: { formal_event: 0.95, work: 0.6 },
    },
  },

  // ---- outerwear and one-piece ------------------------------------
  {
    id: "coat-camel",
    title: "Camel Wool Overcoat",
    description: "single-breasted overcoat in camel wool",
    productType: "Outerwear",
    price: 690,
    available: true,
    profile: {
      garment: "coat", colorFamily: "beige", formality: 4, fit: "regular",
      pattern: "plain", weight: "heavy", drape: "structured",
      styleVector: { classic: 0.9, minimal: 0.7 },
      occasionVector: { work: 0.7, formal_event: 0.6 },
    },
  },
  {
    // The one very expensive piece, for budget cases.
    id: "coat-cashmere-luxury",
    title: "Cashmere Wrap Coat",
    description: "double-faced cashmere wrap coat",
    productType: "Outerwear",
    price: 2400,
    available: true,
    profile: {
      garment: "coat", colorFamily: "grey", formality: 4, fit: "relaxed",
      pattern: "plain", weight: "heavy",
      styleVector: { minimal: 0.95, classic: 0.8 },
      occasionVector: { formal_event: 0.7 },
    },
  },
  {
    id: "dress-black-midi",
    title: "Black Silk Midi Dress",
    description: "bias-cut black silk midi dress",
    productType: "Dresses",
    price: 420,
    available: true,
    profile: {
      garment: "dress", colorFamily: "black", formality: 4, fit: "regular",
      pattern: "plain", weight: "light", drape: "fluid",
      styleVector: { minimal: 0.85, classic: 0.7 },
      occasionVector: { dinner: 0.9, formal_event: 0.8 },
    },
  },

  // ---- barely enriched --------------------------------------------
  {
    // Almost nothing established. Exercises "unknown scores neutral" on
    // real input rather than only in a unit test.
    id: "scarf-unknown",
    title: "Wool Scarf",
    description: "a wool scarf",
    productType: "Accessories",
    price: 80,
    available: true,
    profile: { garment: "scarf" },
  },
];

export function fixtureProfile(product: FixtureProduct): FashionProfile {
  return { ...emptyProfile(), ...product.profile };
}

export const FIXTURE_BY_ID = new Map(FIXTURE_CATALOG.map((p) => [p.id, p]));

/** Sold-out ids, referenced by cases that must never surface them. */
export const SOLD_OUT_IDS = FIXTURE_CATALOG.filter((p) => !p.available).map((p) => p.id);
