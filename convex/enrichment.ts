import { usageSink } from "./usage";
import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { runAsJob } from "./jobrunner";
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
 * How many products one scan reads, and how many of them one run enriches.
 *
 * SCAN_PAGE is a read bound: one page of products plus one profile lookup
 * each. ENRICH_BATCH is a work bound: each product costs one or two model
 * calls, so this is what keeps a run inside its time budget.
 *
 * They differ because scanning is cheap and enriching is not. A page
 * bigger than the batch means a fully-enriched catalog sweeps in
 * `products / SCAN_PAGE` runs instead of `products / ENRICH_BATCH` — on
 * 5,000 products that is 25 runs rather than 200, for the same result.
 */
const SCAN_PAGE = 200;
const ENRICH_BATCH = 25;

/**
 * One page of a tenant's catalog, and which of it needs enriching.
 *
 * REPLACES A CURSORLESS SCAN. The previous implementation did
 * `take(limit * 4)` from the front of the product index on every call,
 * with no cursor and no memory. Once the first products were enriched it
 * returned nothing, and `enrichBatch` inferred "no work remains" from a
 * second front-of-index probe — so enrichment stopped after one batch and
 * a product edited further into the catalog was never rediscovered.
 * Measured on a 500-product catalog: 25 enriched, then the drain declared
 * itself finished.
 *
 * The cursor is Convex's own pagination cursor, the same mechanism
 * `catalog.countPage` uses, so a sweep is resumable across invocations,
 * retries and crashes without inventing a second pagination scheme.
 *
 * Staleness itself is unchanged: the stored cache key is compared against
 * what the product's current content, schema, prompt and model would
 * produce, so an edited product is stale and an untouched one is not.
 */
export const scanForEnrichment = internalQuery({
  args: {
    tenantId: v.id("tenants"),
    cursor: v.union(v.string(), v.null()),
    model: v.string(),
    pageSize: v.optional(v.number()),
    batchSize: v.optional(v.number()),
  },
  returns: v.object({
    staleIds: v.array(v.id("products")),
    /** Stale in THIS page that the batch bound left behind. Counted, not guessed. */
    remainingInPage: v.number(),
    scanned: v.number(),
    cursor: v.union(v.string(), v.null()),
    /** True when this page was the last one in the catalog. */
    pageIsLast: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const batchSize = args.batchSize ?? ENRICH_BATCH;
    const page = await ctx.db
      .query("products")
      .withIndex("by_tenant", (q) => q.eq("tenantId", args.tenantId))
      .paginate({ cursor: args.cursor, numItems: args.pageSize ?? SCAN_PAGE });

    const stale: Id<"products">[] = [];
    for (const product of page.page) {
      const expected = enrichmentCacheKey({
        title: product.title,
        description: product.description,
        tags: product.tags,
        images: product.images,
        schemaVersion: PROFILE_SCHEMA_VERSION,
        promptVersion: PROMPT_VERSIONS.productProfile,
        model: args.model,
      });
      const profile = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", args.tenantId).eq("productId", product._id),
        )
        .unique();

      if (!profile || profile.cacheKey !== expected) stale.push(product._id);
    }

    // The whole page is examined before the batch bound is applied, so
    // `remainingInPage` is a count of what was actually seen rather than
    // an inference from a second probe. That number is what tells the
    // caller whether to stay on this page or move to the next, and it is
    // the reason a page is never advanced past unexamined products.
    return {
      staleIds: stale.slice(0, batchSize),
      remainingInPage: Math.max(0, stale.length - batchSize),
      scanned: page.page.length,
      cursor: page.continueCursor,
      pageIsLast: page.isDone,
    };
  },
});

/** Where this tenant's sweep has got to. */
export const sweepState = internalQuery({
  args: { tenantId: v.id("tenants") },
  returns: v.union(
    v.null(),
    v.object({
      cursor: v.union(v.string(), v.null()),
      sweepEnriched: v.number(),
      sweep: v.number(),
    }),
  ),
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;
    return {
      cursor: tenant.enrichmentCursor ?? null,
      sweepEnriched: tenant.enrichmentSweepEnriched ?? 0,
      sweep: tenant.enrichmentSweep ?? 0,
    };
  },
});

