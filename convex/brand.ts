import { usageSink } from "./usage";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc } from "./_generated/dataModel";
import { env } from "./lib/env";
import {
  aggregateStyleVector,
  BrandStats,
  canDeriveBrand,
  computeBrandStats,
  deriveFormalityBand,
  derivePalette,
} from "./lib/brand-stats";
import { FashionProfile } from "./lib/fashion-profile";
import { extractJson, reasoningProvider } from "./lib/providers";
import { brandExtractSystem, brandExtractUser, PROMPT_VERSIONS } from "./lib/prompts";
import { STYLES } from "./lib/taxonomy";

/**
 * Brand Brain (spec §20-§25).
 *
 * Versioned, never mutated. Spec §138 requires that a merchant saying
 * "we are not streetwear" produces version 2 while past recommendation
 * traces continue to resolve against version 1 — overwriting would make
 * every historical recommendation unreproducible, which is the point of
 * keeping traces at all.
 */

export const currentBrain = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    return await ctx.db
      .query("brandBrains")
      .withIndex("by_tenant_current", (q) => q.eq("tenantId", tenantId).eq("isCurrent", true))
      .unique();
  },
});

export const catalogForBrand = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    // Bounded: a brand is characterised from a large sample, not
    // necessarily every product. 2,000 is far past the point where more
    // data changes the distribution.
    const products = await ctx.db
      .query("products")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .take(2000);

    const profiles: FashionProfile[] = [];
    for (const product of products) {
      const row = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", tenantId).eq("productId", product._id),
        )
        .unique();
      if (row) profiles.push(row.profile as FashionProfile);
    }

    return {
      products: products.map((p) => ({
        title: p.title,
        productType: p.productType,
        price: p.price,
        currency: p.currency,
        tags: p.tags,
      })),
      profiles,
    };
  },
});

export const saveBrain = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    styleVector: v.any(),
    palette: v.any(),
    formality: v.any(),
    productWorld: v.any(),
    voice: v.any(),
    summary: v.string(),
    derivedFrom: v.any(),
    source: v.union(v.literal("derived"), v.literal("merchant_corrected")),
    confidence: v.number(),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { tenantId, ...rest } = args;

    const existing = await ctx.db
      .query("brandBrains")
      .withIndex("by_tenant_current", (q) => q.eq("tenantId", tenantId).eq("isCurrent", true))
      .unique();

    // Demote rather than delete. Past traces reference this version and
    // must keep resolving.
    if (existing) await ctx.db.patch(existing._id, { isCurrent: false });

    const version = (existing?.version ?? 0) + 1;
    await ctx.db.insert("brandBrains", {
      tenantId,
      version,
      isCurrent: true,
      createdAt: Date.now(),
      ...rest,
    });

    await ctx.db.patch(tenantId, {
      brandBrainStatus: "ready",
      updatedAt: Date.now(),
    });
    return version;
  },
});

export const setBrandStatus = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    status: v.union(
      v.literal("pending"),
      v.literal("building"),
      v.literal("ready"),
      v.literal("error"),
    ),
  },
  returns: v.null(),
  handler: async (ctx, { tenantId, status }) => {
    await ctx.db.patch(tenantId, { brandBrainStatus: status, updatedAt: Date.now() });
    return null;
  },
});

/**
 * Build the Brand Brain.
 *
 * The numeric parts are computed from the catalog and are true whether
 * or not a model is available. Only the characterisation — style
 * weighting, voice, summary — is a model call, and if it fails the brain
 * is still built from the deterministic half rather than not at all.
 */
