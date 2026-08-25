import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Disc — Convex data model.
 *
 * Three things here are deliberate and load-bearing; the audit
 * (`Disc audit.md`) explains what went wrong without them.
 *
 * 1. TENANCY IS A FIELD, NOT A TABLE NAME. The Python prototype gave
 *    every shop its own LanceDB table, which made isolation structural
 *    but also made cross-tenant *queries* impossible and tied us to one
 *    process with local disk. Here every tenant-owned row carries
 *    `tenantId`, every index leads with it, and the vector index declares
 *    it as a filter field. A search that forgets the filter returns
 *    nothing useful rather than another brand's catalog, and
 *    `assertTenant` in `lib/tenancy.ts` is the single chokepoint.
 *
 * 2. THE TENANT KEY IS NOT THE DOMAIN. The prototype used
 *    `shop TEXT PRIMARY KEY` — a merchant changing their domain orphaned
 *    everything they owned. The Convex document id is the identity;
 *    `shopDomain` and `shopifyShopId` are attributes that may change.
 *
 * 3. THE PUBLIC KEY AND THE MERCHANT CREDENTIAL ARE DIFFERENT THINGS.
 *    `publicKey` ships in storefront HTML and identifies a tenant to the
 *    widget. It authorises reads of that shop's own catalog and nothing
 *    else. Anything a merchant does — resync, billing, settings — needs a
 *    `merchantSessions` token. In the prototype these were the same
 *    value, which meant anyone who viewed a storefront's source could
 *    trigger a catalog re-embed or open a Stripe checkout.
 */

