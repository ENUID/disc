import { usageSink } from "./usage";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { bumpCounts } from "./catalog";
import { profileDelta } from "./lib/catalog-counts";
import { Doc, Id } from "./_generated/dataModel";
import { env } from "./lib/env";
import { enrichmentCacheKey } from "./lib/enrichment-cache";
import {
  FashionProfile,
  mergeProfiles,
  parseProfile,
  profileCompleteness,
  PROFILE_SCHEMA_VERSION,
  Provenance,
} from "./lib/fashion-profile";
import { extractJson, reasoningProvider, visionProvider } from "./lib/providers";
import {
  productProfileSystem,
  productProfileUser,
  productProfileVisionSystem,
  productProfileVisionUser,
  PROMPT_VERSIONS,
} from "./lib/prompts";
import {
  COLOR_FAMILIES,
  DRAPES,
  FITS,
  GARMENTS,
  OCCASIONS,
  PATTERN_SCALES,
  PATTERNS,
  SEASONS,
  STYLES,
  VOLUMES,
  WEIGHTS,
} from "./lib/taxonomy";

/**
 * Product enrichment (spec Phase 5).
 *
 * Turns a source product into a fashion profile the decision engine can
 * actually reason over. Everything downstream — compatibility, ranking,
 * brand coherence, diversity — reads attributes that are computed here
 * and nowhere else, which is why the audit lists this as the gap that
 * blocks every later phase.
 *
 * Two costs are controlled deliberately (spec §31, §86):
 *
 *   - Nothing is re-analysed unless its evidence, prompt, schema or
 *     model changed. The cache key is the whole mechanism.
 *   - Vision runs only when there is an image and only after text, so a
 *     catalog with good descriptions never pays for vision at all.
 */

const VOCABULARY = {
  garment: GARMENTS,
  fit: FITS,
  volume: VOLUMES,
  weight: WEIGHTS,
  drape: DRAPES,
  pattern: PATTERNS,
  patternScale: PATTERN_SCALES,
  colorFamily: COLOR_FAMILIES,
  styleVector: STYLES,
  occasionVector: OCCASIONS,
  seasonVector: SEASONS,
};

export const getProfile = internalQuery({
  args: { tenantId: v.id("tenants"), productId: v.id("products") },
  handler: async (ctx, { tenantId, productId }) => {
    return await ctx.db
      .query("productProfiles")
      .withIndex("by_tenant_and_product", (q) =>
        q.eq("tenantId", tenantId).eq("productId", productId),
      )
      .unique();
  },
});

export const saveProfile = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    productId: v.id("products"),
    profile: v.any(),
    provenance: v.any(),
    completeness: v.number(),
    cacheKey: v.string(),
    rejectedFields: v.array(v.string()),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("productProfiles")
      .withIndex("by_tenant_and_product", (q) =>
        q.eq("tenantId", args.tenantId).eq("productId", args.productId),
      )
      .unique();

    const doc = {
      tenantId: args.tenantId,
      productId: args.productId,
      profile: args.profile,
      provenance: args.provenance,
      completeness: args.completeness,
      cacheKey: args.cacheKey,
      schemaVersion: PROFILE_SCHEMA_VERSION,
      lastEnrichedAt: Date.now(),
      rejectedFields: args.rejectedFields,
    };

    if (existing) await ctx.db.patch(existing._id, doc);
    else await ctx.db.insert("productProfiles", doc);

    // A REPLACEMENT IS NOT A NO-OP for the counters (P1.6).
    // `enrichedCount` is unchanged — the product was already enriched —
    // but `completeness` can cross the confidence threshold in either
    // direction and `rejectedFields` can appear or clear. Treating
    // replacement as "nothing changed" would let those two drift on
    // every re-enrichment. Re-running the same enrichment produces
    // identical values and therefore a zero delta, which is what makes
    // a retried job harmless.
    await bumpCounts(ctx, args.tenantId, profileDelta(existing ?? null, doc));
    return null;
  },
});

