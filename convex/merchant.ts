import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { Doc } from "./_generated/dataModel";
import { billingEnabled } from "./lib/env";
import { isActive } from "./lib/tenancy";
import { defaultWidgetConfig, parseWidgetConfig } from "./lib/widget-config";

/**
 * The merchant control plane (spec §70-§75).
 *
 * Everything here is behind a merchant session token — the HTTP layer
 * resolves the bearer token to a tenantId before any of these run, which
 * is the boundary the prototype did not have. None of it is reachable
 * with the public key that ships in storefront HTML.
 *
 * Two things shape what these return. §75: "Do not present 'messages
 * processed' as the main value metric" — a merchant is buying commercial
 * outcomes, not AI call volume. And §18: "Do not fake progress. Progress
 * events should come from real job state." Every status below is read
 * from the row the job actually wrote.
 */

/**
 * Onboarding stages (spec §18), derived rather than stored.
 *
 * Deriving them means they cannot drift from reality: there is no
 * separate progress field for a job to forget to update. A stage is
 * complete when the thing it describes is actually true.
 */
function onboardingStages(tenant: Doc<"tenants">, hasProfiles: boolean) {
  const catalogReady = tenant.catalogStatus === "ready";
  return [
    {
      key: "connected",
      label: "Connected to Shopify",
      // Nothing else can have happened without this.
      done: true,
      failed: false,
    },
    {
      key: "catalog",
      label: "Reading your catalog",
      done: catalogReady,
      failed: tenant.catalogStatus === "error",
    },
    {
      key: "products",
      label: "Understanding your products",
      done: catalogReady && hasProfiles,
      failed: false,
    },
    {
      key: "brand",
      label: "Learning your brand",
      done: tenant.brandBrainStatus === "ready",
      failed: tenant.brandBrainStatus === "error",
    },
    {
      key: "preview",
      label: "Ready to preview",
      done: tenant.brandBrainStatus === "ready" && catalogReady,
      failed: false,
    },
    {
      key: "live",
      label: "Live on your storefront",
      done: tenant.widgetStatus === "live",
      failed: false,
    },
  ];
}

/** Overview (spec §71). */
export const overview = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;

    const someProfile = await ctx.db
      .query("productProfiles")
      .withIndex("by_tenant_and_product", (q) => q.eq("tenantId", tenantId))
      .first();

    return {
      shopDomain: tenant.shopDomain,
      status: {
        catalog: tenant.catalogStatus,
        brandBrain: tenant.brandBrainStatus,
        widget: tenant.widgetStatus,
        subscription: tenant.subscriptionStatus,
        active: isActive(tenant, billingEnabled()),
      },
      productCount: tenant.productCount,
      lastSyncedAt: tenant.lastSyncedAt ?? null,
      catalogError: tenant.catalogError ?? null,
      onboarding: onboardingStages(tenant, someProfile !== null),
      // The install is not finished until Disc is actually on the
      // storefront, and an app embed starts switched off (spec §13).
      needsActivation: tenant.widgetStatus !== "live",
    };
  },
});

/**
 * Catalog health (spec §73).
 *
 * The counts a merchant needs to trust the thing: how much of their
 * catalog Disc actually understands, and what it failed on. "Enriched"
 * and "indexed" are deliberately separate — a product can be searchable
 * while Disc knows nothing about what it is, and that product will
 * participate in outfits scoring everything neutral.
 */
export const catalogHealth = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const products = await ctx.db
      .query("products")
      .withIndex("by_tenant", (q) => q.eq("tenantId", tenantId))
      .collect();

    const profiles = await ctx.db
      .query("productProfiles")
      .withIndex("by_tenant_and_product", (q) => q.eq("tenantId", tenantId))
      .collect();
    const profileByProduct = new Map(profiles.map((p) => [p.productId, p]));

    const embeddings = await ctx.db
      .query("productEmbeddings")
      .withIndex("by_tenant_and_product", (q) => q.eq("tenantId", tenantId))
      .collect();
    const embedded = new Set(embeddings.map((e) => e.productId));

    let enriched = 0;
    let lowConfidence = 0;
    let rejectedFields = 0;
    let unavailable = 0;
    let missingImages = 0;

    for (const product of products) {
      if (!product.anyVariantAvailable) unavailable++;
      if (product.images.length === 0) missingImages++;

      const profile = profileByProduct.get(product._id);
      if (!profile) continue;
      enriched++;
      // Below half the attributes established: Disc will score most
      // dimensions neutral for this product, which is worth surfacing
      // rather than hiding behind an "enriched" tick.
      if (profile.completeness < 0.5) lowConfidence++;
      if ((profile.rejectedFields?.length ?? 0) > 0) rejectedFields++;
    }

    return {
      total: products.length,
      indexed: products.filter((p) => embedded.has(p._id)).length,
      enriched,
      notEnriched: products.length - enriched,
      lowConfidence,
      rejectedFields,
      unavailable,
      missingImages,
    };
  },
});

/** Experience controls (spec §74). */
export const experience = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;
    return {
      config: parseWidgetConfig(tenant.widgetConfig ?? defaultWidgetConfig()),
      widgetStatus: tenant.widgetStatus,
      publicKey: tenant.publicKey,
    };
  },
});

export const saveExperience = internalMutation({
  args: { tenantId: v.id("tenants"), config: v.any() },
  returns: v.any(),
  handler: async (ctx, { tenantId, config }) => {
    // Validated, never stored raw: this value is rendered into a
    // storefront, so unchecked merchant input here would reach every
    // shopper's browser.
    const parsed = parseWidgetConfig(config);
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;

    await ctx.db.patch(tenantId, {
      widgetConfig: parsed,
      // Enabling is what puts Disc on the storefront; disabling takes it
      // off without uninstalling the app (spec §127).
      widgetStatus: parsed.enabled
        ? "live"
        : tenant.widgetStatus === "live"
          ? "inactive"
          : tenant.widgetStatus,
      updatedAt: Date.now(),
    });
    return parsed;
  },
});

/** Preview mode: Disc runs for the merchant without going live. */
export const setPreviewing = internalMutation({
  args: { tenantId: v.id("tenants") },
  returns: v.null(),
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant || tenant.widgetStatus === "live") return null;
    await ctx.db.patch(tenantId, { widgetStatus: "previewing", updatedAt: Date.now() });
    return null;
  },
});

/** Settings (spec §70). Deliberately thin — and never exposes a secret. */
export const settings = internalQuery({
  args: { tenantId: v.id("tenants") },
  handler: async (ctx, { tenantId }) => {
    const tenant = await ctx.db.get(tenantId);
    if (!tenant) return null;
    return {
      shopDomain: tenant.shopDomain,
      email: tenant.email ?? null,
      // The public key is safe to show: it ships in storefront HTML
      // anyway. The access token and its ciphertext never appear here.
      publicKey: tenant.publicKey,
      scopes: tenant.scopes ?? "",
      installedAt: tenant.createdAt,
      plan: tenant.plan ?? null,
      subscriptionStatus: tenant.subscriptionStatus,
      billingEnabled: billingEnabled(),
    };
  },
});
