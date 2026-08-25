import { usageSink } from "./usage";
import { v } from "convex/values";
import { action, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import { Doc, Id } from "./_generated/dataModel";
import { getEmbeddingProvider } from "./lib/embeddings";
import { env } from "./lib/env";
import { emptyProfile, type FashionProfile } from "./lib/fashion-profile";
import {
  applyFollowUp,
  parseIntent,
  parseModelIntent,
  type Intent,
} from "./lib/intent";
import { blendScore, describePiece, neutralVerdict, parseVerdict } from "./lib/judge";
import {
  buildOutfits,
  DEFAULT_LIMITS,
  type Candidate,
  type Outfit,
} from "./lib/outfit";
import {
  explanationSystem,
  explanationUser,
  intentParseSystem,
  intentParseUser,
  outfitJudgeSystem,
  outfitJudgeUser,
  PROMPT_VERSIONS,
} from "./lib/prompts";
import { extractJson, reasoningProvider, type UsageSink } from "./lib/providers";
import { slotForGarment } from "./lib/taxonomy";

/**
 * The decision engine (spec §43-§61).
 *
 * The order here is the spec's, and each step is deliberately separate
 * (§45: "Never collapse these"):
 *
 *   intent      → what did the shopper actually ask for
 *   retrieval   → what could be relevant          (vector search)
 *   constraints → what is actually buyable        (deterministic)
 *   assembly    → what goes together              (deterministic)
 *   ranking     → which is strongest              (deterministic)
 *   judge       → is it actually coherent         (model, independent)
 *   diversity   → are these meaningfully different
 *   explanation → why, from real evidence
 *
 * Everything before the judge runs without a model call. That is what
 * makes §46's funnel affordable: the model only ever sees the final
 * handful, and if it is unavailable the engine still works — it just
 * loses its second opinion.
 */

const JUDGE_TOP_N = 5;

export const candidatesForOutfit = internalQuery({
  args: { tenantId: v.id("tenants"), productIds: v.array(v.id("products")) },
  handler: async (ctx, { tenantId, productIds }) => {
    const out: Array<{ product: Doc<"products">; profile: FashionProfile }> = [];
    for (const id of productIds) {
      const product = await ctx.db.get(id);
      // Belt and braces: the vector filter already scoped this, but a
      // cross-tenant row reaching an outfit would be the leak spec §9
      // forbids.
      if (!product || product.tenantId !== tenantId) continue;

      const profileRow = await ctx.db
        .query("productProfiles")
        .withIndex("by_tenant_and_product", (q) =>
          q.eq("tenantId", tenantId).eq("productId", id),
        )
        .unique();

      out.push({
        product,
        // An unenriched product still participates. Its attributes score
        // neutral rather than badly, so a catalog mid-enrichment degrades
        // gracefully instead of returning nothing.
        profile: (profileRow?.profile as FashionProfile) ?? emptyProfile(),
      });
    }
    return out;
  },
});

export const currentBrandStyle = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const brain = await ctx.db
      .query("brandBrains")
      .withIndex("by_tenant_current", (q) => q.eq("tenantId", tenantId).eq("isCurrent", true))
      .unique();
    if (!brain) return null;
    return {
      version: brain.version,
      styleVector: (brain.styleVector as Record<string, number>) ?? {},
      summary: brain.summary,
      voice: brain.voice as {
        tone: string[];
        preferredTerms: string[];
        avoidTerms: string[];
      } | null,
    };
  },
});

type OutfitResult = {
  recommendationId: string;
  workflow: string;
  outfits: Array<{
    slots: Record<string, string>;
    products: Array<{ id: string; title: string; price: number; currency: string; imageUrl: string }>;
    direction: string;
    explanation: string;
    confidence: number;
    issues: string[];
  }>;
  status: "ready" | "syncing" | "inactive" | "unknown" | "no_result";
  message?: string;
};