/**
 * Products in this tenant that have no current profile.
 *
 * Compares the stored cache key against what the product's current
 * content would produce, so a product whose description changed is
 * picked up while an untouched one is skipped.
 */
export const staleProductIds = internalQuery({
  args: { tenantId: v.id("tenants"), limit: v.number(), model: v.string() },
  handler: async (ctx, { tenantId, limit, model }) => {
    const products = await ctx.db
      .query("products")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .take(limit * 4);

    const stale: Id<"products">[] = [];
    for (const product of products) {
      const expected = enrichmentCacheKey({
        title: product.title,
        description: product.description,
        tags: product.tags,
        images: product.images,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        promptVersion: PROMPT_VERSIONS.productProfile,
        model,
      });
      const profile = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", tenantId).eq("productId", product._id),
        )
        .unique();

      if (!profile || profile.cacheKey !== expected) stale.push(product._id);
      if (stale.length >= limit) break;
    }
    return stale;
  },
});

/**
 * Enrich a batch of products.
 *
 * Sequential per product but bounded per run, so a large catalog is
 * enriched over several scheduled passes rather than one action that
 * times out and loses everything it did.
 */
export const enrichBatch = internalAction({
  args: { tenantId: v.id("tenants"), limit: v.optional(v.number()) },
  returns: v.object({ enriched: v.number(), remaining: v.number() }),
  handler: async (ctx, { tenantId, limit }) => {
    const apiKey = env("ANTHROPIC_API_KEY");
    const text = reasoningProvider(apiKey, "fast", usageSink(ctx, tenantId, "enrichment"));
    const vision = visionProvider(apiKey, usageSink(ctx, tenantId, "vision"));
    const batchSize = limit ?? 25;

    const stale: Id<"products">[] = await ctx.runQuery(internal.enrichment.staleProductIds, {
      tenantId,
      limit: batchSize,
      model: text.name,
    });
    if (stale.length === 0) return { enriched: 0, remaining: 0 };

    const products: Doc<"products">[] = await ctx.runQuery(
      internal.products.listForEmbedding,
      { productIds: stale },
    );

    let enriched = 0;
    for (const product of products) {
      try {
        await enrichOne(ctx, tenantId, product, text, vision);
        enriched++;
      } catch {
        // One product failing must not abandon the batch. It keeps its
        // stale cache key, so the next pass retries it.
      }
    }

    const remainingIds: Id<"products">[] = await ctx.runQuery(
      internal.enrichment.staleProductIds,
      { tenantId, limit: 1, model: text.name },
    );
    return { enriched, remaining: remainingIds.length };
  },
});