/**
 * Record what a window did, and schedule whatever comes next.
 *
 * One mutation, because the cursor advance and the next window's enqueue
 * must commit together. Convex schedules transactionally, so a sweep can
 * never be left with an advanced cursor and nothing coming — which is
 * indistinguishable from a sweep that finished, and would strand the rest
 * of the catalog until the next safety-net run.
 */
export const completeEnrichmentWindow = internalMutation({
  args: {
    tenantId: v.id("tenants"),
    enriched: v.number(),
    remainingInPage: v.number(),
    nextCursor: v.union(v.string(), v.null()),
    pageIsLast: v.boolean(),
  },
  returns: v.object({
    sweepComplete: v.boolean(),
    heldPage: v.boolean(),
    sweepEnriched: v.number(),
  }),
  handler: async (ctx, args) => {
    const tenant = await ctx.db.get(args.tenantId);
    if (!tenant) {
      return { sweepComplete: true, heldPage: false, sweepEnriched: 0 };
    }

    const sweepEnriched = (tenant.enrichmentSweepEnriched ?? 0) + args.enriched;

    // STAY ON THIS PAGE ONLY WHILE STILL MAKING PROGRESS THROUGH IT.
    //
    // A page can hold more stale products than one run may enrich, and
    // advancing past them would skip them for the rest of the sweep. But
    // holding a page unconditionally is how a page of permanently-failing
    // products becomes an infinite loop, so the hold is conditional on
    // this run having enriched something. A product that keeps failing is
    // left stale and picked up by the next sweep — forward progress
    // beats retrying the same failure forever, and the job's own retry
    // policy is the mechanism for genuine transient failure.
    const heldPage = args.remainingInPage > 0 && args.enriched > 0;
    const sweepComplete = !heldPage && args.pageIsLast;

    await ctx.db.patch(args.tenantId, {
      // A completed sweep resets to the beginning. Patching to
      // `undefined` removes the field, and an absent cursor is what
      // `scanForEnrichment` reads as "start at the first product".
      enrichmentCursor: sweepComplete
        ? undefined
        : heldPage
          ? tenant.enrichmentCursor
          : (args.nextCursor ?? undefined),
      enrichmentSweepEnriched: sweepComplete ? 0 : sweepEnriched,
      // Advanced on completion so the next sweep's keys cannot collide
      // with this one's. See `enrichmentKey`.
      ...(sweepComplete
        ? { enrichmentSweep: (tenant.enrichmentSweep ?? 0) + 1 }
        : {}),
      updatedAt: Date.now(),
    });

    if (!sweepComplete) {
      // The chain. The key derives from the cursor and the sweep's
      // enriched count, both of which this mutation has just advanced, so
      // the next window is a different piece of logical work while two
      // concurrent triggers for the SAME position still collapse to one.
      await ctx.runMutation(internal.scheduling.enqueueEnrichment, {
        tenantId: args.tenantId,
        delayMs: ENRICHMENT_WINDOW_DELAY_MS,
      });
      return { sweepComplete, heldPage, sweepEnriched };
    }

    // Sweep finished. A Brand Brain build is worth scheduling only if
    // this sweep actually changed what the brain is derived from, or if
    // there is no brain yet. The build itself re-checks with a
    // fingerprint, so this gate is an optimisation rather than the
    // correctness boundary — it exists so an unchanged catalog does not
    // create a job row every six hours to discover it has nothing to do.
    const current = await ctx.db
      .query("brandBrains")
      .withIndex("by_tenant_current", (q) =>
        q.eq("tenantId", args.tenantId).eq("isCurrent", true),
      )
      .unique();

    if (sweepEnriched > 0 || !current) {
      await ctx.runMutation(internal.scheduling.enqueueBrandBuild, {
        tenantId: args.tenantId,
      });
    }
    return { sweepComplete, heldPage, sweepEnriched };
  },
});