export const buildLook = action({
  args: {
    publicKey: v.string(),
    query: v.optional(v.string()),
    anchorProductId: v.optional(v.string()),
    sessionKey: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<OutfitResult> => {
    const startedAt = Date.now();
    const recommendationId = crypto.randomUUID();

    const tenant = await ctx.runQuery(internal.search.resolveStorefront, {
      publicKey: args.publicKey,
    });
    if (!tenant) {
      return { recommendationId, workflow: "OUTFIT", outfits: [], status: "unknown" };
    }
    if (!tenant.active) {
      return { recommendationId, workflow: "OUTFIT", outfits: [], status: "inactive" };
    }
    if (tenant.catalogStatus !== "ready") {
      return { recommendationId, workflow: "OUTFIT", outfits: [], status: "syncing" };
    }

    // 1. Intent, in the three-way order spec §38 and §40 describe.
    const priorState = args.sessionKey
      ? await ctx.runQuery(internal.session.getSession, {
          tenantId: tenant.tenantId,
          sessionKey: args.sessionKey,
        })
      : null;
    const prior = (priorState?.state as Intent | undefined) ?? null;
    const intent = await resolveIntent(
      args.query ?? "",
      prior,
      usageSink(ctx, tenant.tenantId, "intent"),
    );

    // 2. Retrieval. Cast wide — assembly needs options in every slot,
    //    and the funnel narrows from here.
    const provider = getEmbeddingProvider(
      env("OPENAI_API_KEY"),
      usageSink(ctx, tenant.tenantId, "query_embedding"),
    );
    const retrievalText = args.query?.trim()
      ? args.query
      : await anchorText(ctx, tenant.tenantId, args.anchorProductId);
    const [queryVector] = await provider.embed([retrievalText || "everyday outfit"]);

    const matches = await ctx.vectorSearch("productEmbeddings", "by_embedding", {
      vector: queryVector,
      filter: (q) => q.eq("tenantId", tenant.tenantId),
      limit: 256,
    });

    const embeddingDocs: Doc<"productEmbeddings">[] = await ctx.runQuery(
      internal.search.embeddingsByIds,
      { tenantId: tenant.tenantId, ids: matches.map((m) => m._id) },
    );
    const relevanceByProduct = new Map<Id<"products">, number>();
    const scoreByEmbedding = new Map(matches.map((m) => [m._id, m._score]));
    for (const doc of embeddingDocs) {
      const score = scoreByEmbedding.get(doc._id);
      if (score !== undefined) relevanceByProduct.set(doc.productId, score);
    }

    const enriched: Array<{ product: Doc<"products">; profile: FashionProfile }> =
      await ctx.runQuery(internal.outfits.candidatesForOutfit, {
        tenantId: tenant.tenantId,
        productIds: embeddingDocs.map((d) => d.productId),
      });

    const candidates: Candidate[] = enriched.map(({ product, profile }) => ({
      productId: product.shopifyProductId,
      title: product.title,
      price: product.price,
      currency: product.currency,
      available: product.anyVariantAvailable,
      profile,
      slot: slotForGarment(profile.garment) ?? inferSlotFromType(product.productType),
      relevance: relevanceByProduct.get(product._id) ?? 0,
    }));

    // 3-5. Constraints, assembly, ranking — all deterministic.
    const brand = await ctx.runQuery(internal.outfits.currentBrandStyle, {
      tenantId: tenant.tenantId,
    });
    const { outfits, funnel } = buildOutfits(
      candidates,
      intent,
      brand?.styleVector ?? null,
      { ...DEFAULT_LIMITS, final: Math.min(args.limit ?? DEFAULT_LIMITS.final, 5) },
    );

    if (outfits.length === 0) {
      // Spec §96: never fabricate. Say plainly that nothing strong was
      // found rather than returning weak results as if they were answers.
      await recordTrace(ctx, {
        tenantId: tenant.tenantId,
        recommendationId,
        sessionKey: args.sessionKey,
        intent,
        brandBrainVersion: brand?.version,
        candidateIds: candidates.map((c) => c.productId),
        finalIds: [],
        scores: { funnel },
        latencyMs: Date.now() - startedAt,
        fallback: "no_result",
      });
      return {
        recommendationId,
        workflow: intent.workflow,
        outfits: [],
        status: "no_result",
        message:
          "I couldn't find a strong match for everything you asked for. Try relaxing one of the constraints.",
      };
    }

    // 6. Judge — independent, and only on the shortlist.
    const judged = await judgeOutfits(
      outfits.slice(0, JUDGE_TOP_N),
      args.query ?? "",
      brand,
      usageSink(ctx, tenant.tenantId, "judge"),
    );
    judged.sort((a, b) => b.blended - a.blended);

    // 7. Explanation, from the actual evidence.
    const results = [];
    for (const { outfit, verdict } of judged) {
      results.push({
        slots: outfit.slots as Record<string, string>,
        products: outfit.pieces.map((p) => ({
          id: p.productId,
          title: p.title,
          price: p.price,
          currency: p.currency,
          imageUrl: "",
        })),
        direction: outfit.direction,
        explanation: await explain(
          outfit,
          verdict,
          args.query ?? "",
          brand,
          usageSink(ctx, tenant.tenantId, "explanation"),
        ),
        confidence: Math.min(outfit.confidence, verdict.fallback ? 1 : verdict.confidence + 0.3),
        issues: [...new Set([...outfit.issues, ...verdict.issues])],
      });
    }

    await recordTrace(ctx, {
      tenantId: tenant.tenantId,
      recommendationId,
      sessionKey: args.sessionKey,
      intent,
      brandBrainVersion: brand?.version,
      candidateIds: candidates.map((c) => c.productId),
      finalIds: results.flatMap((r) => r.products.map((p) => p.id)),
      scores: {
        funnel,
        outfits: judged.map((j) => ({
          deterministic: j.outfit.scores,
          judge: j.verdict,
          blended: j.blended,
        })),
      },
      latencyMs: Date.now() - startedAt,
    });

    if (args.sessionKey) {
      await ctx.runMutation(internal.session.saveSession, {
        tenantId: tenant.tenantId,
        sessionKey: args.sessionKey,
        state: intent,
      });
    }

    return { recommendationId, workflow: intent.workflow, outfits: results, status: "ready" };
  },
});

/**
 * Resolve what the shopper meant (spec §38, §40).
 *
 * Three paths, in this order, and the order matters:
 *
 *   1. A follow-up on an existing session. "Make it cheaper" is a
 *      transform of prior state, not a new request — re-parsing it from
 *      scratch would throw away every constraint the shopper already set.
 *   2. The deterministic parser. Obvious requests should never cost a
 *      model call.
 *   3. The reasoning model, but ONLY when the parser left meaningful
 *      residue. §38: "The deterministic path must never discard
 *      meaningful semantic residue." A phrase like "expensive-looking
 *      without looking flashy" parses to nothing useful, and silently
 *      dropping it would answer a question the shopper didn't ask.
 */
async function resolveIntent(
  query: string,
  prior: Intent | null,
  sink: UsageSink,
): Promise<Intent> {
  if (prior && query.trim()) {
    const followUp = applyFollowUp(prior, query);
    if (followUp) return followUp;
  }

  const parsed = parseIntent(query);
  if (!parsed.needsReasoning) return parsed.intent;

  const model = reasoningProvider(env("ANTHROPIC_API_KEY"), "fast", sink);
  try {
    const response = await model.complete({
      system: intentParseSystem,
      promptVersion: PROMPT_VERSIONS.intentParse,
      maxOutputTokens: 400,
      json: true,
      user: intentParseUser({ query, residue: parsed.residue }),
    });
    // The model can only *add* to what the parser established — the
    // deterministic reading of an explicit budget or colour is more
    // trustworthy than a model's re-reading of it.
    return parseModelIntent(extractJson(response.text), parsed.intent);
  } catch {
    // No model: proceed on what was parsed. A partial understanding is
    // better than refusing to answer.
    return parsed.intent;
  }
}

/** The anchor product's own text, for "style this" with no typed query. */
async function anchorText(
  ctx: { runQuery: (...a: never[]) => Promise<unknown> },
  tenantId: Id<"tenants">,
  anchorProductId: string | undefined,
): Promise<string> {
  if (!anchorProductId) return "";
  const anchor = (await (ctx.runQuery as never as (fn: unknown, args: unknown) => Promise<
    Doc<"products"> | null
  >)(internal.products.getByShopifyId, { tenantId, shopifyProductId: anchorProductId })) ?? null;
  return anchor ? `${anchor.title}. ${anchor.description}` : "";
}

/**
 * Fall back to the merchant's own product_type when the garment was
 * never established. Crude, but it is the difference between a product
 * participating in an outfit and being invisible to the engine.
 */
function inferSlotFromType(productType: string) {
  const t = productType.toLowerCase();
  if (/shoe|sneaker|boot|footwear|loafer|sandal/.test(t)) return "footwear" as const;
  if (/trouser|pant|jean|short|skirt|bottom/.test(t)) return "bottom" as const;
  if (/coat|jacket|outer|blazer/.test(t)) return "outerwear" as const;
  if (/dress|jumpsuit|suit/.test(t)) return "onepiece" as const;
  if (/shirt|top|tee|knit|sweater|hood|blouse|polo/.test(t)) return "top" as const;
  if (/bag|belt|hat|scarf|jewel|watch|accessor/.test(t)) return "accessory" as const;
  return null;
}

async function judgeOutfits(
  outfits: Outfit[],
  request: string,
  brand: { summary: string } | null,
  sink: UsageSink,
) {
  const model = reasoningProvider(env("ANTHROPIC_API_KEY"), "strong", sink);

  return await Promise.all(
    outfits.map(async (outfit) => {
      try {
        const response = await model.complete({
          system: outfitJudgeSystem,
          promptVersion: PROMPT_VERSIONS.outfitJudge,
          maxOutputTokens: 600,
          json: true,
          user: outfitJudgeUser({
            request,
            brandSummary: brand?.summary ?? "",
            pieces: outfit.pieces.map((p) => ({
              slot: p.slot ?? "piece",
              title: p.title,
              attributes: describePiece(p.profile),
            })),
          }),
        });
        const verdict = parseVerdict(extractJson(response.text));
        return { outfit, verdict, blended: blendScore(outfit.scores.final, verdict) };
      } catch {
        // A judge that fails must not remove an otherwise good outfit.
        const verdict = neutralVerdict();
        return { outfit, verdict, blended: outfit.scores.final };
      }
    }),
  );
}

/**
 * Explanation (spec §60).
 *
 * Built from the deterministic evidence, not from the products alone.
 * "Do not invent reasons" is only enforceable if the model is handed the
 * real reasons and told to use them — and if there is no model, the
 * evidence itself is already a truthful sentence.
 */
async function explain(
  outfit: Outfit,
  verdict: { issues: string[] },
  request: string,
  brand: { voice: { tone: string[]; preferredTerms: string[]; avoidTerms: string[] } | null } | null,
  sink: UsageSink,
): Promise<string> {
  const evidence = [...outfit.detail.notes];
  if (outfit.scores.brand > 0.7) evidence.push("sits comfortably inside the brand's world");
  if (evidence.length === 0) evidence.push("the pieces share a consistent register");

  const model = reasoningProvider(env("ANTHROPIC_API_KEY"), "fast", sink);
  try {
    const response = await model.complete({
      system: explanationSystem,
      promptVersion: PROMPT_VERSIONS.explanation,
      maxOutputTokens: 160,
      temperature: 0.4,
      user: explanationUser({
        request,
        pieces: outfit.pieces.map((p) => ({ slot: p.slot ?? "piece", title: p.title })),
        evidence,
        voice: brand?.voice ?? null,
      }),
    });
    const text = response.text.trim();
    if (text && text !== "{}") return text;
  } catch {
    // fall through to the deterministic sentence
  }

  // No model, or an unusable answer: the evidence is already true and
  // readable. Better a plain honest sentence than an invented one.
  return capitalise(evidence.slice(0, 2).join(", and "));
}

function capitalise(text: string): string {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) + "." : "";
}

async function recordTrace(
  ctx: { runMutation: (...a: never[]) => Promise<unknown> },
  trace: {
    tenantId: Id<"tenants">;
    recommendationId: string;
    sessionKey?: string;
    intent: Intent;
    brandBrainVersion?: number;
    candidateIds: string[];
    finalIds: string[];
    scores: unknown;
    latencyMs: number;
    fallback?: string;
  },
): Promise<void> {
  await (ctx.runMutation as never as (fn: unknown, args: unknown) => Promise<unknown>)(
    internal.analytics.recordTrace,
    {
      ...trace,
      workflow: trace.intent.workflow,
      request: { query: trace.intent.query, sessionKey: trace.sessionKey ?? null },
      versions: {
        judge: PROMPT_VERSIONS.outfitJudge,
        explanation: PROMPT_VERSIONS.explanation,
        intent: PROMPT_VERSIONS.intentParse,
      },
    },
  );
}