async function enrichOne(
  ctx: any,
  tenantId: Id<"tenants">,
  product: Doc<"products">,
  text: ReturnType<typeof reasoningProvider>,
  vision: ReturnType<typeof visionProvider>,
): Promise<void> {
  const cacheKey = enrichmentCacheKey({
    title: product.title,
    description: product.description,
    tags: product.tags,
    images: product.images,
    schemaVersion: PROFILE_SCHEMA_VERSION,
    promptVersion: PROMPT_VERSIONS.productProfile,
    model: text.name,
  });

  const rejected: string[] = [];
  let merged: { profile: FashionProfile; provenance: Record<string, Provenance> } | null =
    null;

  // Text first. It is cheaper, and on a catalog with real descriptions
  // it establishes most of the profile — which means vision often has
  // nothing left to add and can be skipped entirely.
  const textResponse = await text.complete({
    system: productProfileSystem,
    user: productProfileUser({
      title: product.title,
      description: product.description,
      productType: product.productType,
      tags: product.tags,
      vocabulary: VOCABULARY,
    }),
    promptVersion: PROMPT_VERSIONS.productProfile,
    maxOutputTokens: 900,
    json: true,
  });

  const textJson = extractJson(textResponse.text);
  if (textJson) {
    const parsed = parseProfile(textJson);
    rejected.push(...parsed.rejected);
    merged = mergeProfiles(merged, {
      profile: parsed.profile,
      provenance: {
        source: "text_model",
        model: textResponse.model,
        confidence: readConfidence(textJson),
        version: textResponse.promptVersion,
        at: Date.now(),
      },
    });
  }

  // Vision only for what text could not establish, and only when there
  // is an image. Spec §32 restricts it to visible properties, so it is
  // the right source for pattern, volume and visual weight and the wrong
  // one for fabric.
  const needsVision =
    product.images.length > 0 &&
    (!merged ||
      merged.profile.pattern === null ||
      merged.profile.colorFamily === null ||
      merged.profile.volume === null ||
      merged.profile.visualWeight === null);

  if (needsVision) {
    try {
      const visionResponse = await vision.describe({
        system: productProfileVisionSystem,
        user: productProfileVisionUser({ title: product.title, vocabulary: VOCABULARY }),
        imageUrls: product.images,
        promptVersion: PROMPT_VERSIONS.productProfileVision,
        maxOutputTokens: 900,
        json: true,
      });
      const visionJson = extractJson(visionResponse.text);
      if (visionJson) {
        const parsed = parseProfile(visionJson);
        rejected.push(...parsed.rejected);
        merged = mergeProfiles(merged, {
          profile: parsed.profile,
          provenance: {
            source: "vision_model",
            model: visionResponse.model,
            confidence: readConfidence(visionJson),
            version: visionResponse.promptVersion,
            at: Date.now(),
          },
        });
      }
    } catch {
      // Vision is an enhancement. Losing it leaves a text-only profile,
      // which is a less complete answer rather than a broken one.
    }
  }

  // Deterministic fallback from source data. Runs last but ranks above
  // the models in provenance, because Shopify's own product_type is a
  // fact and a model's guess about it is not.
  const ruleProfile = ruleDerivedProfile(product);
  merged = mergeProfiles(merged, {
    profile: ruleProfile,
    provenance: {
      source: "rule",
      model: null,
      confidence: 1,
      version: PROFILE_SCHEMA_VERSION,
      at: Date.now(),
    },
  });

  await ctx.runMutation(internal.enrichment.saveProfile, {
    tenantId,
    productId: product._id,
    profile: merged.profile,
    provenance: merged.provenance,
    completeness: profileCompleteness(merged.profile),
    cacheKey,
    rejectedFields: [...new Set(rejected)],
  });
}

function readConfidence(raw: unknown): number {
  if (raw && typeof raw === "object" && "confidence" in raw) {
    const n = Number((raw as { confidence: unknown }).confidence);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return 0.5;
}

/**
 * What can be derived without a model at all.
 *
 * Matters more than it looks: a deployment with no model key still gets
 * a usable garment and colour for most products, so the product degrades
 * rather than stops. Same contract the Python prototype held for its
 * Ollama calls, kept deliberately.
 */
export function ruleDerivedProfile(product: {
  title: string;
  productType: string;
  colour: string;
  tags: string[];
}): FashionProfile {
  const { profile } = parseProfile({});
  const haystack =
    `${product.title} ${product.productType} ${product.tags.join(" ")}`.toLowerCase();

  for (const garment of GARMENTS) {
    // Word-boundary match so "shirt" does not fire on "t-shirt" first,
    // and "boot" does not fire on "bootcut".
    const pattern = new RegExp(`\\b${garment.replace(/[-]/g, "[- ]?")}s?\\b`, "i");
    if (pattern.test(haystack)) {
      profile.garment = garment;
      break;
    }
  }

  const colour = product.colour.toLowerCase();
  for (const family of COLOR_FAMILIES) {
    if (colour.includes(family)) {
      profile.colorFamily = family;
      break;
    }
  }
  if (product.colour) profile.color = product.colour;

  return profile;
}