/** Pace between windows. Long enough not to hammer the model provider. */
const ENRICHMENT_WINDOW_DELAY_MS = 1000;

/**
 * One enrichment window, as a durable job.
 *
 * Before P2.2 this was a raw `ctx.scheduler.runAfter` chain with no job
 * row: an action that died mid-catalog left no record, nothing retried
 * it, and two triggers for the same tenant ran two concurrent drains.
 * Now it is a `product_enrichment` job like any other — claimed before it
 * runs, classified when it fails, recovered by the stale-job sweeper, and
 * deduplicated by an idempotency key.
 *
 * Bounded work per execution, resumable across executions. The window is
 * the unit precisely because a 5,000-product catalog cannot be enriched
 * inside one action's time limit, and pretending otherwise is what the
 * previous design did.
 */
export const runEnrichmentWindow = internalAction({
  args: { tenantId: v.id("tenants"), jobId: v.optional(v.id("jobs")) },
  /**
   * Reports what the window did.
   *
   * `ran: false` covers a refused claim — another execution holds this
   * job — which is a normal outcome rather than a failure. The sweep
   * state is returned rather than left to be inferred from the cursor,
   * because a null cursor means both "not started" and "just finished"
   * and callers must not have to guess which.
   */
  returns: v.object({
    ran: v.boolean(),
    enriched: v.number(),
    sweepComplete: v.boolean(),
  }),
  handler: async (ctx, { tenantId, jobId }) => {
    const outcome = await runAsJob(ctx, { tenantId, jobId }, () =>
      enrichmentWindowWork(ctx, tenantId),
    );
    if (!outcome.ran) return { ran: false, enriched: 0, sweepComplete: false };
    return { ran: true, ...outcome.result };
  },
});

/**
 * Split from the action so the executor wraps it — the same reason
 * `syncCatalogWork` is split from `syncCatalog`. A handler that catches
 * its own errors can never be retried, because nothing outside it learns
 * one happened.
 */
async function enrichmentWindowWork(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  tenantId: Id<"tenants">,
): Promise<{ enriched: number; sweepComplete: boolean }> {
  const apiKey = env("ANTHROPIC_API_KEY");
  const text = reasoningProvider(apiKey, "fast", usageSink(ctx, tenantId, "enrichment"));
  const vision = visionProvider(apiKey, usageSink(ctx, tenantId, "vision"));

  const state: { cursor: string | null; sweepEnriched: number; sweep: number } | null =
    await ctx.runQuery(internal.enrichment.sweepState, { tenantId });
  // A tenant that no longer exists is not a failure to retry.
  if (!state) return { enriched: 0, sweepComplete: true };

  const scan: {
    staleIds: Id<"products">[];
    remainingInPage: number;
    scanned: number;
    cursor: string | null;
    pageIsLast: boolean;
  } = await ctx.runQuery(internal.enrichment.scanForEnrichment, {
    tenantId,
    cursor: state.cursor,
    model: text.name,
  });

  let enriched = 0;
  if (scan.staleIds.length > 0) {
    const products: Doc<"products">[] = await ctx.runQuery(
      internal.products.listForEmbedding,
      { productIds: scan.staleIds },
    );
    for (const product of products) {
      try {
        await enrichOne(ctx, tenantId, product, text, vision);
        enriched++;
      } catch {
        // One product failing must not abandon the window. It keeps its
        // stale cache key, so the next sweep retries it.
      }
    }
  }

  const outcome: { sweepComplete: boolean } = await ctx.runMutation(
    internal.enrichment.completeEnrichmentWindow,
    {
      tenantId,
      enriched,
      remainingInPage: scan.remainingInPage,
      nextCursor: scan.cursor,
      pageIsLast: scan.pageIsLast,
    },
  );
  return { enriched, sweepComplete: outcome.sweepComplete };
}

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