export const buildBrandBrain = internalAction({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    await ctx.runMutation(internal.brand.setBrandStatus, { tenantId, status: "building" });

    try {
      const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.getById, {
        tenantId,
      });
      if (!tenant) return null;

      const catalog: { products: any[]; profiles: FashionProfile[] } = await ctx.runQuery(
        internal.brand.catalogForBrand,
        { tenantId },
      );

      const stats: BrandStats = computeBrandStats(catalog.products, catalog.profiles);

      // Refusing is a real answer: a confident brand characterisation
      // drawn from a handful of profiled products is worse than none,
      // because the merchant will believe it.
      if (!canDeriveBrand(stats)) {
        await ctx.runMutation(internal.brand.setBrandStatus, {
          tenantId,
          status: "pending",
        });
        return null;
      }

      // Deterministic first. These hold regardless of the model call.
      const derivedStyle = aggregateStyleVector(catalog.profiles);
      const palette = derivePalette(catalog.profiles);
      const formality = deriveFormalityBand(catalog.profiles);

      let styleVector = derivedStyle;
      let voice: unknown = null;
      let summary = "";
      let confidence = 0.4; // deterministic-only baseline

      const provider = reasoningProvider(
        env("ANTHROPIC_API_KEY"),
        "fast",
        usageSink(ctx, tenantId, "brand"),
      );
      try {
        const response = await provider.complete({
          system: brandExtractSystem,
          user: brandExtractUser({
            shopDomain: tenant.shopDomain,
            productCount: stats.productCount,
            topCategories: stats.topCategories,
            topGarments: stats.topGarments,
            topColorFamilies: stats.topColorFamilies,
            topFits: stats.topFits,
            formalityHistogram: stats.formalityHistogram,
            priceRange: stats.priceRange,
            sampleTitles: stats.sampleTitles,
            styleVocabulary: STYLES,
          }),
          promptVersion: PROMPT_VERSIONS.brandExtract,
          maxOutputTokens: 700,
          json: true,
        });

        const parsed = extractJson(response.text) as Record<string, unknown> | null;
        if (parsed) {
          const modelStyle = coerceStyleVector(parsed.styleVector);
          // The model refines the derived vector rather than replacing
          // it: the derived one is grounded in counted attributes, the
          // model's is an interpretation of the same evidence. Blending
          // keeps the interpretation from overriding the arithmetic.
          if (Object.keys(modelStyle).length > 0) {
            styleVector = blendStyleVectors(derivedStyle, modelStyle);
          }
          voice = parseVoice(parsed.voice);
          summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 300) : "";
          const c = Number(parsed.confidence);
          if (Number.isFinite(c)) confidence = Math.max(0, Math.min(1, c));
        }
      } catch {
        // Model unavailable: keep the deterministic brain. Same
        // degradation contract as everywhere else in this codebase —
        // less insight, never a different response shape.
      }

      await ctx.runMutation(internal.brand.saveBrain, {
        tenantId,
        styleVector,
        palette,
        formality,
        productWorld: {
          categories: stats.topCategories,
          garments: stats.topGarments,
          patterns: stats.topPatterns,
          fits: stats.topFits,
          priceRange: stats.priceRange,
        },
        voice,
        summary,
        derivedFrom: {
          productCount: stats.productCount,
          profiledCount: stats.profiledCount,
          coverage: Math.round(stats.coverage * 100) / 100,
        },
        source: "derived",
        confidence,
      });
    } catch {
      await ctx.runMutation(internal.brand.setBrandStatus, { tenantId, status: "error" });
    }
    return null;
  },
});

/**
 * Merchant correction (spec §138).
 *
 * Creates a new version rather than editing. The merchant's values are
 * merged over the derived ones, and the result is marked
 * `merchant_corrected` so a later automatic rebuild knows not to silently
 * undo what a human said.
 */
export const applyMerchantCorrection = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    styleVector: v.optional(v.any()),
    palette: v.optional(v.any()),
    voice: v.optional(v.any()),
    summary: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const current = await ctx.db
      .query("brandBrains")
      .withIndex("by_tenant_current", (q) =>
        q.eq("tenantId", args.tenantId).eq("isCurrent", true),
      )
      .unique();
    if (!current) throw new Error("No brand brain to correct");

    await ctx.db.patch(current._id, { isCurrent: false });

    await ctx.db.insert("brandBrains", {
      tenantId: args.tenantId,
      version: current.version + 1,
      isCurrent: true,
      styleVector: args.styleVector ?? current.styleVector,
      palette: args.palette ?? current.palette,
      formality: current.formality,
      productWorld: current.productWorld,
      voice: args.voice ?? current.voice,
      merchandising: current.merchandising,
      summary: args.summary ?? current.summary,
      derivedFrom: current.derivedFrom,
      source: "merchant_corrected",
      // A human said so. That is the most reliable signal available.
      confidence: 1,
      createdAt: Date.now(),
    });

    return current.version + 1;
  },
});

function coerceStyleVector(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const normalised = key.trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (!(STYLES as readonly string[]).includes(normalised)) continue;
    const weight = Number(value);
    if (Number.isFinite(weight) && weight > 0) {
      out[normalised] = Math.max(0, Math.min(1, weight));
    }
  }
  return out;
}

/** Mean of the two, so neither the arithmetic nor the model dominates. */
export function blendStyleVectors(
  derived: Record<string, number>,
  model: Record<string, number>,
): Record<string, number> {
  const keys = new Set([...Object.keys(derived), ...Object.keys(model)]);
  const out: Record<string, number> = {};
  for (const key of keys) {
    const value = ((derived[key] ?? 0) + (model[key] ?? 0)) / 2;
    if (value >= 0.05) out[key] = Math.round(value * 100) / 100;
  }
  return out;
}

export function parseVoice(raw: unknown): {
  tone: string[];
  preferredTerms: string[];
  avoidTerms: string[];
} | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = (value: unknown, max: number): string[] =>
    Array.isArray(value)
      ? value
          .filter((v): v is string => typeof v === "string")
          .map((v) => v.trim())
          .filter(Boolean)
          .slice(0, max)
      : [];

  const voice = {
    tone: list(r.tone, 3),
    preferredTerms: list(r.preferredTerms, 6),
    avoidTerms: list(r.avoidTerms, 6),
  };
  return voice.tone.length || voice.preferredTerms.length || voice.avoidTerms.length
    ? voice
    : null;
}
