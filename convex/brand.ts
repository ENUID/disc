import { usageSink } from "./usage";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { runAsJob } from "./jobrunner";
import { sha256Hex } from "./lib/crypto";
import { env } from "./lib/env";
import {
  aggregateStyleVector,
  brandInputFingerprint,
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

/**
 * The catalog sample a brand is characterised from, ONE BOUNDED PAGE at
 * a time.
 *
 * This used to be a single query that did `take(2000)` and then a
 * separate indexed profile lookup per product — 2,000 sequential reads
 * inside one query, every six hours, for every tenant. Convex has no
 * multi-get, so the per-row lookup cannot be turned into one batched
 * read; what it can be is bounded, which is the actual hazard. A query
 * whose read volume scales with catalog size is the same shape of
 * problem P1.6 removed from `catalogHealth`.
 *
 * So the join stays and the page moves: each call reads at most
 * `BRAND_SAMPLE_PAGE` products and the same number of profiles, and the
 * caller walks pages until it has the sample. Identical output, bounded
 * per query, and the same pagination mechanism `catalog.countPage` uses.
 *
 * Semantics preserved deliberately: profiles are collected for the
 * sampled products only, walking `products` rather than `productProfiles`
 * — a profile whose product was deleted is an orphan, not evidence about
 * the brand, and iterating profiles independently would count it.
 */
export const BRAND_SAMPLE_PAGE = 200;

/**
 * How much of a catalog characterises a brand.
 *
 * Unchanged by P2.2, and deliberately not raised to compensate for the
 * read pattern: 2,000 products is already far past the point where more
 * data moves the distribution.
 */
export const BRAND_SAMPLE_LIMIT = 2000;

export const catalogPageForBrand = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    numItems: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("products")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .paginate({
        cursor: args.cursor,
        // Clamped at both ends: the page bound is the read guarantee, and
        // a zero or negative request would be a silently empty page.
        numItems: Math.max(
          1,
          Math.min(args.numItems ?? BRAND_SAMPLE_PAGE, BRAND_SAMPLE_PAGE),
        ),
      });

    const profiles: FashionProfile[] = [];
    for (const product of page.page) {
      const row = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", args.tenantId).eq("productId", product._id),
        )
        .unique();
      if (row) profiles.push(row.profile as FashionProfile);
    }

    return {
      products: page.page.map((p) => ({
        title: p.title,
        productType: p.productType,
        price: p.price,
        currency: p.currency,
        tags: p.tags,
      })),
      profiles,
      cursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

/**
 * Walk the sample pages into the shape `computeBrandStats` expects.
 *
 * Ordering is preserved across pages, which matters: `sampleEvenly` walks
 * a fixed stride over the product list and `tally` breaks ties
 * alphabetically, so the same catalog produces the same statistics — and
 * therefore the same input fingerprint — on every run. A brain that
 * shifted between identical runs would make the whole change-detection
 * gate meaningless.
 */
async function loadBrandSample(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  tenantId: Id<"tenants">,
): Promise<{ products: any[]; profiles: FashionProfile[] }> {
  const products: any[] = [];
  const profiles: FashionProfile[] = [];
  let cursor: string | null = null;

  for (;;) {
    // The last page is narrowed so the sample cannot OVERSHOOT the
    // limit. Overshooting and slicing afterwards would be wrong rather
    // than merely untidy: `profiles` is sparse — only products that have
    // one contribute — so it does not index-align with `products`, and
    // trimming both to the same length would leave profiles belonging to
    // products outside the sample. That inflates `coverage`, which is the
    // number `canDeriveBrand` gates on.
    const room = BRAND_SAMPLE_LIMIT - products.length;
    if (room <= 0) break;

    const page: {
      products: any[];
      profiles: FashionProfile[];
      cursor: string | null;
      isDone: boolean;
    } = await ctx.runQuery(internal.brand.catalogPageForBrand, {
      tenantId,
      cursor,
      numItems: Math.min(BRAND_SAMPLE_PAGE, room),
    });

    products.push(...page.products);
    profiles.push(...page.profiles);

    if (page.isDone) break;
    cursor = page.cursor;
  }

  return { products, profiles };
}

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
    /** Fingerprint of the inputs this was derived from. See lib/brand-stats.ts. */
    inputHash: v.optional(v.string()),
  },
  returns: v.number(),
  handler: async (ctx, args) => {
    const { tenantId, inputHash, ...rest } = args;

    const existing = await ctx.db
      .query("brandBrains")
      .withIndex("by_tenant_current", (q) => q.eq("tenantId", tenantId).eq("isCurrent", true))
      .unique();

    // MERCHANT CORRECTION OUTRANKS DERIVED INFERENCE.
    //
    // The bug this closes: `applyMerchantCorrection` wrote
    // `source: "merchant_corrected"` and the next automatic rebuild
    // demoted it and inserted a derived version, so a merchant's
    // correction survived about six hours. The comment on that function
    // claimed a rebuild "knows not to silently undo what a human said";
    // nothing read `source`, so it did exactly that.
    //
    // The fix is not to stop rebuilding — that would freeze a brand's
    // knowledge at the moment it was first corrected. Derived inference
    // keeps updating every field the merchant did not touch; the fields
    // they DID touch are carried forward verbatim, and the new version
    // stays `merchant_corrected` so the next rebuild does the same. Only
    // an explicit merchant action can clear that.
    const corrected = new Set(
      existing?.source === "merchant_corrected" ? (existing.correctedFields ?? []) : [],
    );
    const carried: Record<string, unknown> = {};
    for (const field of corrected) {
      if (existing && field in existing) {
        carried[field] = (existing as unknown as Record<string, unknown>)[field];
      }
    }

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
      ...carried,
      ...(corrected.size > 0
        ? {
            source: "merchant_corrected" as const,
            correctedFields: [...corrected],
            // A human's judgement did not become less reliable because
            // the catalog moved underneath it.
            confidence: 1,
          }
        : {}),
    });

    await ctx.db.patch(tenantId, {
      brandBrainStatus: "ready",
      // Stamped with the version, so an unchanged catalog is recognised
      // as unchanged on the next build instead of rebuilt on a timer.
      ...(inputHash ? { brandInputHash: inputHash } : {}),
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
  args: { tenantId: v.id("tenants"), jobId: v.optional(v.id("jobs")) },
  returns: v.null(),
  handler: async (ctx, { tenantId, jobId }) => {
    await runAsJob(ctx, { tenantId, jobId }, () => buildBrandBrainWork(ctx, tenantId));
    return null;
  },
});