export default defineSchema({
  tenants: defineTable({
    // Identity. shopDomain is an attribute, never the key — merchants
    // change domains and everything they own must survive it.
    shopDomain: v.string(),
    shopifyShopId: v.optional(v.string()),
    installationId: v.optional(v.string()),

    // Public, non-secret. Ships in the storefront's HTML, so it must
    // never be sufficient for a control-plane action.
    publicKey: v.string(),

    // Shopify Admin API token, encrypted at rest (see lib/crypto.ts).
    // Never returned to any client, never logged.
    accessTokenCipher: v.optional(v.string()),
    scopes: v.optional(v.string()),

    // How this tenant was connected. "shopify_oauth" is the real path;
    // "public_catalog" is the legacy self-serve route kept working
    // during migration.
    source: v.union(v.literal("shopify_oauth"), v.literal("public_catalog")),

    // Independent lifecycle states — the spec (§18, §71) wants truthful
    // per-stage progress, which a single status field cannot express.
    catalogStatus: v.union(
      v.literal("pending"),
      v.literal("syncing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    brandBrainStatus: v.union(
      v.literal("pending"),
      v.literal("building"),
      v.literal("ready"),
      v.literal("error"),
    ),
    widgetStatus: v.union(
      v.literal("inactive"),
      v.literal("previewing"),
      v.literal("live"),
    ),

    subscriptionStatus: v.string(), // stripe vocabulary: active|trialing|canceled|none
    plan: v.optional(v.string()),
    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),

    productCount: v.number(),
    lastSyncedAt: v.optional(v.number()),
    catalogError: v.optional(v.string()),

    // Brand tokens the widget renders with. The prototype implemented
    // per-merchant theming in the renderer but had nowhere to store it
    // and no way to deliver it, so every store got the same hardcoded
    // cream/serif identity. This is that missing half.
    brandTokens: v.optional(v.any()),

    // Experience controls (spec §74). Deliberately few: "Keep controls
    // high-level." A merchant should be correcting Disc, not configuring
    // fifty variables (§19).
    widgetConfig: v.optional(v.any()),

    email: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_shop_domain", ["shopDomain"])
    .index("by_public_key", ["publicKey"])
    .index("by_shopify_shop_id", ["shopifyShopId"]),

  /**
   * Merchant credentials. Separate from `publicKey` on purpose — this is
   * the bearer token, it is never rendered into a storefront, and it
   * expires.
   */
  merchantSessions: defineTable({
    tenantId: v.id("tenants"),
    tokenHash: v.string(), // sha256 — the raw token is never stored
    expiresAt: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
  })
    .index("by_token_hash", ["tokenHash"])
    .index("by_tenant", ["tenantId"]),

  /**
   * Rate-limit counters (spec §90).
   *
   * One row per tenant per rule, holding a fixed window. A sliding
   * window would need a write per request on the very path whose point
   * is to be cheap.
   */
  rateLimits: defineTable({
    key: v.string(), // "<rule>:<tenantId>"
    windowStart: v.number(),
    count: v.number(),
  }).index("by_key", ["key"]),

  /**
   * What models actually cost us (spec §79, §86).
   *
   * The gap this closes: `providers.ts` has always read `input_tokens`
   * and `output_tokens` off every response and thrown them away, so
   * "what does an AI shopping session cost" was unanswerable — and
   * every pricing tier was therefore a guess.
   *
   * ROLLED UP, NOT PER CALL. One row per tenant per day per operation
   * per model, so a tenant costs on the order of 900 rows a month rather
   * than one per model call. At the traffic this is meant to survive
   * that is the difference between a table you can aggregate and one you
   * cannot.
   *
   * RAW TOKENS, NOT JUST DOLLARS. Prices move and the rate table will be
   * wrong at some point. Keeping the token counts means a rate
   * correction re-derives history; keeping only the dollars would make
   * every past figure permanently wrong.
   */
  modelUsage: defineTable({
    tenantId: v.id("tenants"),
    /** UTC "YYYY-MM-DD". The bucket. */
    day: v.string(),
    /** One of lib/model-pricing.ts OPERATIONS. */
    operation: v.string(),
    model: v.string(),

    calls: v.number(),
    inputTokens: v.number(),
    outputTokens: v.number(),
    /** Derived from the tokens above at write time; recomputable. */
    estimatedCostUsd: v.number(),

    updatedAt: v.number(),
  })
    // "<tenantId>:<day>:<operation>:<model>" — the bucket identity.
    .index("by_key", ["tenantId", "day", "operation", "model"])
    .index("by_tenant_and_day", ["tenantId", "day"])
    .index("by_day", ["day"]),

  /**
   * OAuth CSRF state. A table rather than the prototype's in-process
   * dict: that dict was never bounded (abandoned installs accumulated
   * for the process lifetime) and it broke outright with more than one
   * worker.
   */
  oauthStates: defineTable({
    state: v.string(),
    shopDomain: v.string(),
    expiresAt: v.number(),
  }).index("by_state", ["state"]),

  /**
   * Canonical product — the SOURCE layer only (spec §26). Model
   * inference never overwrites anything here; it lives in
   * productProfiles with its own provenance.
   */
  products: defineTable({
    tenantId: v.id("tenants"),
    shopifyProductId: v.string(),

    title: v.string(),
    description: v.string(),
    handle: v.string(),
    productType: v.string(),
    vendor: v.optional(v.string()),
    tags: v.array(v.string()),

    price: v.number(),
    // Never ingested by the prototype, so every non-USD merchant showed
    // dollar prices. Required, not optional, so it cannot be skipped again.
    currency: v.string(),

    imageUrl: v.string(),
    images: v.array(v.string()),
    colour: v.string(),

    variants: v.array(
      v.object({
        id: v.string(),
        title: v.string(),
        price: v.number(),
        available: v.boolean(),
      }),
    ),
    // Denormalised so availability can be a *hard filter* at retrieval
    // time (spec §47). The prototype stored per-variant availability and
    // then never used it, so sold-out products were recommended freely.
    anyVariantAvailable: v.boolean(),

    sourceUpdatedAt: v.optional(v.string()),
    ingestedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_and_shopify_id", ["tenantId", "shopifyProductId"])
    .index("by_tenant_and_type", ["tenantId", "productType"]),

  /**
   * Embeddings live beside products rather than inside them: a product
   * row is rewritten on every catalog change, an embedding only needs
   * regenerating when the text that produced it changes, and Convex
   * caps documents at 1 MiB.
   *
   * `tenantId` is a filter field on the vector index. That is the whole
   * cross-tenant isolation guarantee (spec §9, §35) and it is tested.
   */
  productEmbeddings: defineTable({
    tenantId: v.id("tenants"),
    productId: v.id("products"),
    embedding: v.array(v.float64()),
    // What produced this vector, so a model change can invalidate
    // selectively instead of re-embedding every catalog (spec §117).
    embeddingModel: v.string(),
    contentHash: v.string(),
    createdAt: v.number(),
  })
    .index("by_tenant_and_product", ["tenantId", "productId"])
    .index("by_product", ["productId"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["tenantId"],
    }),

  /**
   * The Disc intelligence layer (spec §26, §27).
   *
   * Separate from `products` on purpose: source facts and model
   * inference must never share a row, or a resync overwrites what was
   * inferred and an inference can silently claim to be a fact.
   *
   * `cacheKey` is what stops a product being re-analysed on every
   * request (spec §31). It folds in the content, the schema version, the
   * prompt version and the model — so changing any one of those
   * invalidates exactly the work it affects, and nothing else.
   */
  productProfiles: defineTable({
    tenantId: v.id("tenants"),
    productId: v.id("products"),

    profile: v.any(), // FashionProfile — see lib/fashion-profile.ts
    provenance: v.any(), // Record<field, Provenance>
    completeness: v.number(),

    cacheKey: v.string(),
    schemaVersion: v.string(),
    lastEnrichedAt: v.number(),
    /** Fields the model returned that failed vocabulary validation. */
    rejectedFields: v.optional(v.array(v.string())),
  })
    .index("by_tenant_and_product", ["tenantId", "productId"])
    .index("by_product", ["productId"])
    .index("by_tenant_and_cache_key", ["tenantId", "cacheKey"]),

  /**
   * Brand Brain (spec §20). Versioned rather than mutated: §138 requires
   * that a merchant's correction produces version 2 while past traces
   * continue to resolve to version 1. Overwriting would make every
   * historical recommendation unreproducible.
   */
  brandBrains: defineTable({
    tenantId: v.id("tenants"),
    version: v.number(),
    isCurrent: v.boolean(),

    styleVector: v.any(),
    palette: v.any(),
    formality: v.any(),
    productWorld: v.any(),
    voice: v.any(),
    merchandising: v.optional(v.any()),
    summary: v.string(),

    derivedFrom: v.any(), // the statistics this was computed from
    source: v.union(v.literal("derived"), v.literal("merchant_corrected")),
    confidence: v.number(),
    createdAt: v.number(),
  })
    .index("by_tenant_current", ["tenantId", "isCurrent"])
    .index("by_tenant_version", ["tenantId", "version"]),

  /**
   * Recommendation trace (spec §81).
   *
   * Written for every result, from the first one. The audit's point is
   * that this cannot be backfilled: if the versions and score components
   * aren't recorded when the recommendation happens, "why did Disc
   * recommend that?" is permanently unanswerable for everything already
   * shipped.
   */
  recommendationTraces: defineTable({
    tenantId: v.id("tenants"),
    recommendationId: v.string(),
    sessionKey: v.optional(v.string()),
    workflow: v.string(),

    request: v.any(),
    intent: v.optional(v.any()),
    brandBrainVersion: v.optional(v.number()),
    candidateIds: v.array(v.string()),
    finalIds: v.array(v.string()),
    scores: v.any(),
    judge: v.optional(v.any()),

    versions: v.any(), // prompt/model/ranker/schema versions
    fallback: v.optional(v.string()),
    latencyMs: v.number(),
    at: v.number(),
  })
    .index("by_recommendation_id", ["recommendationId"])
    .index("by_tenant_and_at", ["tenantId", "at"]),

  /**
   * Shopper session state (spec §36, §37). Structured state, NOT a
   * conversation transcript — "make it cheaper" has to be a field
   * update, not a re-read of chat history.
   */
  shopperSessions: defineTable({
    tenantId: v.id("tenants"),
    sessionKey: v.string(),
    state: v.any(), // intent-shaped: occasion, formality, budget, avoid, locked
    lastSeenAt: v.number(),
    createdAt: v.number(),
  })
    .index("by_tenant_and_key", ["tenantId", "sessionKey"])
    .index("by_last_seen", ["lastSeenAt"]),

  /**
   * Analytics events (spec §80). Written from the first request rather
   * than added later — the audit's point is that traces cannot be
   * backfilled, so the spine goes in before the decision engine that
   * will populate it.
   */
  events: defineTable({
    tenantId: v.id("tenants"),
    sessionKey: v.optional(v.string()),
    type: v.string(),
    recommendationId: v.optional(v.string()),
    productIds: v.optional(v.array(v.string())),
    payload: v.optional(v.any()),
    at: v.number(),
  })
    .index("by_tenant_and_at", ["tenantId", "at"])
    .index("by_tenant_and_type", ["tenantId", "type"])
    .index("by_recommendation", ["recommendationId"]),
});
