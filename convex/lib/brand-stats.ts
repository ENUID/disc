/**
 * Brand statistics — the deterministic half of the Brand Brain.
 *
 * Spec §20 is explicit that the Brand Brain "is NOT one giant prompt. It
 * is structured tenant intelligence." So the parts that can be *counted*
 * are counted here, and only the characterisation that genuinely needs
 * judgement (style weighting, voice, a one-line summary) goes to a model.
 *
 * That split matters for three reasons:
 *   - a distribution is reproducible; a model's impression of one is not
 *   - it is far cheaper: one small call per merchant, not per product
 *   - a merchant disputing "we are not streetwear" (§138) is disputing a
 *     weighting, not a count, and the counts stay trustworthy either way
 *
 * Pure functions, no Convex imports, so every number here is testable.
 */

import { FashionProfile } from "./fashion-profile";
import { FORMALITY_MAX } from "./taxonomy";

export type ProductLike = {
  title: string;
  productType: string;
  price: number;
  currency: string;
  tags: string[];
};

export type BrandStats = {
  productCount: number;
  topCategories: Array<[string, number]>;
  topGarments: Array<[string, number]>;
  topColorFamilies: Array<[string, number]>;
  topFits: Array<[string, number]>;
  topPatterns: Array<[string, number]>;
  formalityHistogram: number[];
  formalityMean: number | null;
  priceRange: { min: number; max: number; median: number; currency: string };
  sampleTitles: string[];
  profiledCount: number;
  coverage: number;
};

function tally(values: Array<string | null | undefined>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => {
    // Ties broken alphabetically so the same catalog always produces the
    // same statistics — a Brand Brain that shifts between identical runs
    // is untraceable.
    if (b[1] !== a[1]) return b[1] - a[1];
    return a[0].localeCompare(b[0]);
  });
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute the statistics a Brand Brain is derived from.
 *
 * `coverage` is how much of the catalog has a fashion profile at all. It
 * gates whether a Brand Brain should be built yet: characterising a
 * brand from 5% of its catalog produces a confident, wrong answer, and
 * the merchant will believe it because it looks specific.
 */
export function computeBrandStats(
  products: ProductLike[],
  profiles: FashionProfile[],
): BrandStats {
  const prices = products.map((p) => p.price).filter((p) => Number.isFinite(p) && p > 0);

  const histogram = new Array(FORMALITY_MAX + 1).fill(0);
  let formalitySum = 0;
  let formalityCount = 0;
  for (const profile of profiles) {
    if (profile.formality === null) continue;
    const bucket = Math.round(profile.formality);
    if (bucket >= 0 && bucket <= FORMALITY_MAX) {
      histogram[bucket]++;
      formalitySum += profile.formality;
      formalityCount++;
    }
  }

  return {
    productCount: products.length,
    topCategories: tally(products.map((p) => p.productType)).slice(0, 12),
    topGarments: tally(profiles.map((p) => p.garment)).slice(0, 12),
    topColorFamilies: tally(profiles.map((p) => p.colorFamily)).slice(0, 12),
    topFits: tally(profiles.map((p) => p.fit)).slice(0, 8),
    topPatterns: tally(profiles.map((p) => p.pattern)).slice(0, 8),
    formalityHistogram: histogram,
    formalityMean: formalityCount > 0 ? formalitySum / formalityCount : null,
    priceRange: {
      min: prices.length ? Math.min(...prices) : 0,
      max: prices.length ? Math.max(...prices) : 0,
      median: median(prices),
      currency: products[0]?.currency ?? "USD",
    },
    // A spread across the catalog rather than the first N, so the model
    // sees the brand's range rather than whatever was ingested first.
    sampleTitles: sampleEvenly(products.map((p) => p.title), 25),
    profiledCount: profiles.length,
    coverage: products.length > 0 ? profiles.length / products.length : 0,
  };
}

function sampleEvenly<T>(items: T[], count: number): T[] {
  if (items.length <= count) return items;
  const step = items.length / count;
  const out: T[] = [];
  for (let i = 0; i < count; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

/**
 * Aggregate the per-product style vectors into a brand-level one.
 *
 * Averaged over the products that actually have a style vector, then
 * normalised so the strongest axis is 1. Without normalising, a catalog
 * where every product is weakly minimal reads as "barely any identity",
 * when in fact minimal is exactly its identity.
 */
export function aggregateStyleVector(
  profiles: FashionProfile[],
): Record<string, number> {
  const sums = new Map<string, number>();
  let contributors = 0;

  for (const profile of profiles) {
    const entries = Object.entries(profile.styleVector);
    if (entries.length === 0) continue;
    contributors++;
    for (const [style, weight] of entries) {
      sums.set(style, (sums.get(style) ?? 0) + weight);
    }
  }
  if (contributors === 0) return {};

  const averaged = [...sums.entries()].map(
    ([style, sum]) => [style, sum / contributors] as [string, number],
  );
  const peak = Math.max(...averaged.map(([, value]) => value));
  if (peak <= 0) return {};

  const out: Record<string, number> = {};
  for (const [style, value] of averaged) {
    const normalised = value / peak;
    // Drop noise: a style present on one product in five hundred is not
    // part of the brand's identity, and keeping it makes the merchant's
    // brand review screen look wrong.
    if (normalised >= 0.05) out[style] = Math.round(normalised * 100) / 100;
  }
  return out;
}

/** The dominant colours, as a palette a merchant would recognise. */
export function derivePalette(
  profiles: FashionProfile[],
  limit = 6,
): Array<{ family: string; share: number }> {
  const families = tally(profiles.map((p) => p.colorFamily));
  const total = families.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return [];
  return families
    .slice(0, limit)
    .map(([family, count]) => ({
      family,
      share: Math.round((count / total) * 100) / 100,
    }));
}

/**
 * The formality band this brand actually occupies.
 *
 * Reported as a range rather than a mean: a brand selling both t-shirts
 * and dinner jackets has a mean of "smart casual" and sells almost
 * nothing there. The 10th/90th percentiles describe it honestly.
 */
export function deriveFormalityBand(
  profiles: FashionProfile[],
): { min: number; max: number; typical: number } | null {
  const values = profiles
    .map((p) => p.formality)
    .filter((f): f is number => f !== null)
    .sort((a, b) => a - b);
  if (values.length === 0) return null;

  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  return {
    min: at(0.1),
    max: at(0.9),
    typical: at(0.5),
  };
}

/**
 * Should a Brand Brain be built from this yet?
 *
 * Refusing is a real answer. A confident characterisation drawn from a
 * handful of products is worse than none: the merchant sees something
 * specific, believes it, and it is wrong.
 */
export const MIN_PRODUCTS_FOR_BRAND = 8;
export const MIN_COVERAGE_FOR_BRAND = 0.3;

export function canDeriveBrand(stats: BrandStats): boolean {
  return (
    stats.productCount >= MIN_PRODUCTS_FOR_BRAND &&
    stats.coverage >= MIN_COVERAGE_FOR_BRAND
  );
}
