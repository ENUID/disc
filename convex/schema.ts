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
   * Stripe event ledger (P1.5).
   *
   * A replay of a Stripe event previously re-granted access: nothing
   * recorded which events had been applied, so re-sending a
   * `checkout.session.completed` from the Stripe dashboard — a
   * one-click operation — re-entitled a cancelled merchant.
   *
   * `eventId` is the deduplication identity, on Stripe's own advice:
   * "Track event IDs to identify duplicate deliveries". Note what is
   * NOT here — no ordering timestamp. Stripe records `created` in whole
   * seconds, says distinct events can share one, and states plainly that
   * it must not be used to determine order. It is stored for audit and
   * never compared. Ordering safety comes from the state machine in
   * `lib/billing.ts` instead. See PRODUCTION_STRIPE_EVENTS.md.
   *
   * `tenantId` is optional because an event can arrive that resolves to
   * no tenant — junk metadata, or a tenant already purged. Those rows
   * are not tenant data and are aged out by retention rather than by
   * `purgeTenant`, which handles the resolved ones.
   */
  stripeEvents: defineTable({
    /** Stripe's `evt_...`. The deduplication key. */
    eventId: v.string(),
    eventType: v.string(),

    /** Resolved tenant, when the event named one that exists. */
    tenantId: v.optional(v.id("tenants")),
    /** What the metadata actually said, kept even when it resolved to nothing. */
    claimedTenantId: v.optional(v.string()),

    stripeCustomerId: v.optional(v.string()),
    stripeSubscriptionId: v.optional(v.string()),

    /**
     * applied            changed subscription state
     * ignored_unhandled  an event type Disc does not act on
     * ignored_unresolved no tenant could be safely resolved
     * ignored_stale      refused by the transition guard
     */
    outcome: v.string(),
    /** The status written, when one was. */
    appliedStatus: v.optional(v.string()),
    /** Why it was refused, for the ignored_stale case. */
    reason: v.optional(v.string()),

    /** Stripe's `event.created`. AUDIT ONLY — never used for ordering. */
    eventCreated: v.optional(v.number()),
    receivedAt: v.number(),
  })
    // Deduplication. Stripe event ids are globally unique, so unlike the
    // Shopify ledger this is not tenant-scoped — the tenant is a result
    // of processing the event, not an input to identifying it.
    .index("by_event_id", ["eventId"])
    .index("by_tenant", ["tenantId"])
    .index("by_received", ["receivedAt"]),

  /**
   * Shopify webhook delivery ledger (P1.4).
   *
   * Shopify guarantees neither once-only delivery nor ordering — a
   * `products/update` can arrive before the `products/create` it
   * followed — so a handler that simply applies what arrives will
   * re-apply work it has already done and can overwrite newer state with
   * older. This table answers the first of those two questions.
   *
   * IT DOES NOT ANSWER BOTH. Delivery identity and resource freshness are
   * separate concerns and are kept separate here:
   *
   *   webhookId          unique per delivery   -> deduplication
   *   eventId            one merchant action   -> correlation ONLY
   *   triggeredAt        when it fired         -> ordering, no version
   *   resourceUpdatedAt  the resource version  -> freshness
   *
   * `eventId` is deliberately NOT unique and deliberately NOT the dedupe
   * key: one merchant action produces deliveries to every subscribed
   * topic, and collapsing those would silently drop a topic.
   *
   * A duplicate delivery writes NO row — the row that already exists is
   * the record of it. Storing one per redelivery would make a Shopify
   * retry storm grow this table without adding information.
   *
   * This is not a second deduplication mechanism competing with job
   * idempotency. They are layered, and each catches what the other
   * cannot: the ledger stops a delivery being processed twice, the job
   * key stops the same resource version becoming two jobs by different
   * routes.
   */
  webhookDeliveries: defineTable({
    tenantId: v.id("tenants"),

    /** X-Shopify-Webhook-Id. Unique per delivery, per tenant. */
    webhookId: v.string(),
    /** X-Shopify-Event-Id. Correlation across subscriptions, never dedupe. */
    eventId: v.optional(v.string()),
    topic: v.string(),

    /** The Shopify resource this concerns, when the topic has one. */
    resourceId: v.optional(v.string()),
    /** X-Shopify-Triggered-At, epoch ms. */
    triggeredAt: v.optional(v.number()),
    /** The payload's own `updated_at`, verbatim. */
    resourceUpdatedAt: v.optional(v.string()),

    /** The single comparable event time. See lib/webhooks.ts. */
    eventAt: v.number(),
    /**
     * `eventAt` when this delivery was applied, 0 when it was not.
     *
     * The zero is what makes the freshness lookup O(1): the index below
     * is walked descending and the first row is the newest APPLIED state,
     * because unapplied rows sort below every real event time.
     */
    appliedEventAt: v.number(),

    outcome: v.string(),
    /** The durable job this delivery created, when it created one. */
    jobId: v.optional(v.id("jobs")),
    receivedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    // Deduplication. Tenant-leading for the same reason every other index
    // here is: one merchant's delivery id must not collide with another's.
    .index("by_tenant_and_webhook", ["tenantId", "webhookId"])
    // Freshness. Descending on this gives the last applied state for a
    // resource in one read.
    .index("by_tenant_and_resource", ["tenantId", "resourceId", "appliedEventAt"])
    // Retention sweeping.
    .index("by_received", ["receivedAt"]),

  /**
   * Durable job state (P1.1).
   *
   * The gap this closes: every background operation was
   * `ctx.scheduler.runAfter(...)` fire-and-forget. There was no attempt
   * count, no terminal failure state, no way to ask whether a tenant's
   * enrichment was stuck, and no way to tell a job that failed *after*
   * its writes from one that never ran. Progress was inferred from side
   * effects, which works until you need to know why something stopped.
   *
   * THIS TABLE IS NOT A QUEUE. Convex's scheduler decides when work
   * runs; a row here records what state that work is in. Nothing polls
   * it looking for things to execute — a sweeper doing that would race
   * the scheduler for the same job and rebuild, worse, a component the
   * platform already provides.
   *
   * `idempotencyKey` is deliberately not the document id. The id is this
   * execution record; the key is the logical piece of work. Two
   * deliveries of one Shopify webhook are two invocations of one logical
   * job, and must resolve to one row — that is what the webhook phase
   * will depend on.
   *
   * `payload` was deliberately absent in P1.1, on the reasoning that a
   * job's authoritative input lives in the domain tables it operates on.
   * That is true of `catalog_sync`, whose only input is the tenant, and
   * false of `product_embedding`: its input is a Shopify product id that
   * may not correspond to any row yet (a `products/create` webhook for a
   * product Disc has never seen). Retry has to re-schedule the same
   * worker with the same arguments, and the stale-job sweeper has to do
   * it for a job whose action died, so the arguments have to be on the
   * row. The shape is a CLOSED object rather than `v.any()` — that is
   * what stops it becoming a general side-channel, and it means a
   * credential cannot be put here without a visible schema edit.
   */
  jobs: defineTable({
    tenantId: v.id("tenants"),
    type: v.string(),

    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("succeeded"),
      v.literal("retrying"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),

    idempotencyKey: v.string(),

    attempt: v.number(),
    maxAttempts: v.number(),

    /** Worker arguments. Closed shape — never credentials. See above. */
    payload: v.optional(
      v.object({
        shopifyProductId: v.optional(v.string()),
      }),
    ),

    scheduledAt: v.optional(v.number()),
    startedAt: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    /** When the next attempt is scheduled for. Written on every retry. */
    nextAttemptAt: v.optional(v.number()),
    /** When the most recent attempt failed — retryable or not. */
    failedAt: v.optional(v.number()),

    progress: v.optional(v.any()),
    lastError: v.optional(v.string()),
    /** Classification of the most recent failure. See lib/retry.ts. */
    errorClass: v.optional(v.string()),
    /** Whether that failure was judged worth repeating. */
    retryable: v.optional(v.boolean()),

    /**
     * One entry per failed attempt, so "why did this run three times" is
     * answerable from the row rather than from log archaeology. Bounded
     * in `lib/jobs.ts` — an attempt ceiling keeps it small, and the cap
     * means a pathological `maxAttempts` still cannot grow a document
     * past its limit.
     */
    attempts: v.optional(
      v.array(
        v.object({
          attempt: v.number(),
          at: v.number(),
          errorClass: v.string(),
          message: v.string(),
          retryable: v.boolean(),
        }),
      ),
    ),

    /**
     * The failed job this one was created to re-run.
     *
     * Set only by an explicit manual retry. It is what makes the history
     * of a piece of work followable across the terminal boundary that
     * `failed` deliberately imposes: the old row keeps every attempt it
     * made, and this points back at it rather than overwriting it.
     */
    supersedes: v.optional(v.id("jobs")),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    // Uniqueness of a logical job, per tenant. Leading with tenantId is
    // what stops one merchant's key colliding with another's.
    .index("by_tenant_and_idempotency", ["tenantId", "idempotencyKey"])
    // Operator visibility: "what is stuck right now", across tenants.
    .index("by_status", ["status"])
    .index("by_tenant_and_status", ["tenantId", "status"]),

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
   * Looks — the merchant's own styling, taught to Disc.
   *
   * A brand already has campaign imagery, lookbooks and editorial shots
   * in which someone decided these particular pieces belong together.
   * That decision is the most valuable styling signal there is, and
   * until now Disc could not see it: it inferred compatibility from
   * product attributes and never learned that this shirt and these
   * trousers were deliberately photographed as one outfit.
   *
   * DETECTED AND CONFIRMED ARE SEPARATE FIELDS, for the same reason
   * `products` and `productProfiles` are separate tables. `detected` is
   * what the vision model saw in the image. `items` is what the merchant
   * confirmed it maps to. Merging them would let a re-analysis silently
   * overwrite a merchant's decision, and would make "did a human approve
   * this?" unanswerable — which is exactly the question that makes an
   * approved look worth more than an inferred one.
   *
   * A look only influences recommendations once `status` is "approved".
   * Detection is a suggestion, never an assertion.
   */
  looks: defineTable({
    tenantId: v.id("tenants"),
    title: v.string(),

    // "uploaded" — merchant supplied an image and mapped it.
    // "merchant_built" — assembled by hand in the dashboard, no image.
    source: v.union(v.literal("uploaded"), v.literal("merchant_built")),
    /** Convex file storage. Absent for a hand-built look. */
    imageStorageId: v.optional(v.id("_storage")),

    /**
     * Raw vision output. Provenance, never merged into `items`, and kept
     * so a look can be re-mapped without paying for the image again.
     */
    detected: v.optional(v.any()),

    /** What the merchant confirmed each detected garment maps to. */
    items: v.array(
      v.object({
        productId: v.id("products"),
        slot: v.string(),
        /** What the model called it, for showing the merchant its work. */
        detectedLabel: v.optional(v.string()),
        /** Model's confidence in the *suggestion*, not in the confirmation. */
        confidence: v.optional(v.number()),
      }),
    ),

    // Derived from the confirmed items, merchant-overridable. Stored
    // rather than computed so a look stays what the merchant said it was
    // even after its products are re-enriched.
    occasion: v.optional(v.string()),
    style: v.optional(v.string()),
    formality: v.optional(v.number()),
    season: v.optional(v.string()),
    notes: v.optional(v.string()),

    status: v.union(
      v.literal("draft"),
      v.literal("approved"),
      v.literal("archived"),
    ),

    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_tenant", ["tenantId"])
    .index("by_tenant_and_status", ["tenantId", "status"]),

  /**
   * The outfit graph (§7 of the product brief).
   *
   * One row per unordered product pair that appeared together in an
   * approved look. Denormalised out of `looks` rather than derived per
   * request: ranking needs "is this pair known-good?" for every
   * candidate combination, and re-deriving it from every look on every
   * request would put the whole library in the hot path.
   *
   * `productA` is always the lexicographically smaller id, so a pair has
   * exactly one row rather than two — otherwise the same relationship
   * would be counted twice in scoring.
   *
   * IMPORTANT: this is *additive evidence*, never a requirement. A
   * tenant with no looks has no edges, contributes no bonus, and gets
   * exactly the recommendations they get today. See `affinityBonus` in
   * lib/looks.ts.
   */
  lookEdges: defineTable({
    tenantId: v.id("tenants"),
    productA: v.id("products"),
    productB: v.id("products"),
    /** How many approved looks contain this pair. More looks, more confident. */
    weight: v.number(),
    lookIds: v.array(v.id("looks")),
    updatedAt: v.number(),
  })
    .index("by_tenant_and_pair", ["tenantId", "productA", "productB"])
    // Fetches every edge touching one product, which is what scoring needs.
    .index("by_tenant_and_a", ["tenantId", "productA"])
    .index("by_tenant_and_b", ["tenantId", "productB"]),

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