async function buildBrandBrainWork(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  tenantId: Id<"tenants">,
): Promise<void> {
  {
    {
      const tenant: Doc<"tenants"> | null = await ctx.runQuery(internal.tenants.getById, {
        tenantId,
      });
      if (!tenant) return;

      const catalog: { products: any[]; profiles: FashionProfile[] } =
        await loadBrandSample(ctx, tenantId);

      const stats: BrandStats = computeBrandStats(catalog.products, catalog.profiles);

      // Refusing is a real answer: a confident brand characterisation
      // drawn from a handful of profiled products is worse than none,
      // because the merchant will believe it.
      if (!canDeriveBrand(stats)) {
        // Only written when it actually changes. The reconciliation cron
        // re-checks a tenant below the coverage threshold every hour, and
        // an unconditional patch here would be a write per tenant per
        // hour to record a state that has not moved.
        if (tenant.brandBrainStatus !== "pending") {
          await ctx.runMutation(internal.brand.setBrandStatus, {
            tenantId,
            status: "pending",
          });
        }
        return;
      }

      // REBUILD ONLY WHEN THE INPUTS CHANGED.
      //
      // Before this, the six-hourly resync scheduled a drain
      // unconditionally, the drain scheduled a build unconditionally, and
      // `saveBrain` inserted a version unconditionally — so every tenant
      // paid for a model call and gained a `brandBrains` row four times a
      // day whether or not anything had changed, and watched a
      // merchant-visible version number climb for no reason.
      //
      // The fingerprint is computed BEFORE the model call and before the
      // status is moved to `building`, so an unchanged catalog costs one
      // bounded read and writes nothing at all.
      const provider = reasoningProvider(
        env("ANTHROPIC_API_KEY"),
        "fast",
        usageSink(ctx, tenantId, "brand"),
      );
      const inputHash = await sha256Hex(
        brandInputFingerprint(stats, PROMPT_VERSIONS.brandExtract, provider.name),
      );
      if (tenant.brandInputHash === inputHash && tenant.brandBrainStatus === "ready") {
        return;
      }

      await ctx.runMutation(internal.brand.setBrandStatus, { tenantId, status: "building" });

      // Deterministic first. These hold regardless of the model call.
      const derivedStyle = aggregateStyleVector(catalog.profiles);
      const palette = derivePalette(catalog.profiles);
      const formality = deriveFormalityBand(catalog.profiles);

      let styleVector = derivedStyle;
      let voice: unknown = null;
      let summary = "";
      let confidence = 0.4; // deterministic-only baseline

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
        // Stamped only on a successful save, so a build that died before
        // writing is retried rather than mistaken for up to date.
        inputHash,
      });
    }
  }
}

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

    // WHICH fields the merchant set, not merely that they set something.
    //
    // This is what lets an automatic rebuild keep updating the rest of
    // the brain while leaving these alone. Recording only the `source`
    // would force a rebuild into an all-or-nothing choice: discard the
    // correction, or freeze the whole brain at the moment it was made.
    //
    // Corrections accumulate — a merchant who fixes the palette today and
    // the voice next month has corrected both — so anything already
    // marked stays marked.
    const correctedFields = new Set(
      current.source === "merchant_corrected" ? (current.correctedFields ?? []) : [],
    );
    if (args.styleVector !== undefined) correctedFields.add("styleVector");
    if (args.palette !== undefined) correctedFields.add("palette");
    if (args.voice !== undefined) correctedFields.add("voice");
    if (args.summary !== undefined) correctedFields.add("summary");

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
      correctedFields: [...correctedFields],
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
